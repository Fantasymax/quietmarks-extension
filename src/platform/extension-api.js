(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};

  class ExtensionApi {
    constructor(api) {
      this.api = api;
      this.usesPromiseApi = typeof browser !== "undefined" && api === browser;
      this.storage = api.storage.local;
      this.bookmarksApi = api.bookmarks;
      this.alarmsApi = api.alarms;
      this.runtimeApi = api.runtime;
    }

    runtimeLastError() {
      return this.runtimeApi && this.runtimeApi.lastError ? this.runtimeApi.lastError : null;
    }

    call(fn, ...args) {
      if (this.usesPromiseApi) {
        try {
          const result = fn(...args);
          return result && typeof result.then === "function" ? result : Promise.resolve(result);
        } catch (error) {
          return Promise.reject(error);
        }
      }

      return new Promise((resolve, reject) => {
        try {
          const result = fn(...args, (...callbackArgs) => {
            const lastError = this.runtimeLastError();
            if (lastError) {
              reject(new Error(lastError.message));
              return;
            }
            resolve(callbackArgs.length <= 1 ? callbackArgs[0] : callbackArgs);
          });

          if (result && typeof result.then === "function") {
            result.then(resolve, reject);
          }
        } catch (error) {
          reject(error);
        }
      });
    }

    storageGet(defaults) {
      return this.call(this.storage.get.bind(this.storage), defaults);
    }

    storageSet(values) {
      return this.call(this.storage.set.bind(this.storage), values);
    }

    getTree() {
      return this.call(this.bookmarksApi.getTree.bind(this.bookmarksApi));
    }

    createBookmark(node) {
      return this.call(this.bookmarksApi.create.bind(this.bookmarksApi), node);
    }

    updateBookmark(id, changes) {
      return this.call(this.bookmarksApi.update.bind(this.bookmarksApi), id, changes);
    }

    moveBookmark(id, destination) {
      return this.call(this.bookmarksApi.move.bind(this.bookmarksApi), id, destination);
    }

    removeBookmark(id) {
      return this.call(this.bookmarksApi.remove.bind(this.bookmarksApi), id);
    }

    removeBookmarkTree(id) {
      return this.call(this.bookmarksApi.removeTree.bind(this.bookmarksApi), id);
    }

    createAlarm(name, info) {
      return this.alarmsApi.create(name, info);
    }

    clearAlarm(name) {
      return this.call(this.alarmsApi.clear.bind(this.alarmsApi), name);
    }
  }

  QuietMarks.ExtensionApi = ExtensionApi;
})(globalThis);
