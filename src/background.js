/* global chrome, browser, importScripts, QuietMarks */
(function () {
  "use strict";

  importScripts(
    "core/constants.js",
    "core/utils.js",
    "core/state-model.js",
    "core/crypto-codec.js",
    "platform/extension-api.js",
    "storage/sync-state-store.js",
    "remote/webdav-store.js",
    "bookmarks/bookmark-adapter.js",
    "sync/merge-engine.js",
    "sync/sync-service.js"
  );

  const globalApi = typeof browser !== "undefined" ? browser : chrome;
  const {
    CHANGE_DEBOUNCE_MS,
    SYNC_ALARM
  } = QuietMarks.Constants;

  let applyDepth = 0;
  let debounceTimer = null;

  const extensionApi = new QuietMarks.ExtensionApi(globalApi);
  const stateStore = new QuietMarks.SyncStateStore(extensionApi);
  const bookmarkAdapter = new QuietMarks.BookmarkAdapter(extensionApi, {
    onApplyStart() {
      applyDepth += 1;
    },
    onApplyEnd() {
      applyDepth -= 1;
    }
  });
  const syncService = new QuietMarks.SyncService({
    stateStore,
    bookmarkAdapter,
    remoteStore: new QuietMarks.WebDavStore(new QuietMarks.CryptoCodec()),
    mergeEngine: new QuietMarks.MergeEngine()
  });

  async function resetAlarm() {
    const { config } = await stateStore.get();
    await extensionApi.clearAlarm(SYNC_ALARM).catch(() => {});
    if (config.enabled) {
      extensionApi.createAlarm(SYNC_ALARM, {
        periodInMinutes: Math.max(2, Number(config.intervalMinutes || 10))
      });
    }
  }

  function queueChangeSync() {
    if (applyDepth > 0) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      syncService.run("bookmark-change");
    }, CHANGE_DEBOUNCE_MS);
  }

  if (globalApi.bookmarks && globalApi.bookmarks.onCreated) {
    globalApi.bookmarks.onCreated.addListener(queueChangeSync);
    globalApi.bookmarks.onChanged.addListener(queueChangeSync);
    globalApi.bookmarks.onMoved.addListener(queueChangeSync);
    globalApi.bookmarks.onRemoved.addListener(queueChangeSync);
    if (globalApi.bookmarks.onChildrenReordered) {
      globalApi.bookmarks.onChildrenReordered.addListener(queueChangeSync);
    }
  }

  if (globalApi.alarms && globalApi.alarms.onAlarm) {
    globalApi.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === SYNC_ALARM) {
        syncService.run("alarm");
      }
    });
  }

  if (globalApi.runtime && globalApi.runtime.onInstalled) {
    globalApi.runtime.onInstalled.addListener(() => {
      resetAlarm();
    });
  }

  if (globalApi.runtime && globalApi.runtime.onStartup) {
    globalApi.runtime.onStartup.addListener(() => {
      resetAlarm();
      syncService.run("startup");
    });
  }

  if (globalApi.runtime && globalApi.runtime.onMessage) {
    globalApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      (async () => {
        if (!message || !message.type) return null;

        if (message.type === "quietmarks:get") {
          const stored = await stateStore.get();
          let config = stored.config;
          const sync = syncService.runtimeStatus();
          if (config.lastSyncStatus === "Syncing" && !sync.inFlight) {
            config = await syncService.saveStatus(
              config,
              "Error",
              "Previous sync was interrupted. Start sync again.",
              config.lastStats
            );
          }
          return {
            config,
            baseNodeCount: Object.keys(stored.baseState.nodes || {}).length,
            sync
          };
        }

        if (message.type === "quietmarks:save") {
          const config = await syncService.saveConfigPatch(message.config || {});
          await resetAlarm();
          return {
            ok: true,
            config
          };
        }

        if (message.type === "quietmarks:sync-now") {
          return syncService.start("manual");
        }

        if (message.type === "quietmarks:test-webdav") {
          return syncService.testWebDav(message.config || {});
        }

        if (message.type === "quietmarks:reset-local-base") {
          const stored = await stateStore.get();
          await stateStore.resetLocalBase(stored.config.clientId);
          return {
            ok: true
          };
        }

        return null;
      })()
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({
          ok: false,
          error: error.message || String(error)
        }));
      return true;
    });
  }
})();
