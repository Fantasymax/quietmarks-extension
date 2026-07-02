/* global chrome, browser */
(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const POPUP_SYNC_TIMEOUT_MS = 480000;
  const POPUP_WEBDAV_TIMEOUT_MS = 45000;
  const POPUP_POLL_TIMEOUT_MS = 10000;
  const POPUP_SAVE_TIMEOUT_MS = 10000;
  const fields = [
    "enabled",
    "webdavUrl",
    "username",
    "password",
    "passphrase",
    "remoteFile",
    "scope",
    "folderName",
    "intervalMinutes",
    "conflictPolicy"
  ];

  const element = (id) => document.getElementById(id);
  let toastTimer = null;
  let savedButtonLabel = "Save";
  let syncButtonLabel = "Sync now";
  let testWebdavButtonLabel = "Test WebDAV";
  let resetSyncButtonLabel = "Clear stuck sync";
  let followTimer = null;

  function send(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = timeoutMs
        ? setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`${type} did not respond after ${Math.round(timeoutMs / 1000)} seconds. The background sync may be stuck; reload the extension and try again.`));
        }, timeoutMs)
        : null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        fn(value);
      };
      try {
        const message = {
          type,
          ...(payload || {})
        };
        const result = api.runtime.sendMessage(message, (response) => {
          const lastError = api.runtime.lastError;
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

  function setStatus(status, error) {
    const statusText = element("statusText");
    const statusMeta = element("statusMeta");
    const dot = element("statusDot");
    if (!statusText || !statusMeta || !dot) return;

    statusText.textContent = status || "Not configured";
    statusMeta.textContent = error || "Ready when your bookmarks change.";
    dot.className = "dot";

    if (status === "Synced") dot.classList.add("ok");
    else if (status === "Error") dot.classList.add("bad");
    else if (status === "Syncing") dot.classList.add("busy");
    else dot.classList.add("idle");
  }

  function showToast(message, tone) {
    const toast = element("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${tone || ""}`.trim();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.className = "toast";
    }, 2600);
  }

  function updateAutoSyncHint(enabled) {
    const hint = element("autoSyncHint");
    const modePill = element("syncModePill");
    const modeLabel = element("syncModeLabel");
    document.body.classList.toggle("sync-enabled", Boolean(enabled));
    document.body.classList.toggle("sync-disabled", !enabled);
    if (hint) {
      hint.textContent = enabled
        ? "On. Bookmark changes sync in the background."
        : "Off. Use Sync now for manual sync.";
    }
    if (modePill) {
      modePill.className = enabled ? "mode-pill on" : "mode-pill off";
    }
    if (modeLabel) {
      modeLabel.textContent = enabled ? "Auto sync on" : "Manual mode";
    }
  }

  function setActionMessage(message, tone) {
    const actionMessage = element("actionMessage");
    if (!actionMessage) return;
    actionMessage.textContent = message || "";
    actionMessage.className = `action-message ${tone || ""}`.trim();
  }

  function friendlyError(message) {
    if (!message) return "Sync failed";
    if (message === "Failed to fetch") {
      return "Cannot reach the WebDAV server. Check the URL, network, and app password.";
    }
    if (/A sync is already running/.test(message)) {
      return "A sync is already running. Wait a moment, then try again.";
    }
    if (message === "WebDAV PUT failed 404") {
      return "WebDAV target folder was not found. Use an existing WebDAV folder or set State file to QuietMarks/state.json.";
    }
    return message;
  }

  function friendlyWebDavError(message) {
    const readable = friendlyError(message);
    if (/Sync file path must include a file name/.test(readable)) {
      return "Sync file path must be a file, for example QuietMarks/state.json. Do not enter only QuietMarks.";
    }
    if (/WebDAV cannot create folder/.test(readable)) {
      return readable.replace("Create it manually or choose an existing WebDAV folder.", "The folder was not writable for folder creation. Since you already created it, press Test WebDAV again after saving the exact path QuietMarks/state.json.");
    }
    return readable;
  }

  function setButtonState(button, label, state) {
    if (!button) return;
    button.textContent = label;
    button.dataset.state = state || "idle";
    button.disabled = state === "busy";
  }

  function setPanelStatus(status) {
    document.body.classList.toggle("sync-error", status === "Error");
    document.body.classList.toggle("sync-busy", status === "Syncing");
    document.body.classList.toggle("sync-ok", status === "Synced");
  }

  function setBackgroundHealth(config, sync) {
    const health = element("backgroundHealth");
    const text = element("backgroundHealthText");
    if (!health || !text) return;

    let mode = "idle";
    let label = "Background idle (normal)";
    if (sync && sync.inFlight) {
      mode = "active";
      label = "Background active";
    } else if (sync && sync.recoverable) {
      mode = "warn";
      label = "Background recovering";
    } else if (config && config.lastSyncStatus === "Error") {
      mode = "warn";
      label = "Background needs attention";
    }

    health.className = `background-health ${mode}`;
    text.textContent = label;
  }

  function isSyncRunning(config, sync) {
    return Boolean(sync && sync.inFlight);
  }

  function displayConfig(config, sync) {
    if (!config) return config;
    if (config.lastSyncStatus === "Syncing" && !isSyncRunning(config, sync)) {
      return {
        ...config,
        lastSyncStatus: "Ready",
        lastSyncError: "Previous sync state was left open. Use Clear stuck sync, then Sync now."
      };
    }
    return config;
  }

  function renderSyncControls(config, sync) {
    const syncBtn = element("syncBtn");
    const isRunning = isSyncRunning(config, sync);
    if (isRunning) {
      setButtonState(syncBtn, "Syncing...", "busy");
      setActionMessage(config.lastSyncError || "Sync is running in the background...", "");
    } else if (syncBtn && syncBtn.dataset.state === "busy") {
      setButtonState(syncBtn, syncButtonLabel, "idle");
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function readForm() {
    const config = {};
    fields.forEach((field) => {
      const input = element(field);
      if (!input) return;
      if (input.type === "checkbox") config[field] = input.checked;
      else if (input.type === "number") config[field] = Number(input.value || 0);
      else config[field] = input.value.trim();
    });
    return config;
  }

  function writeForm(config) {
    fields.forEach((field) => {
      const input = element(field);
      if (!input) return;
      const value = config[field];
      if (input.type === "checkbox") input.checked = Boolean(value);
      else input.value = value == null ? "" : value;
    });
    updateAutoSyncHint(Boolean(config.enabled));
  }

  function formatMs(ms) {
    const value = Number(ms || 0);
    if (!value) return "";
    if (value < 1000) return `${value}ms`;
    return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
  }

  function writeStats(config, baseNodeCount) {
    const stats = config.lastStats || {};
    const lastStats = element("lastStats");
    const base = element("baseNodeCount");
    const device = element("deviceName");
    const meta = element("statusMeta");

    if (base) base.textContent = `${baseNodeCount || 0} nodes`;
    if (device) device.textContent = config.deviceName || "This browser";
    if (lastStats) {
      const local = Number(stats.localNodes || 0);
      const cloud = Number(stats.remoteNodes || 0);
      const merged = Number(stats.mergedNodes || 0);
      const applied = Number(stats.appliedNodes || 0);
      const missing = Number(stats.missingAfterApply || 0);
      const conflicts = Number(stats.conflicts || 0);
      const timing = [
        ["GET", stats.webdavGetMs],
        ["scan", stats.scanMs],
        ["apply", stats.applyMs],
        ["verify", stats.verifyScanMs],
        ["PUT", stats.webdavPutMs]
      ]
        .map(([label, value]) => {
          const formatted = formatMs(value);
          return formatted ? `${label} ${formatted}` : "";
        })
        .filter(Boolean);
      const remoteTotal = Number(stats.remoteTotalNodes || 0);
      const remoteHint = remoteTotal && remoteTotal !== cloud ? `, cloud total ${remoteTotal}` : "";
      lastStats.textContent = `Local ${local}, cloud ${cloud}${remoteHint}, merged ${merged}, applied ${applied}, missing ${missing}, conflicts ${conflicts}${timing.length ? ` | ${timing.join(", ")}` : ""}`;
    }
    if (meta && config.lastSyncAt && !config.lastSyncError) {
      meta.textContent = `Last sync ${new Date(config.lastSyncAt).toLocaleString()}`;
    }
  }

  function renderState(response) {
    if (!response || !response.config) return response;
    const visibleConfig = displayConfig(response.config, response.sync);
    writeForm(response.config);
    setStatus(visibleConfig.lastSyncStatus, visibleConfig.lastSyncError);
    setPanelStatus(visibleConfig.lastSyncStatus);
    setBackgroundHealth(visibleConfig, response.sync);
    writeStats(response.config, response.baseNodeCount);
    renderSyncControls(visibleConfig, response.sync);
    if (visibleConfig.lastSyncStatus === "Error" && visibleConfig.lastSyncError) {
      setActionMessage(friendlyError(visibleConfig.lastSyncError), "bad");
    } else if (visibleConfig.lastSyncStatus === "Syncing" && visibleConfig.lastSyncError) {
      setActionMessage(visibleConfig.lastSyncError, "");
    } else if (visibleConfig.lastSyncStatus === "Ready" && visibleConfig.lastSyncError) {
      setActionMessage(visibleConfig.lastSyncError, "");
    }
    return response;
  }

  async function refresh() {
    const response = await send("quietmarks:get", null, POPUP_POLL_TIMEOUT_MS);
    return renderState(response);
  }

  function followActiveSync() {
    if (followTimer) return;
    followTimer = setInterval(async () => {
      try {
        const response = await send("quietmarks:get", null, POPUP_POLL_TIMEOUT_MS);
        renderState(response);
        const running = response && response.config && isSyncRunning(response.config, response.sync);
        if (!running) {
          clearInterval(followTimer);
          followTimer = null;
        }
      } catch (_) {
        // Keep the popup responsive even if the service worker is briefly waking up.
      }
    }, 1200);
  }

  async function waitForSyncStart(syncPromise, timeoutMs) {
    const startedAt = Date.now();
    let lastConfig = null;
    let sawActiveSync = false;
    let startSettled = false;
    const wrappedSync = syncPromise.then(
      (response) => ({
        done: true,
        response
      }),
      (error) => ({
        done: true,
        error
      })
    );

    while (Date.now() - startedAt < timeoutMs) {
      const syncResult = startSettled
        ? await sleep(1200).then(() => ({
          done: false
        }))
        : await Promise.race([
          wrappedSync,
          sleep(1200).then(() => ({
            done: false
          }))
        ]);
      if (syncResult.done) {
        if (syncResult.error) throw syncResult.error;
        if (!syncResult.response || syncResult.response.ok === false) {
          return syncResult.response;
        }
        startSettled = true;
        sawActiveSync = true;
      }

      let response = null;
      try {
        response = await send("quietmarks:get", null, POPUP_POLL_TIMEOUT_MS);
      } catch (_) {
        response = null;
      }

      if (!response || !response.config) continue;
      renderState(response);
      lastConfig = response.config;
      const running = isSyncRunning(lastConfig, response.sync);

      if (running) {
        sawActiveSync = true;
        setActionMessage(lastConfig.lastSyncError || "Syncing bookmarks...", "");
        continue;
      }

      if (sawActiveSync && !running && (lastConfig.lastSyncStatus === "Synced" || lastConfig.lastSyncStatus === "Error")) {
        return {
          ok: lastConfig.lastSyncStatus === "Synced",
          error: lastConfig.lastSyncStatus === "Error" ? lastConfig.lastSyncError : "",
          config: lastConfig
        };
      }
    }

    const phase = lastConfig && lastConfig.lastSyncError ? ` Last phase: ${lastConfig.lastSyncError}` : "";
    throw new Error(`Sync did not finish after ${Math.round(timeoutMs / 1000)} seconds.${phase}`);
  }

  async function save(toastMessage, options) {
    const opts = options || {};
    const saveBtn = element("saveBtn");
    if (!opts.silent) {
      setButtonState(saveBtn, "Saving...", "busy");
      setActionMessage("Saving settings...", "");
    }
    const nextConfig = readForm();
    let response = null;
    try {
      response = await send("quietmarks:save", {
        config: nextConfig
      }, POPUP_SAVE_TIMEOUT_MS);
    } catch (error) {
      const readableError = friendlyError(error.message || String(error));
      if (!opts.silent) {
        setButtonState(saveBtn, "Save failed", "bad");
        setTimeout(() => setButtonState(saveBtn, savedButtonLabel, "idle"), 1800);
        showToast("Save failed", "bad");
      }
      setActionMessage(readableError, "bad");
      throw error;
    }
    if (!response || response.ok === false) {
      if (!opts.silent) {
        setButtonState(saveBtn, "Save failed", "bad");
        setTimeout(() => setButtonState(saveBtn, savedButtonLabel, "idle"), 1800);
        showToast("Save failed", "bad");
      }
      setActionMessage(friendlyError(response && response.error ? response.error : "Save failed"), "bad");
      throw new Error(response && response.error ? response.error : "Save failed");
    }
    if (!opts.keepStatus) {
      setStatus(response.config.lastSyncStatus, response.config.lastSyncError);
      setPanelStatus(response.config.lastSyncStatus);
    }
    writeForm(response.config);
    if (!opts.silent) {
      setButtonState(saveBtn, "Saved", "ok");
      setActionMessage("Settings saved.", "ok");
      setTimeout(() => setButtonState(saveBtn, savedButtonLabel, "idle"), 1400);
    }
    if (toastMessage) showToast(toastMessage, "ok");
    return response.config;
  }

  async function syncNow() {
    const syncBtn = element("syncBtn");
    try {
      setStatus("Syncing", "Merging local and remote bookmark trees...");
      setPanelStatus("Syncing");
      setButtonState(syncBtn, "Syncing...", "busy");
      setActionMessage("Merging local and WebDAV bookmark trees...", "");
      await save("", {
        silent: true,
        keepStatus: true
      });
      const response = await waitForSyncStart(
        send("quietmarks:sync-now", null, POPUP_POLL_TIMEOUT_MS),
        POPUP_SYNC_TIMEOUT_MS
      );
      if (!response || response.ok === false) {
        const error = response && response.error ? response.error : "Sync failed";
        if (/already running/i.test(error)) {
          followActiveSync();
          setButtonState(syncBtn, "Syncing...", "busy");
          setActionMessage("Sync is already running. Reconnected to the current task.", "");
          return;
        }
        const readableError = friendlyError(error);
        setStatus("Error", readableError);
        setPanelStatus("Error");
        setButtonState(syncBtn, "Retry sync", "bad");
        setActionMessage(readableError, "bad");
        showToast("Sync failed", "bad");
        return;
      }

      setButtonState(syncBtn, "Synced", "ok");
      setActionMessage("Bookmarks synced successfully.", "ok");
      showToast("Sync complete", "ok");
      await refresh();
      setTimeout(() => setButtonState(syncBtn, syncButtonLabel, "idle"), 1400);
    } catch (error) {
      const readableError = friendlyError(error.message || String(error));
      setStatus("Error", readableError);
      setPanelStatus("Error");
      setButtonState(syncBtn, "Retry sync", "bad");
      setActionMessage(readableError, "bad");
      showToast("Sync failed", "bad");
    }
  }

  async function resetSyncJob() {
    const resetBtn = element("resetSync");
    setButtonState(resetBtn, "Clearing...", "busy");
    setActionMessage("Clearing stuck sync state...", "");
    try {
      const response = await send("quietmarks:reset-sync-job", null, POPUP_SAVE_TIMEOUT_MS);
      if (!response || response.ok === false) {
        throw new Error(response && response.error ? response.error : "Could not clear stuck sync state.");
      }
      setButtonState(resetBtn, "Cleared", "ok");
      setActionMessage("Stuck sync state cleared. Press Sync now when ready.", "ok");
      showToast("Sync state cleared", "ok");
      await refresh();
      setTimeout(() => setButtonState(resetBtn, resetSyncButtonLabel, "idle"), 1400);
    } catch (error) {
      const readableError = friendlyError(error.message || String(error));
      setButtonState(resetBtn, "Clear failed", "bad");
      setActionMessage(readableError, "bad");
      showToast("Clear failed", "bad");
      setTimeout(() => setButtonState(resetBtn, resetSyncButtonLabel, "idle"), 2000);
    }
  }

  async function testWebDav() {
    const testBtn = element("testWebdavBtn");
    setButtonState(testBtn, "Testing...", "busy");
    setActionMessage("Checking WebDAV folder and write permission...", "");
    const config = readForm();

    const response = await send("quietmarks:test-webdav", {
      config
    }, POPUP_WEBDAV_TIMEOUT_MS);

    if (!response || response.ok === false) {
      const error = friendlyWebDavError(response && response.error ? response.error : "WebDAV test failed");
      setButtonState(testBtn, "Test failed", "bad");
      setActionMessage(error, "bad");
      showToast("WebDAV test failed", "bad");
      setTimeout(() => setButtonState(testBtn, testWebdavButtonLabel, "idle"), 2200);
      return;
    }

    setButtonState(testBtn, "Writable", "ok");
    setActionMessage(response.message || "WebDAV is writable.", "ok");
    showToast("WebDAV is writable", "ok");
    setTimeout(() => setButtonState(testBtn, testWebdavButtonLabel, "idle"), 1800);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const form = element("settingsForm");
    const syncBtn = element("syncBtn");
    const openOptions = element("openOptions");
    const resetBase = element("resetBase");
    const resetSync = element("resetSync");
    const enabled = element("enabled");
    const saveBtn = element("saveBtn");
    const testWebdavBtn = element("testWebdavBtn");

    if (saveBtn) savedButtonLabel = saveBtn.textContent;
    if (syncBtn) syncButtonLabel = syncBtn.textContent;
    if (testWebdavBtn) testWebdavButtonLabel = testWebdavBtn.textContent;
    if (resetSync) resetSyncButtonLabel = resetSync.textContent;

    refresh()
      .then((response) => {
        const running = response && response.config && isSyncRunning(response.config, response.sync);
        if (running) followActiveSync();
      })
      .catch((error) => setStatus("Error", error.message));

    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        save("Settings saved")
          .then(refresh)
          .catch((error) => setStatus("Error", error.message));
      });
    }

    if (enabled) {
      enabled.addEventListener("change", () => {
        const previousChecked = !enabled.checked;
        updateAutoSyncHint(enabled.checked);
        save()
          .then(() => {
            const message = enabled.checked
              ? "Auto sync enabled. Bookmark changes and interval checks will sync in the background."
              : "Auto sync disabled. Manual sync only.";
            setActionMessage(message, enabled.checked ? "ok" : "");
            showToast(enabled.checked ? "Auto sync enabled" : "Auto sync disabled", enabled.checked ? "ok" : "");
          })
          .catch((error) => {
            enabled.checked = previousChecked;
            updateAutoSyncHint(enabled.checked);
            setStatus("Error", error.message);
          });
      });
    }

    if (syncBtn) {
      syncBtn.addEventListener("click", () => {
        syncNow().catch((error) => setStatus("Error", error.message));
      });
    }

    if (testWebdavBtn) {
      testWebdavBtn.addEventListener("click", () => {
        testWebDav().catch((error) => {
          setButtonState(testWebdavBtn, "Test failed", "bad");
          setActionMessage(friendlyWebDavError(error.message), "bad");
          setStatus("Error", friendlyWebDavError(error.message));
          setTimeout(() => setButtonState(testWebdavBtn, testWebdavButtonLabel, "idle"), 2200);
        });
      });
    }

    if (openOptions && api.runtime.openOptionsPage) {
      openOptions.addEventListener("click", () => api.runtime.openOptionsPage());
    }

    if (resetBase) {
      resetBase.addEventListener("click", () => {
        send("quietmarks:reset-local-base")
          .then(refresh)
          .catch((error) => setStatus("Error", error.message));
      });
    }

    if (resetSync) {
      resetSync.addEventListener("click", () => {
        resetSyncJob();
      });
    }
  });
})();
