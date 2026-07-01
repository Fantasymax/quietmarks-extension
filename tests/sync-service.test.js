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
    navigator: {
      userAgent: "Chromium"
    },
    setTimeout,
    clearTimeout,
    globalThis: null,
    crypto: {
      getRandomValues(bytes) {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1;
        return bytes;
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript(context, "src/core/constants.js");
  loadScript(context, "src/core/utils.js");
  loadScript(context, "src/core/state-model.js");
  loadScript(context, "src/sync/sync-service.js");
  return context;
}

async function testApplyFailureDoesNotSaveSnapshotOrRemote() {
  const context = createContext();
  const blankState = context.QuietMarks.StateModel.blankState("local");
  const calls = {
    putState: 0,
    saveSnapshot: 0,
    savedStatuses: []
  };
  const config = {
    enabled: true,
    webdavUrl: "https://example.com/dav",
    remoteFile: "QuietMarks/state.json",
    clientId: "local",
    intervalMinutes: 10,
    conflictPolicy: "merge",
    scope: "all",
    lastStats: {
      localNodes: 0,
      remoteNodes: 0,
      mergedNodes: 0,
      conflicts: 0
    }
  };
  const stateStore = {
    async get() {
      return {
        config,
        baseState: blankState,
        idToGuid: {},
        guidToId: {}
      };
    },
    async saveConfig(nextConfig) {
      calls.savedStatuses.push({
        status: nextConfig.lastSyncStatus,
        error: nextConfig.lastSyncError
      });
      return nextConfig;
    },
    async saveSnapshot() {
      calls.saveSnapshot += 1;
    }
  };
  const remoteStore = {
    async fetchState() {
      return {
        state: blankState,
        etag: "etag",
        exists: true
      };
    },
    async putState() {
      calls.putState += 1;
    }
  };
  const bookmarkAdapter = {
    async scanLocal() {
      return {
        state: blankState,
        idToGuid: {},
        guidToId: {}
      };
    },
    async applyStateToLocal() {
      throw new Error("Failed to create browser bookmark");
    }
  };
  const mergeEngine = {
    mergeStates() {
      return {
        state: blankState,
        conflicts: []
      };
    }
  };

  const service = new context.QuietMarks.SyncService({
    stateStore,
    remoteStore,
    bookmarkAdapter,
    mergeEngine
  });
  const result = await service.run("manual");

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /Failed to create browser bookmark/);
  assert.strictEqual(calls.putState, 0);
  assert.strictEqual(calls.saveSnapshot, 0);
  assert.strictEqual(calls.savedStatuses.at(-1).status, "Error");
}

async function testVerificationFailureDoesNotSaveSnapshotOrRemote() {
  const context = createContext();
  const blankState = context.QuietMarks.StateModel.blankState("local");
  const mergedState = {
    ...blankState,
    nodes: {
      "root:toolbar": {
        guid: "root:toolbar",
        type: "root",
        title: "Bookmarks bar",
        parentGuid: "",
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
  const calls = {
    scanLocal: 0,
    putState: 0,
    saveSnapshot: 0,
    savedStatuses: []
  };
  const config = {
    enabled: true,
    webdavUrl: "https://example.com/dav",
    remoteFile: "QuietMarks/state.json",
    clientId: "local",
    intervalMinutes: 10,
    conflictPolicy: "merge",
    scope: "all",
    lastStats: {
      localNodes: 0,
      remoteNodes: 0,
      mergedNodes: 0,
      conflicts: 0
    }
  };
  const stateStore = {
    async get() {
      return {
        config,
        baseState: blankState,
        idToGuid: {},
        guidToId: {}
      };
    },
    async saveConfig(nextConfig) {
      calls.savedStatuses.push({
        status: nextConfig.lastSyncStatus,
        error: nextConfig.lastSyncError
      });
      return nextConfig;
    },
    async saveSnapshot() {
      calls.saveSnapshot += 1;
    }
  };
  const remoteStore = {
    async fetchState() {
      return {
        state: mergedState,
        etag: "etag",
        exists: true
      };
    },
    async putState() {
      calls.putState += 1;
    }
  };
  const bookmarkAdapter = {
    async scanLocal() {
      calls.scanLocal += 1;
      return {
        state: blankState,
        idToGuid: {},
        guidToId: {}
      };
    },
    async applyStateToLocal() {
      return {
        idToGuid: {},
        guidToId: {}
      };
    }
  };
  const mergeEngine = {
    mergeStates() {
      return {
        state: mergedState,
        conflicts: []
      };
    }
  };

  const service = new context.QuietMarks.SyncService({
    stateStore,
    remoteStore,
    bookmarkAdapter,
    mergeEngine
  });
  const result = await service.run("manual");

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /verification failed/i);
  assert.strictEqual(calls.scanLocal, 2);
  assert.strictEqual(calls.putState, 0);
  assert.strictEqual(calls.saveSnapshot, 0);
  assert.strictEqual(calls.savedStatuses.at(-1).status, "Error");
}

async function testConcurrentSyncReturnsReadableQueuedError() {
  const context = createContext();
  const blankState = context.QuietMarks.StateModel.blankState("local");
  const config = {
    enabled: true,
    webdavUrl: "https://example.com/dav",
    remoteFile: "QuietMarks/state.json",
    clientId: "local",
    intervalMinutes: 10,
    conflictPolicy: "merge",
    scope: "all",
    lastStats: {
      localNodes: 0,
      remoteNodes: 0,
      mergedNodes: 0,
      conflicts: 0
    }
  };
  let releaseFetch;
  const stateStore = {
    async get() {
      return {
        config,
        baseState: blankState,
        idToGuid: {},
        guidToId: {}
      };
    },
    async saveConfig(nextConfig) {
      return nextConfig;
    },
    async saveSnapshot() {}
  };
  const remoteStore = {
    async fetchState() {
      await new Promise((resolve) => {
        releaseFetch = resolve;
      });
      return {
        state: blankState,
        etag: "etag",
        exists: true
      };
    },
    async putState() {
      return "etag2";
    }
  };
  const bookmarkAdapter = {
    async scanLocal() {
      return {
        state: blankState,
        idToGuid: {},
        guidToId: {}
      };
    },
    async applyStateToLocal() {
      return {
        idToGuid: {},
        guidToId: {}
      };
    }
  };
  const mergeEngine = {
    mergeStates() {
      return {
        state: blankState,
        conflicts: []
      };
    }
  };
  const service = new context.QuietMarks.SyncService({
    stateStore,
    remoteStore,
    bookmarkAdapter,
    mergeEngine
  });

  const firstRun = service.run("manual");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queued = await service.run("manual");
  assert.strictEqual(queued.ok, false);
  assert.strictEqual(queued.queued, true);
  assert.match(queued.error, /already running/i);
  service.pendingSync = false;
  releaseFetch();
  await firstRun;
}

async function run() {
  await testApplyFailureDoesNotSaveSnapshotOrRemote();
  await testVerificationFailureDoesNotSaveSnapshotOrRemote();
  await testConcurrentSyncReturnsReadableQueuedError();
  console.log("sync-service tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
