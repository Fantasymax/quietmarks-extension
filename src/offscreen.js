/* global chrome, browser, fetch, Headers, AbortController, setInterval, setTimeout, clearTimeout */
(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const DEFAULT_TIMEOUT_MS = 45000;

  function keepAlive() {
    try {
      api.runtime.sendMessage({
        type: "quietmarks:keepalive"
      }, () => {
        // Ignore lastError; the next ping will wake the service worker again if needed.
      });
    } catch (_) {
      // Keepalive is best-effort and should never crash the offscreen page.
    }
  }

  function withTimeout(promise, label, timeoutMs, controller) {
    const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
    let timeoutId = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          if (controller) controller.abort();
          reject(new Error(`WebDAV ${label} timed out after ${Math.round(timeout / 1000)} seconds.`));
        }, timeout);
      })
    ]).catch((error) => {
      if (error && error.name === "AbortError") {
        throw new Error(`WebDAV ${label} timed out after ${Math.round(timeout / 1000)} seconds.`);
      }
      throw error;
    }).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
  }

  function makeHeaders(entries) {
    const headers = new Headers();
    (entries || []).forEach(([name, value]) => headers.set(name, value));
    return headers;
  }

  async function runFetch(request) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const response = await withTimeout(fetch(request.url, {
      method: request.options && request.options.method,
      headers: makeHeaders(request.options && request.options.headers),
      body: request.options && request.options.body,
      cache: request.options && request.options.cache,
      signal: controller ? controller.signal : undefined
    }), request.options && request.options.method ? request.options.method : "fetch", DEFAULT_TIMEOUT_MS, controller);
    const body = await withTimeout(response.text(), "response body", DEFAULT_TIMEOUT_MS);
    return {
      ok: true,
      fetchOk: response.ok,
      status: response.status,
      headers: Array.from(response.headers.entries()),
      body
    };
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "quietmarks:offscreen-fetch") return false;
    runFetch(message.request || {})
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  });

  keepAlive();
  setInterval(keepAlive, 15000);
})();
