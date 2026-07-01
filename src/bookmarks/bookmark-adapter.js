(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};
  const {
    normalizeText,
    normalizeUrl,
    randomId,
    rootGuid,
    isBookmark,
    isFolder,
    nodeType
  } = QuietMarks.Utils;
  const { nowIso } = QuietMarks.Utils;

  function classifyRoot(node, index) {
    const title = normalizeText(node.title);
    if (/mobile|移动|移動/.test(title)) return "mobile";
    if (/other|其他/.test(title)) return "other";
    if (/menu|菜单|選單|書籤選單|书签菜单/.test(title)) return "menu";
    if (/toolbar|bar|栏|列|favorites bar|favourites bar|收藏夹栏|書籤工具列|书签工具栏|书签栏/.test(title)) {
      return "toolbar";
    }
    if (index === 0) return "toolbar";
    if (index === 1) return "other";
    if (index === 2) return "mobile";
    return `extra-${index}`;
  }

  function stateNodeSignature(node, path) {
    if (node.type === "bookmark") {
      return `bookmark|${normalizeUrl(node.url)}|${normalizeText(node.title)}|${path.join("/")}`;
    }
    return `folder|${normalizeText(node.title)}|${path.join("/")}`;
  }

  function stateNodeLooseSignature(node) {
    if (node.type === "bookmark") {
      return `bookmark|${normalizeUrl(node.url)}|${normalizeText(node.title)}`;
    }
    return `folder|${normalizeText(node.title)}|${node.parentGuid || ""}`;
  }

  function hasSameContent(a, b) {
    if (!a || !b) return false;
    return a.type === b.type &&
      normalizeText(a.title) === normalizeText(b.title) &&
      normalizeUrl(a.url) === normalizeUrl(b.url) &&
      a.parentGuid === b.parentGuid &&
      Number(a.index || 0) === Number(b.index || 0) &&
      Boolean(a.deleted) === Boolean(b.deleted);
  }

  function makeRemoteIndex(remoteState) {
    const bySignature = new Map();
    const byLooseSignature = new Map();
    const byUrl = new Map();

    Object.values(remoteState.nodes || {}).forEach((node) => {
      if (!node || node.deleted || node.type === "root") return;
      const signature = node.signature || stateNodeLooseSignature(node);
      const loose = stateNodeLooseSignature(node);
      if (!bySignature.has(signature)) bySignature.set(signature, []);
      bySignature.get(signature).push(node.guid);
      if (!byLooseSignature.has(loose)) byLooseSignature.set(loose, []);
      byLooseSignature.get(loose).push(node.guid);
      if (node.type === "bookmark" && node.url) {
        const normalizedUrl = normalizeUrl(node.url);
        if (!byUrl.has(normalizedUrl)) byUrl.set(normalizedUrl, []);
        byUrl.get(normalizedUrl).push(node.guid);
      }
    });

    return {
      bySignature,
      byLooseSignature,
      byUrl,
      claimed: new Set()
    };
  }

  function takeUnique(map, key, claimed) {
    const values = map.get(key) || [];
    const available = values.filter((value) => !claimed.has(value));
    if (available.length === 1) {
      claimed.add(available[0]);
      return available[0];
    }
    return "";
  }

  function activeNodesByDepth(state, foldersFirst) {
    const nodes = Object.values(state.nodes || {}).filter((node) => {
      if (!node || node.deleted || node.type === "root") return false;
      return foldersFirst ? node.type === "folder" : node.type === "bookmark";
    });

    function depth(node) {
      let count = 0;
      let current = node;
      const seen = new Set();
      while (current && current.parentGuid && state.nodes[current.parentGuid] && !seen.has(current.guid)) {
        seen.add(current.guid);
        count += 1;
        current = state.nodes[current.parentGuid];
      }
      return count;
    }

    return nodes.sort((a, b) => depth(a) - depth(b));
  }

  function deletedNodesByDepth(state) {
    const nodes = Object.values(state.nodes || {}).filter((node) => node && node.deleted && node.type !== "root");

    function depth(node) {
      let count = 0;
      let current = node;
      const seen = new Set();
      while (current && current.parentGuid && state.nodes[current.parentGuid] && !seen.has(current.guid)) {
        seen.add(current.guid);
        count += 1;
        current = state.nodes[current.parentGuid];
      }
      return count;
    }

    return nodes.sort((a, b) => depth(b) - depth(a));
  }

  class BookmarkAdapter {
    constructor(extensionApi, hooks) {
      this.extensionApi = extensionApi;
      this.hooks = hooks || {};
    }

    resolveGuid(node, context) {
      const existing = context.idToGuid[node.id];
      if (existing) return existing;

      const modelNode = {
        type: nodeType(node),
        title: node.title || "",
        url: node.url || "",
        parentGuid: context.parentGuid
      };
      const signature = stateNodeSignature(modelNode, context.path);
      const loose = stateNodeLooseSignature(modelNode);

      const remoteMatch =
        takeUnique(context.remoteIndex.bySignature, signature, context.remoteIndex.claimed) ||
        takeUnique(context.remoteIndex.byLooseSignature, loose, context.remoteIndex.claimed);

      if (remoteMatch) return remoteMatch;

      if (isBookmark(node)) {
        const byUrl = takeUnique(context.remoteIndex.byUrl, normalizeUrl(node.url), context.remoteIndex.claimed);
        if (byUrl) return byUrl;
      }

      return `${context.clientId}:${randomId()}`;
    }

    async ensureDedicatedFolder(config) {
      const tree = await this.extensionApi.getTree();
      const rootChildren = (tree[0] && tree[0].children) || [];
      const toolbar = rootChildren.find((child, index) => classifyRoot(child, index) === "toolbar") || rootChildren[0];
      if (!toolbar) {
        throw new Error("No writable bookmark root found.");
      }

      const existing = (toolbar.children || []).find((child) => isFolder(child) && child.title === config.folderName);
      if (existing) return existing;

      return this.extensionApi.createBookmark({
        parentId: toolbar.id,
        title: config.folderName || "QuietMarks"
      });
    }

    async getSyncContainers(config) {
      if (config.scope === "folder") {
        const folder = await this.ensureDedicatedFolder(config);
        return [
          {
            guid: "root:quietmarks",
            kind: "quietmarks",
            node: folder,
            title: config.folderName || "QuietMarks",
            writable: true
          }
        ];
      }

      const tree = await this.extensionApi.getTree();
      const rootChildren = (tree[0] && tree[0].children) || [];
      return rootChildren.map((node, index) => {
        const kind = classifyRoot(node, index);
        return {
          guid: rootGuid(kind),
          kind,
          node,
          title: node.title || kind,
          writable: node.unmodifiable !== "managed"
        };
      });
    }

    async scanLocal(config, baseState, remoteState, idToGuid, guidToId) {
      const remoteIndex = makeRemoteIndex(remoteState);
      const containers = await this.getSyncContainers(config);
      const nodes = {};
      const nextIdToGuid = {
        ...idToGuid
      };
      const nextGuidToId = {
        ...guidToId
      };
      const observedAt = nowIso();

      function remember(id, guid) {
        if (!id || !guid) return;
        nextIdToGuid[id] = guid;
        nextGuidToId[guid] = id;
      }

      function addNode(modelNode) {
        const baseNode = baseState.nodes[modelNode.guid];
        const changed = !baseNode || !hasSameContent(baseNode, modelNode);
        const modifiedAt = changed ? observedAt : baseNode.modifiedAt || observedAt;
        nodes[modelNode.guid] = {
          ...modelNode,
          modifiedAt,
          deleted: false
        };
      }

      const walk = (node, parentGuid, path, index) => {
        if (!node || node.unmodifiable === "managed") return;
        const type = nodeType(node);
        const guid = this.resolveGuid(node, {
          idToGuid: nextIdToGuid,
          remoteIndex,
          parentGuid,
          path,
          clientId: config.clientId
        });
        remember(node.id, guid);

        const modelNode = {
          guid,
          type,
          title: node.title || "",
          url: node.url || "",
          parentGuid,
          index,
          dateAdded: node.dateAdded || 0,
          signature: stateNodeSignature(
            {
              type,
              title: node.title || "",
              url: node.url || "",
              parentGuid
            },
            path
          )
        };
        addNode(modelNode);

        if (isFolder(node) && Array.isArray(node.children)) {
          const nextPath = path.concat(normalizeText(node.title || ""));
          node.children.forEach((child, childIndex) => walk(child, guid, nextPath, childIndex));
        }
      };

      containers.forEach((container, containerIndex) => {
        remember(container.node.id, container.guid);
        addNode({
          guid: container.guid,
          type: "root",
          title: container.title,
          url: "",
          parentGuid: "",
          index: containerIndex,
          dateAdded: 0,
          signature: container.guid
        });
        (container.node.children || []).forEach((child, childIndex) => {
          walk(child, container.guid, [container.guid], childIndex);
        });
      });

      Object.values(baseState.nodes || {}).forEach((baseNode) => {
        if (!baseNode || baseNode.type === "root") return;
        if (!nodes[baseNode.guid]) {
          nodes[baseNode.guid] = {
            ...baseNode,
            deleted: true,
            deletedAt: observedAt,
            modifiedAt: observedAt
          };
        }
      });

      return {
        state: {
          version: 1,
          updatedAt: observedAt,
          lastWriter: config.clientId,
          roots: containers.map((container) => container.guid),
          nodes,
          events: []
        },
        idToGuid: nextIdToGuid,
        guidToId: nextGuidToId
      };
    }

    async getRootIdMap(config) {
      if (config.scope === "folder") {
        const folder = await this.ensureDedicatedFolder(config);
        return {
          "root:quietmarks": folder.id,
          "root:toolbar": folder.id,
          "root:menu": folder.id,
          "root:other": folder.id,
          "root:mobile": folder.id
        };
      }

      const tree = await this.extensionApi.getTree();
      const rootChildren = (tree[0] && tree[0].children) || [];
      const rootMap = {};
      rootChildren.forEach((node, index) => {
        rootMap[rootGuid(classifyRoot(node, index))] = node.id;
      });

      const fallback = rootMap["root:other"] || rootMap["root:toolbar"] || (rootChildren[0] && rootChildren[0].id);
      ["root:toolbar", "root:menu", "root:other", "root:mobile", "root:quietmarks"].forEach((guid) => {
        if (!rootMap[guid] && fallback) {
          rootMap[guid] = fallback;
        }
      });
      return rootMap;
    }

    async safeRemove(node, id) {
      try {
        if (node.type === "folder") {
          await this.extensionApi.removeBookmarkTree(id);
        } else {
          await this.extensionApi.removeBookmark(id);
        }
      } catch (_) {
        // The item may already be gone locally; the merged tombstone still remains remotely.
      }
    }

    forgetMapping(guid, id, nextGuidToId, nextIdToGuid) {
      if (guid) delete nextGuidToId[guid];
      if (id) delete nextIdToGuid[id];
      Object.keys(nextIdToGuid).forEach((localId) => {
        if (nextIdToGuid[localId] === guid) delete nextIdToGuid[localId];
      });
    }

    async updateOrForget(node, id, changes, nextGuidToId, nextIdToGuid) {
      try {
        await this.extensionApi.updateBookmark(id, changes);
        return true;
      } catch (_) {
        this.forgetMapping(node.guid, id, nextGuidToId, nextIdToGuid);
        return false;
      }
    }

    async createOrThrow(node, payload, nextGuidToId, nextIdToGuid) {
      try {
        const created = await this.extensionApi.createBookmark(payload);
        if (!created || !created.id) {
          throw new Error("Browser did not return a bookmark id.");
        }
        nextGuidToId[node.guid] = created.id;
        nextIdToGuid[created.id] = node.guid;
        return created.id;
      } catch (error) {
        throw new Error(`Failed to create browser bookmark "${node.title || node.url || node.guid}": ${error.message || String(error)}`);
      }
    }

    findTreeNodeById(tree, id) {
      const roots = Array.isArray(tree) ? tree : [];
      const stack = roots.map((node) => ({
        node,
        parent: null
      }));

      while (stack.length) {
        const current = stack.pop();
        if (current.node && current.node.id === id) return current;
        ((current.node && current.node.children) || []).forEach((child) => {
          stack.push({
            node: child,
            parent: current.node
          });
        });
      }

      return null;
    }

    async boundedMoveDestination(id, destination) {
      if (!destination || destination.index == null || !destination.parentId) return destination;
      const requestedIndex = Math.max(0, Number(destination.index || 0));
      const tree = await this.extensionApi.getTree();
      const parentMatch = this.findTreeNodeById(tree, destination.parentId);
      if (!parentMatch || !parentMatch.node || !Array.isArray(parentMatch.node.children)) {
        return destination;
      }

      const movingWithinParent = parentMatch.node.children.some((child) => child && child.id === id);
      const maxIndex = Math.max(0, parentMatch.node.children.length - (movingWithinParent ? 1 : 0));
      return {
        parentId: destination.parentId,
        index: Math.min(requestedIndex, maxIndex)
      };
    }

    async moveOrThrow(node, id, destination) {
      try {
        await this.extensionApi.moveBookmark(id, destination);
      } catch (error) {
        const message = error.message || String(error);
        if (/index.*bounds/i.test(message) && destination && destination.parentId) {
          try {
            await this.extensionApi.moveBookmark(id, await this.boundedMoveDestination(id, destination));
            return;
          } catch (retryError) {
            throw new Error(`Failed to place browser bookmark "${node.title || node.url || node.guid}": ${retryError.message || String(retryError)}`);
          }
        }
        throw new Error(`Failed to place browser bookmark "${node.title || node.url || node.guid}": ${message}`);
      }
    }

    async applyStateToLocal(config, state, guidToId, idToGuid) {
      if (this.hooks.onApplyStart) this.hooks.onApplyStart();
      try {
        const rootIdMap = await this.getRootIdMap(config);
        const nextGuidToId = {
          ...guidToId,
          ...rootIdMap
        };
        const nextIdToGuid = {
          ...idToGuid
        };
        Object.entries(rootIdMap).forEach(([guid, id]) => {
          nextIdToGuid[id] = guid;
        });

        for (const node of deletedNodesByDepth(state)) {
          const id = nextGuidToId[node.guid];
          if (id && !node.guid.startsWith("root:")) {
            await this.safeRemove(node, id);
            delete nextGuidToId[node.guid];
            Object.keys(nextIdToGuid).forEach((localId) => {
              if (nextIdToGuid[localId] === node.guid) delete nextIdToGuid[localId];
            });
          }
        }

        for (const node of activeNodesByDepth(state, true)) {
          const parentId = nextGuidToId[node.parentGuid] || rootIdMap["root:other"] || rootIdMap["root:toolbar"];
          if (!parentId) continue;

          let id = nextGuidToId[node.guid];
          if (!id) {
            id = await this.createOrThrow(node, {
              parentId,
              title: node.title || "Untitled"
            }, nextGuidToId, nextIdToGuid);
          } else {
            const updated = await this.updateOrForget(node, id, {
              title: node.title || "Untitled"
            }, nextGuidToId, nextIdToGuid);
            if (!updated) {
              id = await this.createOrThrow(node, {
                parentId,
                title: node.title || "Untitled"
              }, nextGuidToId, nextIdToGuid);
            }
          }

          await this.moveOrThrow(node, id, {
            parentId,
            index: Math.max(0, Number(node.index || 0))
          });
        }

        for (const node of activeNodesByDepth(state, false)) {
          const parentId = nextGuidToId[node.parentGuid] || rootIdMap["root:other"] || rootIdMap["root:toolbar"];
          if (!parentId) continue;

          let id = nextGuidToId[node.guid];
          if (!id) {
            id = await this.createOrThrow(node, {
              parentId,
              title: node.title || node.url || "Untitled",
              url: node.url
            }, nextGuidToId, nextIdToGuid);
          } else {
            const updated = await this.updateOrForget(node, id, {
              title: node.title || node.url || "Untitled",
              url: node.url
            }, nextGuidToId, nextIdToGuid);
            if (!updated) {
              id = await this.createOrThrow(node, {
                parentId,
                title: node.title || node.url || "Untitled",
                url: node.url
              }, nextGuidToId, nextIdToGuid);
            }
          }

          await this.moveOrThrow(node, id, {
            parentId,
            index: Math.max(0, Number(node.index || 0))
          });
        }

        return {
          guidToId: nextGuidToId,
          idToGuid: nextIdToGuid
        };
      } finally {
        if (this.hooks.onApplyEnd) this.hooks.onApplyEnd();
      }
    }
  }

  QuietMarks.BookmarkAdapter = BookmarkAdapter;
  QuietMarks.BookmarkAdapterHelpers = {
    classifyRoot,
    stateNodeSignature,
    stateNodeLooseSignature,
    hasSameContent,
    activeNodesByDepth,
    deletedNodesByDepth
  };
})(globalThis);
