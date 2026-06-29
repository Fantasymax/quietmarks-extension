(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};
  const { DEFAULT_STATE_FILE } = QuietMarks.Constants;
  const { nowIso } = QuietMarks.Utils;

  function blankState(clientId) {
    const updatedAt = nowIso();
    return {
      version: 1,
      updatedAt,
      lastWriter: clientId || "",
      nodes: {},
      roots: ["root:toolbar", "root:menu", "root:other", "root:mobile", "root:quietmarks"],
      events: []
    };
  }

  function normalizeState(state, clientId) {
    if (!state || typeof state !== "object" || !state.nodes) {
      return blankState(clientId);
    }
    return {
      version: 1,
      updatedAt: state.updatedAt || nowIso(),
      lastWriter: state.lastWriter || "",
      nodes: state.nodes || {},
      roots: Array.isArray(state.roots) && state.roots.length ? state.roots : blankState(clientId).roots,
      events: Array.isArray(state.events) ? state.events.slice(-50) : []
    };
  }

  function cleanRemoteFile(config) {
    const file = String(config.remoteFile || DEFAULT_STATE_FILE).replace(/^\/+/, "");
    return file || DEFAULT_STATE_FILE;
  }

  QuietMarks.StateModel = {
    blankState,
    normalizeState,
    cleanRemoteFile
  };
})(globalThis);
