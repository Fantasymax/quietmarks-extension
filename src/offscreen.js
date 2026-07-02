/* global chrome, browser, fetch, Headers, AbortController, setInterval, setTimeout, clearTimeout */
(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const DEFAULT_TIMEOUT_MS = 45000;
  const FETCH_JOB_TTL_MS = 5 * 60 * 1000;
  const fetchJobs = new Map();

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

  function publicJob(job) {
    if (!job) return null;
    return {
      status: job.status,
      phase: job.phase,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt || "",
      error: job.error || ""
    };
  }

  function updateJob(job, patch) {
    Object.assign(job, patch, {
      updatedAt: new Date().toISOString()
    });
  }

  async function runFetch(request, onPhase, controller) {
    const fetchController = controller || (typeof AbortController !== "undefined" ? new AbortController() : null);
    const method = request.options && request.options.method ? request.options.method : "fetch";
    const timeoutMs = request.timeoutMs || DEFAULT_TIMEOUT_MS;
    if (onPhase) onPhase(`WebDAV ${method}: sending request...`);
    const response = await withTimeout(fetch(request.url, {
      method,
      headers: makeHeaders(request.options && request.options.headers),
      body: request.options && request.options.body,
      cache: request.options && request.options.cache,
      signal: fetchController ? fetchController.signal : undefined
    }), method, timeoutMs, fetchController);
    if (onPhase) onPhase(`WebDAV ${method}: reading response body...`);
    const body = await withTimeout(response.text(), `${method} response body`, timeoutMs);
    return {
      ok: true,
      fetchOk: response.ok,
      status: response.status,
      headers: Array.from(response.headers.entries()),
      body
    };
  }

  function cleanupOldJobs() {
    const now = Date.now();
    fetchJobs.forEach((job, requestId) => {
      if (now - job.touchedAt > FETCH_JOB_TTL_MS) {
        if (job.controller) job.controller.abort();
        fetchJobs.delete(requestId);
      }
    });
  }

  function startFetchJob(requestId, request) {
    cleanupOldJobs();
    if (fetchJobs.has(requestId)) return fetchJobs.get(requestId);

    const now = new Date().toISOString();
    const job = {
      status: "running",
      phase: "Starting WebDAV request...",
      startedAt: now,
      updatedAt: now,
      touchedAt: Date.now(),
      finishedAt: "",
      error: "",
      response: null,
      controller: typeof AbortController !== "undefined" ? new AbortController() : null
    };
    fetchJobs.set(requestId, job);

    runFetch(request, (phase) => {
      job.touchedAt = Date.now();
      updateJob(job, {
        phase
      });
    }, job.controller)
      .then((response) => {
        job.touchedAt = Date.now();
        job.response = response;
        updateJob(job, {
          status: "done",
          phase: "WebDAV request complete.",
          finishedAt: new Date().toISOString()
        });
      })
      .catch((error) => {
        job.touchedAt = Date.now();
        updateJob(job, {
          status: "error",
          phase: "WebDAV request failed.",
          finishedAt: new Date().toISOString(),
          error: error.message || String(error)
        });
      });

    return job;
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === "quietmarks:offscreen-fetch-start") {
      const requestId = message.requestId;
      if (!requestId) {
        sendResponse({
          ok: false,
          error: "Missing offscreen fetch request id."
        });
        return false;
      }
      const job = startFetchJob(requestId, message.request || {});
      sendResponse({
        ok: true,
        requestId,
        job: publicJob(job)
      });
      return false;
    }

    if (message.type === "quietmarks:offscreen-fetch-result") {
      const requestId = message.requestId;
      const job = requestId ? fetchJobs.get(requestId) : null;
      if (!job) {
        sendResponse({
          ok: false,
          error: "Offscreen WebDAV request was not found. Start sync again."
        });
        return false;
      }
      job.touchedAt = Date.now();
      if (job.status === "running") {
        sendResponse({
          ok: true,
          running: true,
          job: publicJob(job)
        });
        return false;
      }
      fetchJobs.delete(requestId);
      if (job.status === "error") {
        sendResponse({
          ok: false,
          error: job.error || "Offscreen WebDAV request failed.",
          job: publicJob(job)
        });
        return false;
      }
      sendResponse(job.response);
      return false;
    }

    if (message.type === "quietmarks:offscreen-fetch-cancel") {
      const requestId = message.requestId;
      const job = requestId ? fetchJobs.get(requestId) : null;
      if (job && job.controller) job.controller.abort();
      if (requestId) fetchJobs.delete(requestId);
      sendResponse({
        ok: true
      });
      return false;
    }

    if (message.type !== "quietmarks:offscreen-fetch") return false;
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
