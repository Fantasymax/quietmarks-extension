/* global chrome, browser, Worker */
(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const worker = new Worker("offscreen-worker.js");

  worker.onmessage = (event) => {
    if (!event || !event.data || event.data.type !== "quietmarks:keepalive") return;
    try {
      api.runtime.sendMessage({
        type: "quietmarks:keepalive"
      }, () => {
        // Ignore lastError; the next ping will wake the service worker again if needed.
      });
    } catch (_) {
      // Keepalive is best-effort and should never crash the offscreen page.
    }
  };
})();
