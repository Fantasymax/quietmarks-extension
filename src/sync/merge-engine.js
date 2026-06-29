(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};
  const { DELETED_RETENTION_MS } = QuietMarks.Constants;
  const { blankState } = QuietMarks.StateModel;
  const { normalizeUrl, nowIso } = QuietMarks.Utils;
  const { hasSameContent } = QuietMarks.BookmarkAdapterHelpers;

  class MergeEngine {
    changedFromBase(baseNode, node) {
      if (!baseNode && !node) return false;
      if (!baseNode || !node) return true;
      return !hasSameContent(baseNode, node) ||
        normalizeUrl(baseNode.url) !== normalizeUrl(node.url) ||
        Boolean(baseNode.deleted) !== Boolean(node.deleted);
    }

    isNewer(a, b) {
      return new Date(a && a.modifiedAt ? a.modifiedAt : 0).getTime() >=
        new Date(b && b.modifiedAt ? b.modifiedAt : 0).getTime();
    }

    chooseChangedNode(localNode, remoteNode) {
      if (!localNode) return remoteNode;
      if (!remoteNode) return localNode;
      return this.isNewer(localNode, remoteNode) ? localNode : remoteNode;
    }

    repairMergedTree(state) {
      const nodes = state.nodes;
      Object.values(nodes).forEach((node) => {
        if (!node || node.deleted || node.type === "root") return;
        const parent = nodes[node.parentGuid];
        if (!parent || parent.deleted || parent.type === "bookmark") {
          node.parentGuid = "root:other";
        }
      });
    }

    mergeStates(baseState, localState, remoteState, clientId) {
      const merged = blankState(clientId);
      const conflicts = [];
      const allGuids = new Set([
        ...Object.keys(baseState.nodes || {}),
        ...Object.keys(localState.nodes || {}),
        ...Object.keys(remoteState.nodes || {})
      ]);
      const cutoff = Date.now() - DELETED_RETENTION_MS;

      allGuids.forEach((guid) => {
        const baseNode = baseState.nodes[guid];
        const localNode = localState.nodes[guid];
        const remoteNode = remoteState.nodes[guid];
        const localChanged = this.changedFromBase(baseNode, localNode);
        const remoteChanged = this.changedFromBase(baseNode, remoteNode);
        let selected = null;

        if (guid.startsWith("root:")) {
          selected = localNode || remoteNode || baseNode;
        } else if (localChanged && !remoteChanged) {
          selected = localNode;
        } else if (!localChanged && remoteChanged) {
          selected = remoteNode;
        } else if (!localChanged && !remoteChanged) {
          selected = localNode || remoteNode || baseNode;
        } else if (localNode && remoteNode) {
          if (localNode.deleted && remoteNode.deleted) {
            selected = this.isNewer(localNode, remoteNode) ? localNode : remoteNode;
          } else if (localNode.deleted !== remoteNode.deleted) {
            selected = localNode.deleted ? remoteNode : localNode;
            conflicts.push({
              guid,
              type: "delete-edit",
              winner: selected === localNode ? "local" : "remote"
            });
          } else if (hasSameContent(localNode, remoteNode)) {
            selected = this.isNewer(localNode, remoteNode) ? localNode : remoteNode;
          } else {
            selected = this.chooseChangedNode(localNode, remoteNode);
            conflicts.push({
              guid,
              type: "edit-edit",
              winner: selected === localNode ? "local" : "remote"
            });
          }
        } else {
          selected = localNode || remoteNode;
        }

        if (!selected) return;
        if (selected.deleted && selected.deletedAt && new Date(selected.deletedAt).getTime() < cutoff) {
          return;
        }
        merged.nodes[guid] = {
          ...selected
        };
      });

      merged.roots = Array.from(new Set([
        ...(remoteState.roots || []),
        ...(localState.roots || []),
        "root:toolbar",
        "root:menu",
        "root:other",
        "root:mobile",
        "root:quietmarks"
      ]));
      merged.updatedAt = nowIso();
      merged.lastWriter = clientId;
      merged.events = (remoteState.events || []).concat(conflicts.map((conflict) => ({
        ...conflict,
        at: merged.updatedAt
      }))).slice(-50);

      this.repairMergedTree(merged);

      return {
        state: merged,
        conflicts
      };
    }
  }

  QuietMarks.MergeEngine = MergeEngine;
})(globalThis);
