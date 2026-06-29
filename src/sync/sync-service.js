(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};
  const { DEFAULT_CONFIG } = QuietMarks.Constants;
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

    async run(reason) {
      if (this.syncInFlight) {
        this.pendingSync = true;
        return {
          ok: false,
          queued: true
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
        await this.saveStatus(currentConfig, "Syncing", "", currentConfig.lastStats);

        let remoteBundle = await this.remoteStore.fetchState(currentConfig);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const latest = await this.stateStore.get();
          const scanned = await this.bookmarkAdapter.scanLocal(
            currentConfig,
            latest.baseState,
            remoteBundle.state,
            latest.idToGuid,
            latest.guidToId
          );
          const merged = this.resolveMergedState(currentConfig, latest.baseState, scanned.state, remoteBundle.state);
          const appliedMappings = await this.bookmarkAdapter.applyStateToLocal(
            currentConfig,
            merged.state,
            scanned.guidToId,
            scanned.idToGuid
          );

          try {
            await this.remoteStore.putState(currentConfig, merged.state, remoteBundle.etag, remoteBundle.exists);
            const stats = {
              localNodes: Object.keys(scanned.state.nodes).length,
              remoteNodes: Object.keys(remoteBundle.state.nodes || {}).length,
              mergedNodes: Object.keys(merged.state.nodes).length,
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
            remoteBundle = await this.remoteStore.fetchState(currentConfig);
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
        ok: false
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
