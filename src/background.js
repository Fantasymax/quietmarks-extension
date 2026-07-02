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
  const OFFSCREEN_MESSAGE_TIMEOUT_MS = 12000;
  const OFFSCREEN_POLL_MS = 1000;
  const {
    CHANGE_DEBOUNCE_MS,
    SYNC_ALARM,
    WEBDAV_TIMEOUT_MS
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sendRuntimeMessage(message, timeoutMs) {
    const usesPromiseApi = typeof browser !== "undefined" && globalApi === browser;
    const timeout = timeoutMs || OFFSCREEN_MESSAGE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Extension message timed out after ${Math.round(timeout / 1000)} seconds.`));
      }, timeout);
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        fn(value);
      };

      try {
        if (usesPromiseApi) {
          const result = globalApi.runtime.sendMessage(message);
          if (result && typeof result.then === "function") {
            result.then((response) => finish(resolve, response), (error) => finish(reject, error));
          } else {
            finish(resolve, result);
          }
          return;
        }

        const result = globalApi.runtime.sendMessage(message, (response) => {
          const lastError = globalApi.runtime && globalApi.runtime.lastError;
          if (lastError) {
            finish(reject, new Error(lastError.message));
            return;
          }
          finish(resolve, response);
        });
        if (result && typeof result.then === "function") {
          result.then((response) => finish(resolve, response), (error) => finish(reject, error));
        }
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function responseFromOffscreen(response) {
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

  async function offscreenFetch(url, options) {
    await ensureOffscreenKeepAlive();
    const method = options && options.method ? options.method : "fetch";
    const timeoutMs = Number(options && options.quietmarksTimeoutMs) || WEBDAV_TIMEOUT_MS;
    const requestId = `fetch-${Date.now()}-${QuietMarks.Utils.randomId()}`;
    let cancelled = false;

    async function cancelOffscreenFetch() {
      if (cancelled) return;
      cancelled = true;
      await sendRuntimeMessage({
        type: "quietmarks:offscreen-fetch-cancel",
        requestId
      }, OFFSCREEN_MESSAGE_TIMEOUT_MS).catch(() => {});
    }

    const signal = options && options.signal;
    const abortHandler = () => {
      cancelOffscreenFetch();
    };
    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) {
        await cancelOffscreenFetch();
        throw new Error(`WebDAV ${method} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      signal.addEventListener("abort", abortHandler, {
        once: true
      });
    }

    const request = {
      url,
      timeoutMs,
      options: {
        method,
        headers: serializeHeaders(options && options.headers),
        body: options && options.body,
        cache: options && options.cache
      }
    };

    try {
      const started = await sendRuntimeMessage({
        type: "quietmarks:offscreen-fetch-start",
        requestId,
        request
      }, OFFSCREEN_MESSAGE_TIMEOUT_MS);

      if (!started || started.ok === false) {
        throw new Error(started && started.error ? started.error : "Offscreen WebDAV fetch failed to start.");
      }

      const deadline = Date.now() + timeoutMs + OFFSCREEN_MESSAGE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (signal && signal.aborted) {
          await cancelOffscreenFetch();
          throw new Error(`WebDAV ${method} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
        }

        const response = await sendRuntimeMessage({
          type: "quietmarks:offscreen-fetch-result",
          requestId
        }, OFFSCREEN_MESSAGE_TIMEOUT_MS);

        if (response && response.running) {
          await sleep(OFFSCREEN_POLL_MS);
          continue;
        }

        if (!response || response.ok === false) {
          throw new Error(response && response.error ? response.error : "Offscreen WebDAV fetch failed.");
        }

        cancelled = true;
        return responseFromOffscreen(response);
      }

      await cancelOffscreenFetch();
      throw new Error(`WebDAV ${method} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    } catch (error) {
      await cancelOffscreenFetch();
      throw error;
    } finally {
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortHandler);
      }
    }
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
          const stored = await stateStore.get();
          return {
            config: stored.config,
            baseNodeCount: Object.keys(stored.baseState.nodes || {}).length,
            sync: syncService.runtimeStatus(stored.syncJob)
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

        if (message.type === "quietmarks:reset-sync-job") {
          return syncService.resetSyncJob();
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
