(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};
  const { DEFAULT_CONFIG } = QuietMarks.Constants;
  const { randomId } = QuietMarks.Utils;
  const { normalizeState, blankState } = QuietMarks.StateModel;

  class SyncStateStore {
    constructor(extensionApi) {
      this.extensionApi = extensionApi;
    }

    async get() {
      const stored = await this.extensionApi.storageGet({
        quietmarksConfig: DEFAULT_CONFIG,
        quietmarksBaseState: null,
        quietmarksIdToGuid: {},
        quietmarksGuidToId: {},
        quietmarksSyncJob: null
      });
      const config = {
        ...DEFAULT_CONFIG,
        ...(stored.quietmarksConfig || {})
      };

      if (!config.clientId) {
        config.clientId = `client-${randomId()}`;
        await this.saveConfig(config);
      }

      return {
        config,
        baseState: normalizeState(stored.quietmarksBaseState, config.clientId),
        idToGuid: stored.quietmarksIdToGuid || {},
        guidToId: stored.quietmarksGuidToId || {},
        syncJob: stored.quietmarksSyncJob || null
      };
    }

    async saveConfig(config) {
      await this.extensionApi.storageSet({
        quietmarksConfig: {
          ...DEFAULT_CONFIG,
          ...config
        }
      });
    }

    async saveSnapshot(state, idToGuid, guidToId) {
      await this.extensionApi.storageSet({
        quietmarksBaseState: state,
        quietmarksIdToGuid: idToGuid,
        quietmarksGuidToId: guidToId
      });
    }

    async saveMappings(idToGuid, guidToId) {
      await this.extensionApi.storageSet({
        quietmarksIdToGuid: idToGuid,
        quietmarksGuidToId: guidToId
      });
    }

    async saveJob(job) {
      await this.extensionApi.storageSet({
        quietmarksSyncJob: job || null
      });
    }

    async resetLocalBase(clientId) {
      await this.extensionApi.storageSet({
        quietmarksBaseState: blankState(clientId),
        quietmarksIdToGuid: {},
        quietmarksGuidToId: {}
      });
    }
  }

  QuietMarks.SyncStateStore = SyncStateStore;
})(globalThis);
