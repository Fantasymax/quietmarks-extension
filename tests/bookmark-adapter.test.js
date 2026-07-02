const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");

function loadScript(context, relativePath) {
  const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
  vm.runInContext(source, context, {
    filename: relativePath
  });
}

function createContext() {
  const context = {
    console,
    URL,
    crypto: {
      getRandomValues(bytes) {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index + 1;
        }
        return bytes;
      }
    },
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript(context, "src/core/constants.js");
  loadScript(context, "src/core/utils.js");
  loadScript(context, "src/core/state-model.js");
  loadScript(context, "src/bookmarks/bookmark-adapter.js");
  return context;
}

class FakeExtensionApi {
  constructor() {
    this.nextId = 10;
    this.calls = {
      create: 0,
      update: 0,
      move: 0
    };
    this.nodes = {
      "0": {
        id: "0",
        title: "",
        children: [
          {
            id: "1",
            title: "Bookmarks bar",
            children: []
          },
          {
            id: "2",
            title: "Other bookmarks",
            children: []
          }
        ]
      },
      "1": {
        id: "1",
        title: "Bookmarks bar",
        children: []
      },
      "2": {
        id: "2",
        title: "Other bookmarks",
        children: []
      }
    };
  }

  clone(node) {
    return JSON.parse(JSON.stringify(node));
  }

  async getTree() {
    return [this.clone(this.nodes["0"])];
  }

  async createBookmark(payload) {
    this.calls.create += 1;
    const parent = this.nodes[payload.parentId];
    if (!parent) throw new Error(`Parent ${payload.parentId} not found`);
    const index = payload.index == null ? parent.children.length : payload.index;
    if (index < 0 || index > parent.children.length) {
      throw new Error("Index out of bounds.");
    }
    const id = String(this.nextId++);
    const node = {
      id,
      title: payload.title || "",
      url: payload.url,
      children: payload.url ? undefined : []
    };
    this.nodes[id] = node;
    parent.children.splice(index, 0, node);
    return this.clone(node);
  }

  async updateBookmark(id, changes) {
    this.calls.update += 1;
    const node = this.nodes[id];
    if (!node) throw new Error(`Bookmark ${id} not found`);
    Object.assign(node, changes);
    return this.clone(node);
  }

  async moveBookmark(id, destination) {
    this.calls.move += 1;
    const node = this.nodes[id];
    const parent = this.nodes[destination.parentId];
    if (!node) throw new Error(`Bookmark ${id} not found`);
    if (!parent) throw new Error(`Parent ${destination.parentId} not found`);
    const destinationIndex = destination.index == null ? parent.children.length : destination.index;
    if (destinationIndex < 0 || destinationIndex > parent.children.length) {
      throw new Error("Index out of bounds.");
    }
    Object.values(this.nodes).forEach((candidate) => {
      if (!Array.isArray(candidate.children)) return;
      const index = candidate.children.findIndex((child) => child.id === id);
      if (index >= 0) candidate.children.splice(index, 1);
    });
    parent.children.splice(destination.index == null ? parent.children.length : destination.index, 0, node);
    return this.clone(node);
  }

  async removeBookmark() {}
  async removeBookmarkTree() {}
}

async function testStaleMappingRecreatesBookmark() {
  const context = createContext();
  const api = new FakeExtensionApi();
  const adapter = new context.QuietMarks.BookmarkAdapter(api);
  const state = {
    version: 1,
    updatedAt: "2026-06-30T00:00:00.000Z",
    lastWriter: "remote",
    roots: ["root:toolbar"],
    events: [],
    nodes: {
      "root:toolbar": {
        guid: "root:toolbar",
        type: "root",
        title: "Bookmarks bar",
        parentGuid: "",
        index: 0,
        deleted: false
      },
      "remote:bookmark": {
        guid: "remote:bookmark",
        type: "bookmark",
        title: "Remote Bookmark",
        url: "https://example.com/",
        parentGuid: "root:toolbar",
        index: 0,
        deleted: false
      }
    }
  };

  const result = await adapter.applyStateToLocal(
    {
      scope: "all",
      clientId: "local"
    },
    state,
    {
      "root:toolbar": "1",
      "remote:bookmark": "999"
    },
    {
      "1": "root:toolbar",
      "999": "remote:bookmark"
    }
  );

  const toolbar = api.nodes["1"];
  assert.strictEqual(toolbar.children.length, 1);
  assert.strictEqual(toolbar.children[0].title, "Remote Bookmark");
  assert.strictEqual(toolbar.children[0].url, "https://example.com/");
  assert.notStrictEqual(result.guidToId["remote:bookmark"], "999");
  assert.strictEqual(result.idToGuid["999"], undefined);
  assert.strictEqual(result.idToGuid[result.guidToId["remote:bookmark"]], "remote:bookmark");
}

async function testOutOfBoundsIndexFallsBackToParentEnd() {
  const context = createContext();
  const api = new FakeExtensionApi();
  const adapter = new context.QuietMarks.BookmarkAdapter(api);
  const state = {
    version: 1,
    updatedAt: "2026-06-30T00:00:00.000Z",
    lastWriter: "remote",
    roots: ["root:toolbar"],
    events: [],
    nodes: {
      "root:toolbar": {
        guid: "root:toolbar",
        type: "root",
        title: "Bookmarks bar",
        parentGuid: "",
        index: 0,
        deleted: false
      },
      "remote:folder": {
        guid: "remote:folder",
        type: "folder",
        title: "Chrome \u6d4f\u89c8\u5668\u540c\u6b65",
        parentGuid: "root:toolbar",
        index: 99,
        deleted: false
      }
    }
  };

  const result = await adapter.applyStateToLocal(
    {
      scope: "all",
      clientId: "local"
    },
    state,
    {
      "root:toolbar": "1"
    },
    {
      "1": "root:toolbar"
    }
  );

  const toolbar = api.nodes["1"];
  assert.strictEqual(toolbar.children.length, 1);
  assert.strictEqual(toolbar.children[0].title, "Chrome \u6d4f\u89c8\u5668\u540c\u6b65");
  assert.strictEqual(result.idToGuid[result.guidToId["remote:folder"]], "remote:folder");
}

async function testUnchangedExistingBookmarkIsSkipped() {
  const context = createContext();
  const api = new FakeExtensionApi();
  const existing = await api.createBookmark({
    parentId: "1",
    title: "Already synced",
    url: "https://example.com/"
  });
  api.calls.create = 0;
  api.calls.update = 0;
  api.calls.move = 0;

  const adapter = new context.QuietMarks.BookmarkAdapter(api);
  const state = {
    version: 1,
    updatedAt: "2026-06-30T00:00:00.000Z",
    lastWriter: "remote",
    roots: ["root:toolbar"],
    events: [],
    nodes: {
      "root:toolbar": {
        guid: "root:toolbar",
        type: "root",
        title: "Bookmarks bar",
        parentGuid: "",
        index: 0,
        deleted: false
      },
      "remote:bookmark": {
        guid: "remote:bookmark",
        type: "bookmark",
        title: "Already synced",
        url: "https://example.com/",
        parentGuid: "root:toolbar",
        index: 0,
        deleted: false
      }
    }
  };

  await adapter.applyStateToLocal(
    {
      scope: "all",
      clientId: "local"
    },
    state,
    {
      "root:toolbar": "1",
      "remote:bookmark": existing.id
    },
    {
      "1": "root:toolbar",
      [existing.id]: "remote:bookmark"
    },
    state
  );

  assert.strictEqual(api.calls.create, 0);
  assert.strictEqual(api.calls.update, 0);
  assert.strictEqual(api.calls.move, 0);
}

async function run() {
  await testStaleMappingRecreatesBookmark();
  await testOutOfBoundsIndexFallsBackToParentEnd();
  await testUnchangedExistingBookmarkIsSkipped();
  console.log("bookmark-adapter tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
