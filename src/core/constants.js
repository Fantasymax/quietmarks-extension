(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};
  const DEFAULT_STATE_FILE = "QuietMarks/state.json";

  QuietMarks.Constants = {
    SYNC_ALARM: "quietmarks.sync",
    DEFAULT_STATE_FILE,
    DELETED_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
    CHANGE_DEBOUNCE_MS: 5000,
    WEBDAV_TIMEOUT_MS: 45000,
    WEBDAV_PUT_TIMEOUT_MS: 180000,
    WEBDAV_FETCH_STALL_MS: 90000,
    SYNC_PHASE_TIMEOUT_MS: 180000,
    POPUP_SYNC_TIMEOUT_MS: 480000,
    PBKDF2_ITERATIONS: 250000,
    DEFAULT_CONFIG: {
      enabled: false,
      webdavUrl: "",
      username: "",
      password: "",
      passphrase: "",
      remoteFile: DEFAULT_STATE_FILE,
      scope: "all",
      folderName: "QuietMarks",
      intervalMinutes: 10,
      conflictPolicy: "merge",
      clientId: "",
      deviceName: "",
      lastSyncAt: "",
      lastSyncStatus: "Not configured",
      lastSyncError: "",
      lastStats: {
        localNodes: 0,
        remoteNodes: 0,
        mergedNodes: 0,
        appliedNodes: 0,
        missingAfterApply: 0,
        conflicts: 0
      }
    }
  };
})(globalThis);
