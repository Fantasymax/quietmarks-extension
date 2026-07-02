(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};
  const { DEFAULT_CONFIG, SYNC_PHASE_TIMEOUT_MS, WEBDAV_TIMEOUT_MS, WEBDAV_PUT_TIMEOUT_MS } = QuietMarks.Constants;
  const { nowIso, randomId } = QuietMarks.Utils;
  const { cleanRemoteFile } = QuietMarks.StateModel;

  class SyncService {
    constructor(deps) {
      this.stateStore = deps.stateStore;
      this.bookmarkAdapter = deps.bookmarkAdapter;
      this.remoteStore = deps.remoteStore;
      this.mergeEngine = deps.mergeEngine;
      this.syncInFlight = false;
      this.pendingSync = false;
    }

    validateConfig(config) {
      if (!config.clientId) {
        config.clientId = `client-${randomId()}`;
      }
      if (!config.deviceName) {
        config.deviceName = navigator.userAgent.includes("Firefox") ? "Firefox" : "Chromium";
      }
      config.intervalMinutes = Math.max(2, Number(config.intervalMinutes || 10));
      config.remoteFile = cleanRemoteFile(config);
      config.scope = config.scope === "folder" ? "folder" : "all";
      config.conflictPolicy = ["merge", "local", "remote"].includes(config.conflictPolicy)
        ? config.conflictPolicy
        : "merge";
      return config;
    }

    validateSyncConfig(config) {
      this.validateConfig(config);
      if (!config.webdavUrl || !/^https?:\/\//i.test(config.webdavUrl)) {
        throw new Error("Enter a valid WebDAV URL.");
      }
      const fileName = config.remoteFile.split("/").filter(Boolean).pop() || "";
      if (!/\.[^/.]+$/.test(fileName)) {
        throw new Error("Sync file path must include a file name, for example QuietMarks/state.json.");
      }
      return config;
    }

    async saveStatus(config, status, error, stats) {
      const nextConfig = {
        ...config,
        lastSyncStatus: status,
        lastSyncError: error || "",
        lastSyncAt: status === "Synced" ? nowIso() : config.lastSyncAt || "",
        lastStats: stats || config.lastStats || DEFAULT_CONFIG.lastStats
      };
      await this.stateStore.saveConfig(nextConfig);
      return nextConfig;
    }

    async saveProgress(config, phase) {
      return this.saveStatus(config, "Syncing", phase, config.lastStats);
    }

    async saveConfigPatch(patch) {
      const stored = await this.stateStore.get();
      const nextConfig = this.validateConfig({
        ...stored.config,
        ...patch,
        enabled: Boolean(patch.enabled)
      });
      await this.stateStore.saveConfig(nextConfig);
      return nextConfig;
    }

    activeNodeCount(state) {
      return Object.values(state.nodes || {}).filter((node) => node && node.type !== "root" && !node.deleted).length;
    }

    async withTimeout(promise, label, timeoutMs) {
      let timeoutId = null;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
            }, timeoutMs);
          })
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    verifyAppliedState(expectedState, verifiedState) {
      const missing = [];
      Object.values(expectedState.nodes || {}).forEach((node) => {
        if (!node || node.type === "root" || node.deleted) return;
        const actual = verifiedState.nodes && verifiedState.nodes[node.guid];
        if (!actual || actual.deleted) {
          missing.push(node);
        }
      });

      if (missing.length) {
        const examples = missing
          .slice(0, 3)
          .map((node) => node.title || node.url || node.guid)
          .join(", ");
        throw new Error(`Browser bookmark verification failed: ${missing.length} merged item(s) were not visible after apply${examples ? ` (${examples})` : ""}.`);
      }

      return {
        verifiedNodes: this.activeNodeCount(verifiedState),
        missingAfterApply: 0
      };
    }

    async run(reason) {
      if (this.syncInFlight) {
        this.pendingSync = true;
        return {
          ok: false,
          queued: true,
          error: "A sync is already running. Wait for it to finish, then try again."
        };
      }

      this.syncInFlight = true;
      this.pendingSync = false;

      let currentConfig = null;
      try {
        const stored = await this.stateStore.get();
        currentConfig = stored.config;

        if (!currentConfig.enabled && reason !== "manual") {
          return {
            ok: false,
            skipped: true
          };
        }

        currentConfig = this.validateSyncConfig(currentConfig);
        currentConfig = await this.saveProgress(currentConfig, "Fetching WebDAV sync state...");

        let remoteBundle = await this.withTimeout(
          this.remoteStore.fetchState(currentConfig),
          "Fetching WebDAV sync state",
          WEBDAV_TIMEOUT_MS + 5000
        );
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const latest = await this.stateStore.get();
          currentConfig = await this.saveProgress(currentConfig, "Reading browser bookmarks...");
          const scanned = await this.withTimeout(
            this.bookmarkAdapter.scanLocal(
              currentConfig,
              latest.baseState,
              remoteBundle.state,
              latest.idToGuid,
              latest.guidToId
            ),
            "Reading browser bookmarks",
            SYNC_PHASE_TIMEOUT_MS
          );
          currentConfig = await this.saveProgress(
            currentConfig,
            `Merging ${this.activeNodeCount(scanned.state)} local and ${this.activeNodeCount(remoteBundle.state)} WebDAV bookmark items...`
          );
          const merged = this.resolveMergedState(currentConfig, latest.baseState, scanned.state, remoteBundle.state);
          currentConfig = await this.saveProgress(
            currentConfig,
            `Applying ${this.activeNodeCount(merged.state)} merged bookmark items to this browser...`
          );
          const appliedMappings = await this.withTimeout(
            this.bookmarkAdapter.applyStateToLocal(
              currentConfig,
              merged.state,
              scanned.guidToId,
              scanned.idToGuid
            ),
            "Applying merged bookmarks",
            SYNC_PHASE_TIMEOUT_MS
          );
          currentConfig = await this.saveProgress(currentConfig, "Verifying browser bookmarks after apply...");
          const verified = await this.withTimeout(
            this.bookmarkAdapter.scanLocal(
              currentConfig,
              merged.state,
              merged.state,
              appliedMappings.idToGuid,
              appliedMappings.guidToId
            ),
            "Verifying browser bookmarks",
            SYNC_PHASE_TIMEOUT_MS
          );
          const verificationStats = this.verifyAppliedState(merged.state, verified.state);
          currentConfig = await this.saveProgress(currentConfig, "Writing merged state to WebDAV...");

          try {
            await this.withTimeout(
              this.remoteStore.putState(currentConfig, merged.state, remoteBundle.etag, remoteBundle.exists),
              "Writing WebDAV sync state",
              WEBDAV_PUT_TIMEOUT_MS + WEBDAV_TIMEOUT_MS + 10000
            );
            const stats = {
              localNodes: this.activeNodeCount(scanned.state),
              remoteNodes: this.activeNodeCount(remoteBundle.state),
              mergedNodes: this.activeNodeCount(merged.state),
              appliedNodes: verificationStats.verifiedNodes,
              missingAfterApply: verificationStats.missingAfterApply,
              conflicts: merged.conflicts.length
            };
            currentConfig = await this.saveStatus(currentConfig, "Synced", "", stats);
            await this.stateStore.saveSnapshot(merged.state, appliedMappings.idToGuid, appliedMappings.guidToId);
            return {
              ok: true,
              stats
            };
          } catch (error) {
            if (!error.retryable || attempt === 2) {
              throw error;
            }
            currentConfig = await this.saveProgress(currentConfig, "WebDAV changed during sync; refetching remote state...");
            remoteBundle = await this.withTimeout(
              this.remoteStore.fetchState(currentConfig),
              "Refetching WebDAV sync state",
              WEBDAV_TIMEOUT_MS + 5000
            );
          }
        }
      } catch (error) {
        if (currentConfig) {
          await this.saveStatus(currentConfig, "Error", error.message || String(error), currentConfig.lastStats);
        }
        return {
          ok: false,
          error: error.message || String(error)
        };
      } finally {
        this.syncInFlight = false;
        if (this.pendingSync) {
          setTimeout(() => {
            this.run("queued");
          }, 1000);
        }
      }

      return {
        ok: false,
        error: "Sync ended without a result. Try again."
      };
    }

    async testWebDav(patch) {
      const stored = await this.stateStore.get();
      const config = this.validateSyncConfig({
        ...stored.config,
        ...(patch || {})
      });
      return this.remoteStore.testConnection(config);
    }

    resolveMergedState(config, baseState, localState, remoteState) {
      if (config.conflictPolicy === "local") {
        return {
          state: {
            ...localState,
            updatedAt: nowIso(),
            lastWriter: config.clientId,
            events: (remoteState.events || []).concat([{
              type: "policy-local",
              at: nowIso()
            }]).slice(-50)
          },
          conflicts: []
        };
      }

      if (config.conflictPolicy === "remote") {
        return {
          state: {
            ...remoteState,
            updatedAt: nowIso(),
            lastWriter: config.clientId,
            events: (remoteState.events || []).concat([{
              type: "policy-remote",
              at: nowIso()
            }]).slice(-50)
          },
          conflicts: []
        };
      }

      return this.mergeEngine.mergeStates(baseState, localState, remoteState, config.clientId);
    }
  }

  QuietMarks.SyncService = SyncService;
})(globalThis);
