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
  const running = service.runtimeStatus();
  assert.strictEqual(running.inFlight, true);
  assert(running.active.startedAt);
  assert.strictEqual(running.active.reason, "manual");
  const queued = await service.run("manual");
  assert.strictEqual(queued.ok, false);
  assert.strictEqual(queued.queued, true);
  assert.match(queued.error, /already running/i);
  service.pendingSync = false;
  releaseFetch();
  await firstRun;
  assert.strictEqual(service.runtimeStatus().inFlight, false);
}

async function testStartReturnsBeforeWebDavFinishes() {
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

  const started = await service.start("manual");
  assert.strictEqual(started.ok, true);
  assert.strictEqual(started.started, true);
  assert.strictEqual(service.runtimeStatus().inFlight, true);
  for (let index = 0; index < 10 && !releaseFetch; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const queued = await service.start("manual");
  assert.strictEqual(queued.ok, false);
  assert.strictEqual(queued.queued, true);
  service.pendingSync = false;
  releaseFetch();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(service.runtimeStatus().inFlight, false);
}

async function testKeepAliveHooksWrapActiveSync() {
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
  const calls = {
    start: 0,
    stop: 0
  };
  const service = new context.QuietMarks.SyncService({
    stateStore: {
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
    },
    remoteStore: {
      async fetchState() {
        return {
          state: blankState,
          etag: "etag",
          exists: true
        };
      },
      async putState() {
        return "etag2";
      }
    },
    bookmarkAdapter: {
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
    },
    mergeEngine: {
      mergeStates() {
        return {
          state: blankState,
          conflicts: []
        };
      }
    },
    async onKeepAliveStart() {
      calls.start += 1;
    },
    async onKeepAliveStop() {
      calls.stop += 1;
    }
  });

  const result = await service.run("manual");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.start, 1);
  assert.strictEqual(calls.stop, 1);
}

async function testPersistedRunningJobCanBeResumed() {
  const context = createContext();
  const blankState = context.QuietMarks.StateModel.blankState("local");
  let config = {
    enabled: true,
    webdavUrl: "https://example.com/dav",
    remoteFile: "QuietMarks/state.json",
    clientId: "local",
    intervalMinutes: 10,
    conflictPolicy: "merge",
    scope: "all",
    lastSyncStatus: "Syncing",
    lastSyncError: "Fetching WebDAV sync state...",
    lastStats: {
      localNodes: 0,
      remoteNodes: 0,
      mergedNodes: 0,
      conflicts: 0
    }
  };
  const freshAt = new Date().toISOString();
  let syncJob = {
    id: "sync-old",
    status: "running",
    reason: "manual",
    phase: "Fetching WebDAV sync state...",
    startedAt: freshAt,
    updatedAt: freshAt,
    finishedAt: "",
    error: ""
  };
  let releaseFetch;
  const savedJobs = [];
  const stateStore = {
    async get() {
      return {
        config,
        baseState: blankState,
        idToGuid: {},
        guidToId: {},
        syncJob
      };
    },
    async saveConfig(nextConfig) {
      config = nextConfig;
      return nextConfig;
    },
    async saveSnapshot() {},
    async saveJob(nextJob) {
      syncJob = nextJob;
      savedJobs.push(nextJob);
    }
  };
  const service = new context.QuietMarks.SyncService({
    stateStore,
    remoteStore: {
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
    },
    bookmarkAdapter: {
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
    },
    mergeEngine: {
      mergeStates() {
        return {
          state: blankState,
          conflicts: []
        };
      }
    }
  });

  const recoverable = service.runtimeStatus(syncJob);
  assert.strictEqual(recoverable.inFlight, true);
  assert.strictEqual(recoverable.recoverable, true);

  const recovery = await service.resumeIfNeeded(await stateStore.get());
  assert.strictEqual(recovery.resumed, true);
  assert.strictEqual(recovery.sync.inFlight, true);
  assert.strictEqual(recovery.sync.active.reason, "resume");
  assert.strictEqual(savedJobs[0].status, "running");
  assert.strictEqual(savedJobs[0].reason, "resume");

  for (let index = 0; index < 10 && !releaseFetch; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  releaseFetch();
  for (let index = 0; index < 20 && service.runtimeStatus().inFlight; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.strictEqual(service.runtimeStatus().inFlight, false);
  assert.strictEqual(syncJob.status, "done");
  assert.strictEqual(syncJob.phase, "Synced");
  assert.strictEqual(config.lastSyncStatus, "Synced");
}

async function testLegacyInterruptedErrorAutoResumes() {
  const context = createContext();
  const blankState = context.QuietMarks.StateModel.blankState("local");
  let config = {
    enabled: true,
    webdavUrl: "https://example.com/dav",
    remoteFile: "QuietMarks/state.json",
    clientId: "local",
    intervalMinutes: 10,
    conflictPolicy: "merge",
    scope: "all",
    lastSyncStatus: "Error",
    lastSyncError: "Previous sync was interrupted. Start sync again.",
    lastStats: {
      localNodes: 0,
      remoteNodes: 0,
      mergedNodes: 0,
      conflicts: 0
    }
  };
  let syncJob = null;
  const stateStore = {
    async get() {
      return {
        config,
        baseState: blankState,
        idToGuid: {},
        guidToId: {},
        syncJob
      };
    },
    async saveConfig(nextConfig) {
      config = nextConfig;
      return nextConfig;
    },
    async saveSnapshot() {},
    async saveJob(nextJob) {
      syncJob = nextJob;
    }
  };
  const service = new context.QuietMarks.SyncService({
    stateStore,
    remoteStore: {
      async fetchState() {
        return {
          state: blankState,
          etag: "etag",
          exists: true
        };
      },
      async putState() {
        return "etag2";
      }
    },
    bookmarkAdapter: {
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
    },
    mergeEngine: {
      mergeStates() {
        return {
          state: blankState,
          conflicts: []
        };
      }
    }
  });

  const recovery = await service.resumeIfNeeded(await stateStore.get());
  assert.strictEqual(recovery.resumed, true);
  assert.strictEqual(recovery.sync.active.reason, "resume");

  for (let index = 0; index < 20 && service.runtimeStatus().inFlight; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.strictEqual(config.lastSyncStatus, "Synced");
  assert.strictEqual(syncJob.status, "done");
}

async function testStaleFetchJobStopsInsteadOfLoopingForever() {
  const context = createContext();
  const blankState = context.QuietMarks.StateModel.blankState("local");
  let config = {
    enabled: true,
    webdavUrl: "https://example.com/dav",
    remoteFile: "QuietMarks/state.json",
    clientId: "local",
    intervalMinutes: 10,
    conflictPolicy: "merge",
    scope: "all",
    lastSyncStatus: "Syncing",
    lastSyncError: "Fetching WebDAV sync state...",
    lastStats: {
      localNodes: 0,
      remoteNodes: 0,
      mergedNodes: 0,
      conflicts: 0
    }
  };
  let syncJob = {
    id: "sync-stale",
    status: "running",
    reason: "manual",
    phase: "Fetching WebDAV sync state...",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "",
    error: ""
  };
  const stateStore = {
    async get() {
      return {
        config,
        baseState: blankState,
        idToGuid: {},
        guidToId: {},
        syncJob
      };
    },
    async saveConfig(nextConfig) {
      config = nextConfig;
      return nextConfig;
    },
    async saveSnapshot() {},
    async saveJob(nextJob) {
      syncJob = nextJob;
    }
  };
  const service = new context.QuietMarks.SyncService({
    stateStore,
    remoteStore: {
      async fetchState() {
        throw new Error("stale job should not start a new fetch");
      },
      async putState() {}
    },
    bookmarkAdapter: {
      async scanLocal() {
        throw new Error("stale job should not scan bookmarks");
      },
      async applyStateToLocal() {}
    },
    mergeEngine: {
      mergeStates() {
        throw new Error("stale job should not merge");
      }
    }
  });

  const recovery = await service.resumeIfNeeded(await stateStore.get());
  assert.strictEqual(recovery.resumed, false);
  assert.strictEqual(recovery.updated, true);
  assert.strictEqual(config.lastSyncStatus, "Error");
  assert.match(config.lastSyncError, /did not finish after 90 seconds/);
  assert.strictEqual(syncJob.status, "error");
  assert.strictEqual(syncJob.phase, "Sync stalled");
}

async function run() {
  await testApplyFailureDoesNotSaveSnapshotOrRemote();
  await testVerificationFailureDoesNotSaveSnapshotOrRemote();
  await testConcurrentSyncReturnsReadableQueuedError();
  await testStartReturnsBeforeWebDavFinishes();
  await testKeepAliveHooksWrapActiveSync();
  await testPersistedRunningJobCanBeResumed();
  await testLegacyInterruptedErrorAutoResumes();
  await testStaleFetchJobStopsInsteadOfLoopingForever();
  console.log("sync-service tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
