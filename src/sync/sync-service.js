(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};
  const { DEFAULT_CONFIG, SYNC_PHASE_TIMEOUT_MS, WEBDAV_TIMEOUT_MS, WEBDAV_PUT_TIMEOUT_MS, WEBDAV_FETCH_STALL_MS } = QuietMarks.Constants;
  const { nowIso, randomId } = QuietMarks.Utils;
  const { cleanRemoteFile } = QuietMarks.StateModel;
  const SCAN_PROGRESS_THROTTLE_MS = 900;

  class SyncService {
    constructor(deps) {
      this.stateStore = deps.stateStore;
      this.bookmarkAdapter = deps.bookmarkAdapter;
      this.remoteStore = deps.remoteStore;
      this.mergeEngine = deps.mergeEngine;
      this.onKeepAliveStart = deps.onKeepAliveStart || (async () => {});
      this.onKeepAliveStop = deps.onKeepAliveStop || (async () => {});
      this.syncInFlight = false;
      this.pendingSync = false;
      this.activeSync = null;
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
      const nextConfig = await this.saveStatus(config, "Syncing", phase, config.lastStats);
      await this.updateJob({
        status: "running",
        phase,
        error: ""
      });
      return nextConfig;
    }

    createJob(reason) {
      const at = nowIso();
      return {
        id: `sync-${randomId()}`,
        status: "running",
        reason: reason || "manual",
        phase: "Starting sync...",
        startedAt: at,
        updatedAt: at,
        finishedAt: "",
        error: ""
      };
    }

    async persistJob(job) {
      if (this.stateStore.saveJob) {
        await this.stateStore.saveJob(job);
      }
    }

    async updateJob(patch) {
      if (!this.activeSync) return null;
      const updatedAt = nowIso();
      const nextJob = {
        ...this.activeSync,
        ...patch,
        updatedAt
      };
      if (nextJob.status && nextJob.status !== "running" && !nextJob.finishedAt) {
        nextJob.finishedAt = updatedAt;
      }
      this.activeSync = nextJob;
      await this.persistJob(nextJob);
      return nextJob;
    }

    async beginSync(reason) {
      this.syncInFlight = true;
      this.pendingSync = false;
      this.activeSync = this.createJob(reason);
      await this.persistJob(this.activeSync);
      return this.activeSync;
    }

    runtimeStatus(persistedJob) {
      const persistedRunning = Boolean(persistedJob && persistedJob.status === "running");
      return {
        inFlight: this.syncInFlight || persistedRunning,
        pending: this.pendingSync,
        active: this.activeSync || (persistedRunning ? persistedJob : null),
        recoverable: Boolean(persistedRunning && !this.syncInFlight)
      };
    }

    jobTimestamp(job) {
      return Date.parse((job && (job.updatedAt || job.startedAt)) || "") || 0;
    }

    isFetchPhase(job) {
      const phase = String((job && job.phase) || "").toLowerCase();
      return phase.includes("fetching webdav sync state") ||
        phase.includes("webdav get") ||
        phase.includes("webdav fetch") ||
        phase.includes("sending request") ||
        phase.includes("reading response body");
    }

    isFetchJobStalled(job) {
      if (!job || job.status !== "running" || !this.isFetchPhase(job)) return false;
      const timestamp = this.jobTimestamp(job);
      return Boolean(timestamp && Date.now() - timestamp > WEBDAV_FETCH_STALL_MS);
    }

    async markFetchJobStalled(config, job) {
      const phase = job && job.phase ? job.phase : "Fetching WebDAV sync state";
      const message = `${phase} did not finish after ${Math.round(WEBDAV_FETCH_STALL_MS / 1000)} seconds. QuietMarks stopped this sync instead of leaving it stuck. Press Sync now to retry; if it repeats, the WebDAV state file may be too large or the server may be holding the GET request open.`;
      const failedJob = {
        ...(job || this.createJob("stalled")),
        status: "error",
        phase: "Sync stalled",
        updatedAt: nowIso(),
        finishedAt: nowIso(),
        error: message
      };
      this.syncInFlight = false;
      this.pendingSync = false;
      this.activeSync = null;
      await this.persistJob(failedJob);
      await this.saveStatus(config, "Error", message, config.lastStats);
      return {
        resumed: false,
        updated: true,
        sync: this.runtimeStatus(failedJob)
      };
    }

    alreadyRunningResponse(persistedJob) {
      this.pendingSync = true;
      return {
        ok: false,
        queued: true,
        error: "A sync is already running. Wait for it to finish, then try again.",
        sync: this.runtimeStatus(persistedJob)
      };
    }

    async start(reason) {
      if (this.syncInFlight) {
        return this.alreadyRunningResponse();
      }

      const job = await this.beginSync(reason);
      this.executeSync(reason, job).catch(() => {});
      return {
        ok: true,
        started: true,
        sync: this.runtimeStatus(job)
      };
    }

    async resumeIfNeeded(stored) {
      const config = stored && stored.config ? stored.config : {};
      const job = stored && stored.syncJob ? stored.syncJob : null;
      const activeJob = this.activeSync || job;
      if (this.isFetchJobStalled(activeJob)) {
        return this.markFetchJobStalled(config, activeJob);
      }

      const hasRunningJob = Boolean(job && job.status === "running");
      const hasLegacySyncingStatus = config.lastSyncStatus === "Syncing" && !hasRunningJob;
      const oldError = String(config.lastSyncError || "").toLowerCase();
      const hasLegacyInterruptedError = config.lastSyncStatus === "Error" &&
        oldError.includes("previous sync") &&
        oldError.includes("start sync again");
      if (this.syncInFlight || (!hasRunningJob && !hasLegacySyncingStatus && !hasLegacyInterruptedError)) {
        return {
          resumed: false,
          sync: this.runtimeStatus(job)
        };
      }

      const started = await this.start("resume");
      return {
        resumed: Boolean(started && started.ok),
        sync: started.sync || this.runtimeStatus(job)
      };
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

    async resetSyncJob() {
      const stored = await this.stateStore.get();
      this.syncInFlight = false;
      this.pendingSync = false;
      this.activeSync = null;
      await this.persistJob(null);
      const status = stored.config && stored.config.webdavUrl ? "Ready" : "Not configured";
      const config = await this.saveStatus(
        stored.config,
        status,
        "Stuck sync state cleared. Press Sync now to retry.",
        stored.config.lastStats
      );
      return {
        ok: true,
        config,
        sync: this.runtimeStatus(null)
      };
    }

    activeNodeCount(state) {
      return Object.values(state.nodes || {}).filter((node) => node && node.type !== "root" && !node.deleted).length;
    }

    formatMs(ms) {
      const value = Number(ms || 0);
      if (value < 1000) return `${value}ms`;
      return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
    }

    scanProgressMessage(label, details) {
      const verifying = /verifying/i.test(label);
      const remoteActive = Number(details.remoteNodes || 0);
      const remoteTotal = Number(details.remoteTotalNodes || 0);
      if (details.stage === "index-remote") {
        return verifying
          ? `Preparing verification index (${remoteActive} active / ${remoteTotal} total nodes)...`
          : `Indexing WebDAV bookmark state (${remoteActive} active / ${remoteTotal} total nodes)...`;
      }
      if (details.stage === "read-tree") {
        return verifying ? "Verifying browser bookmark tree..." : "Reading browser bookmark tree...";
      }
      if (details.stage === "map-local") {
        const roots = Number(details.containers || 0);
        return verifying
          ? `Verifying browser bookmarks from ${roots} root(s)...`
          : `Mapping browser bookmarks from ${roots} root(s)...`;
      }
      if (details.stage === "check-deleted") {
        return verifying
          ? `Checking verification result against ${Number(details.baseNodes || 0)} expected item(s)...`
          : `Checking deleted bookmarks against ${Number(details.baseNodes || 0)} synced item(s)...`;
      }
      return label;
    }

    async scanLocalWithProgress(config, label, baseState, remoteState, idToGuid, guidToId) {
      let nextConfig = config;
      let lastSavedAt = 0;
      const result = await this.withTimeout(
        this.bookmarkAdapter.scanLocal(
          config,
          baseState,
          remoteState,
          idToGuid,
          guidToId,
          {
            onProgress: async (details) => {
              const now = Date.now();
              if (!details.force && now - lastSavedAt < SCAN_PROGRESS_THROTTLE_MS) return;
              lastSavedAt = now;
              nextConfig = await this.saveProgress(nextConfig, this.scanProgressMessage(label, details));
            }
          }
        ),
        label,
        SYNC_PHASE_TIMEOUT_MS
      );

      return {
        config: nextConfig,
        scanned: result
      };
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
        return this.alreadyRunningResponse();
      }

      const job = await this.beginSync(reason);
      return this.executeSync(reason, job);
    }

    async executeSync(reason) {
      let currentConfig = null;
      try {
        const stored = await this.stateStore.get();
        currentConfig = stored.config;

        if (!currentConfig.enabled && reason !== "manual" && reason !== "resume") {
          await this.updateJob({
            status: "done",
            phase: "Skipped because automatic sync is off.",
            error: ""
          });
          return {
            ok: false,
            skipped: true
          };
        }

        currentConfig = this.validateSyncConfig(currentConfig);
        await this.onKeepAliveStart().catch(() => {});
        currentConfig = await this.saveProgress(currentConfig, `Fetching WebDAV sync state (GET, ${Math.round(WEBDAV_TIMEOUT_MS / 1000)}s timeout)...`);

        let webdavGetMs = 0;
        const webdavGetStartedAt = Date.now();
        let remoteBundle = await this.withTimeout(
          this.remoteStore.fetchState(currentConfig),
          "Fetching WebDAV sync state",
          WEBDAV_TIMEOUT_MS + 5000
        );
        webdavGetMs = Date.now() - webdavGetStartedAt;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const latest = await this.stateStore.get();
          const scanResult = await this.scanLocalWithProgress(
            currentConfig,
            "Reading browser bookmarks",
            latest.baseState,
            remoteBundle.state,
            latest.idToGuid,
            latest.guidToId
          );
          currentConfig = scanResult.config;
          const scanned = scanResult.scanned;
          currentConfig = await this.saveProgress(
            currentConfig,
            `Merging ${this.activeNodeCount(scanned.state)} local and ${this.activeNodeCount(remoteBundle.state)} WebDAV bookmark items...`
          );
          const merged = this.resolveMergedState(currentConfig, latest.baseState, scanned.state, remoteBundle.state);
          currentConfig = await this.saveProgress(
            currentConfig,
            `Applying ${this.activeNodeCount(merged.state)} merged bookmark items to this browser...`
          );
          const applyStartedAt = Date.now();
          const appliedMappings = await this.withTimeout(
            this.bookmarkAdapter.applyStateToLocal(
              currentConfig,
              merged.state,
              scanned.guidToId,
              scanned.idToGuid,
              scanned.state
            ),
            "Applying merged bookmarks",
            SYNC_PHASE_TIMEOUT_MS
          );
          const applyMs = Date.now() - applyStartedAt;
          if (this.stateStore.saveMappings) {
            currentConfig = await this.saveProgress(currentConfig, "Saving bookmark ID mappings...");
            await this.stateStore.saveMappings(appliedMappings.idToGuid, appliedMappings.guidToId);
          }
          const verifyResult = await this.scanLocalWithProgress(
            currentConfig,
            "Verifying browser bookmarks",
            merged.state,
            merged.state,
            appliedMappings.idToGuid,
            appliedMappings.guidToId
          );
          currentConfig = verifyResult.config;
          const verified = verifyResult.scanned;
          const verificationStats = this.verifyAppliedState(merged.state, verified.state);
          currentConfig = await this.saveProgress(currentConfig, "Writing merged state to WebDAV...");

          try {
            const webdavPutStartedAt = Date.now();
            await this.withTimeout(
              this.remoteStore.putState(currentConfig, merged.state, remoteBundle.etag, remoteBundle.exists),
              "Writing WebDAV sync state",
              WEBDAV_PUT_TIMEOUT_MS + WEBDAV_TIMEOUT_MS + 10000
            );
            const webdavPutMs = Date.now() - webdavPutStartedAt;
            const stats = {
              localNodes: this.activeNodeCount(scanned.state),
              remoteNodes: this.activeNodeCount(remoteBundle.state),
              mergedNodes: this.activeNodeCount(merged.state),
              appliedNodes: verificationStats.verifiedNodes,
              missingAfterApply: verificationStats.missingAfterApply,
              conflicts: merged.conflicts.length,
              webdavGetMs,
              scanMs: scanned.diagnostics && scanned.diagnostics.scanMs,
              scanRemoteIndexMs: scanned.diagnostics && scanned.diagnostics.remoteIndexMs,
              scanReadTreeMs: scanned.diagnostics && scanned.diagnostics.readTreeMs,
              scanMapMs: scanned.diagnostics && scanned.diagnostics.mapMs,
              scanTombstoneMs: scanned.diagnostics && scanned.diagnostics.tombstoneMs,
              verifyScanMs: verified.diagnostics && verified.diagnostics.scanMs,
              applyMs,
              webdavPutMs,
              remoteTotalNodes: scanned.diagnostics && scanned.diagnostics.remoteTotalNodes,
              mappedNodes: scanned.diagnostics && scanned.diagnostics.mappedNodes,
              tombstonedNodes: scanned.diagnostics && scanned.diagnostics.tombstonedNodes
            };
            currentConfig = await this.saveStatus(currentConfig, "Synced", "", stats);
            await this.stateStore.saveSnapshot(merged.state, appliedMappings.idToGuid, appliedMappings.guidToId);
            await this.updateJob({
              status: "done",
              phase: "Synced",
              error: ""
            });
            return {
              ok: true,
              stats
            };
          } catch (error) {
            if (!error.retryable || attempt === 2) {
              throw error;
            }
            currentConfig = await this.saveProgress(currentConfig, "WebDAV changed during sync; refetching remote state...");
            const retryFetchStartedAt = Date.now();
            remoteBundle = await this.withTimeout(
              this.remoteStore.fetchState(currentConfig),
              "Refetching WebDAV sync state",
              WEBDAV_TIMEOUT_MS + 5000
            );
            webdavGetMs += Date.now() - retryFetchStartedAt;
          }
        }
      } catch (error) {
        const message = error.message || String(error);
        if (currentConfig) {
          await this.saveStatus(currentConfig, "Error", message, currentConfig.lastStats);
        } else {
          const stored = await this.stateStore.get().catch(() => null);
          if (stored && stored.config) {
            await this.saveStatus(stored.config, "Error", message, stored.config.lastStats);
          }
        }
        await this.updateJob({
          status: "error",
          phase: "Sync failed",
          error: message
        });
        return {
          ok: false,
          error: message
        };
      } finally {
        const shouldRunQueued = this.pendingSync;
        this.syncInFlight = false;
        this.activeSync = null;
        if (shouldRunQueued) {
          setTimeout(() => {
            this.run("queued");
          }, 1000);
        } else {
          await this.onKeepAliveStop().catch(() => {});
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
