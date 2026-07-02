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
  const OFFSCREEN_DOCUMENT_PATH = "src/offscreen.html";
  const {
    CHANGE_DEBOUNCE_MS,
    SYNC_ALARM
  } = QuietMarks.Constants;

  let applyDepth = 0;
  let debounceTimer = null;
  let creatingOffscreen = null;

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

  async function hasOffscreenDocument() {
    if (!globalApi.offscreen || !globalApi.runtime || !globalApi.runtime.getURL) return false;
    const offscreenUrl = globalApi.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

    if (globalApi.runtime.getContexts) {
      const contexts = await globalApi.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl]
      });
      return contexts.length > 0;
    }

    if (typeof clients !== "undefined" && clients.matchAll) {
      const matchedClients = await clients.matchAll();
      return matchedClients.some((client) => client.url === offscreenUrl);
    }

    return false;
  }

  async function ensureOffscreenKeepAlive() {
    if (!globalApi.offscreen || !globalApi.offscreen.createDocument) return false;
    if (await hasOffscreenDocument()) return true;
    if (creatingOffscreen) {
      await creatingOffscreen;
      return true;
    }

    creatingOffscreen = globalApi.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["DOM_PARSER"],
      justification: "Run hidden WebDAV fetch handling so user-started bookmark sync can continue outside the Manifest V3 service worker fetch lifetime limit."
    });

    try {
      await creatingOffscreen;
      return true;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (/Only a single offscreen document|already exists/i.test(message)) return true;
      throw new Error(`Offscreen sync helper failed to start: ${message}`);
    } finally {
      creatingOffscreen = null;
    }
  }

  function serializeHeaders(headers) {
    if (!headers) return [];
    if (typeof headers.entries === "function") return Array.from(headers.entries());
    return Object.entries(headers);
  }

  function deserializeResponseHeaders(entries) {
    const map = new Map();
    (entries || []).forEach(([name, value]) => {
      map.set(String(name).toLowerCase(), value);
    });
    return {
      get(name) {
        return map.get(String(name).toLowerCase()) || null;
      }
    };
  }

  async function offscreenFetch(url, options) {
    await ensureOffscreenKeepAlive();
    const response = await globalApi.runtime.sendMessage({
      type: "quietmarks:offscreen-fetch",
      request: {
        url,
        options: {
          method: options && options.method,
          headers: serializeHeaders(options && options.headers),
          body: options && options.body,
          cache: options && options.cache
        }
      }
    });

    if (!response || response.ok === false) {
      throw new Error(response && response.error ? response.error : "Offscreen WebDAV fetch failed.");
    }

    return {
      ok: response.fetchOk,
      status: response.status,
      headers: deserializeResponseHeaders(response.headers),
      async text() {
        return response.body || "";
      },
      async json() {
        const body = response.body || "";
        return body ? JSON.parse(body) : null;
      }
    };
  }

  async function closeOffscreenKeepAlive() {
    if (!globalApi.offscreen || !globalApi.offscreen.closeDocument) return;
    try {
      if (await hasOffscreenDocument()) {
        await globalApi.offscreen.closeDocument();
      }
    } catch (_) {
      // Offscreen keepalive is best-effort; sync results are stored separately.
    }
  }

  const syncService = new QuietMarks.SyncService({
    stateStore,
    bookmarkAdapter,
    remoteStore: new QuietMarks.WebDavStore(new QuietMarks.CryptoCodec(), {
      fetchImpl: offscreenFetch
    }),
    mergeEngine: new QuietMarks.MergeEngine(),
    onKeepAliveStart: ensureOffscreenKeepAlive,
    onKeepAliveStop: closeOffscreenKeepAlive
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

        if (message.type === "quietmarks:keepalive") {
          return {
            ok: true
          };
        }

        if (message.type === "quietmarks:get") {
          let stored = await stateStore.get();
          const recovery = await syncService.resumeIfNeeded(stored);
          if (recovery.resumed) {
            stored = await stateStore.get();
          }
          return {
            config: stored.config,
            baseNodeCount: Object.keys(stored.baseState.nodes || {}).length,
            sync: recovery.sync || syncService.runtimeStatus(stored.syncJob)
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
