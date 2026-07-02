(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};
  const { blankState, normalizeState, cleanRemoteFile } = QuietMarks.StateModel;
  const { WEBDAV_TIMEOUT_MS, WEBDAV_PUT_TIMEOUT_MS } = QuietMarks.Constants;

  class WebDavStore {
    constructor(cryptoCodec, options) {
      this.cryptoCodec = cryptoCodec;
      this.fetchImpl = options && options.fetchImpl ? options.fetchImpl : fetch;
    }

    requestHeaders(config, extras) {
      const headers = new Headers(extras || {});
      if (config.username || config.password) {
        headers.set("Authorization", `Basic ${btoa(`${config.username}:${config.password}`)}`);
      }
      return headers;
    }

    jsonHeaders(config) {
      return this.requestHeaders(config, {
        "Content-Type": "application/json; charset=utf-8"
      });
    }

    async withTimeout(promise, label, timeoutMs, controller) {
      const timeout = timeoutMs || WEBDAV_TIMEOUT_MS;
      let timeoutId = null;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              if (controller) controller.abort();
              reject(new Error(`WebDAV ${label} timed out after ${Math.round(timeout / 1000)} seconds.`));
            }, timeout);
          })
        ]);
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw new Error(`WebDAV ${label} timed out after ${Math.round(timeout / 1000)} seconds.`);
        }
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    async fetchWithTimeout(url, options, label, timeoutMs) {
      const timeout = timeoutMs || WEBDAV_TIMEOUT_MS;
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      return this.withTimeout(
        this.fetchImpl(url, {
          ...(options || {}),
          quietmarksTimeoutMs: timeout,
          signal: controller ? controller.signal : undefined
        }),
        label,
        timeout,
        controller
      );
    }

    remoteBaseUrl(config) {
      return String(config.webdavUrl || "").trim().replace(/\/+$/, "");
    }

    remoteFileUrl(config) {
      const base = this.remoteBaseUrl(config);
      const file = cleanRemoteFile(config);
      return `${base}/${file.split("/").map(encodeURIComponent).join("/")}`;
    }

    joinWebDavUrl(base, parts) {
      return `${base}/${parts.map(encodeURIComponent).join("/")}`;
    }

    collectionUrl(url) {
      return `${String(url || "").replace(/\/+$/, "")}/`;
    }

    syncFolderParts(config) {
      const parts = cleanRemoteFile(config).split("/").filter(Boolean);
      parts.pop();
      return parts;
    }

    async ensureRemoteFolders(config) {
      const base = this.remoteBaseUrl(config);
      const parts = this.syncFolderParts(config);

      for (let index = 0; index < parts.length; index += 1) {
        const url = this.collectionUrl(this.joinWebDavUrl(base, parts.slice(0, index + 1)));
        await this.ensureFolderUrl(config, url, parts[index]);
      }
    }

    async folderExists(config, url, label) {
      const response = await this.fetchWithTimeout(url, {
        method: "PROPFIND",
        headers: this.requestHeaders(config, {
          "Depth": "0",
          "Content-Type": "application/xml; charset=utf-8"
        }),
        body: "<?xml version=\"1.0\" encoding=\"utf-8\"?><D:propfind xmlns:D=\"DAV:\"><D:prop><D:resourcetype/></D:prop></D:propfind>"
      }, "PROPFIND");

      if (response.ok) return true;
      if (response.status === 404) return false;

      if (response.status === 401 || response.status === 403) {
        throw new Error(`WebDAV cannot read ${label} (${response.status}). Check the WebDAV URL, username, and app password.`);
      }

      throw new Error(`WebDAV PROPFIND failed ${response.status} at ${label}`);
    }

    async ensureFolderUrl(config, url, label) {
      if (await this.folderExists(config, url, label)) return;

      const response = await this.fetchWithTimeout(url, {
        method: "MKCOL",
        headers: this.requestHeaders(config)
      }, "MKCOL");

      if ([201, 405].includes(response.status)) return;

      if (response.status === 404) {
        throw new Error(`WebDAV folder not found: ${label}. Create its parent folder first or use an existing WebDAV folder.`);
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(`WebDAV cannot create folder ${label} (${response.status}). Create it manually or choose an existing WebDAV folder.`);
      }

      if (response.status === 409) {
        throw new Error(`WebDAV parent folder is missing for ${label}. Create its parent folder first or use a path like QuietMarks/state.json.`);
      }

      throw new Error(`WebDAV MKCOL failed ${response.status} at ${label}`);
    }

    async testConnection(config) {
      await this.ensureRemoteFolders(config);

      const base = this.remoteBaseUrl(config);
      const folderParts = this.syncFolderParts(config);
      const syncFolderUrl = folderParts.length
        ? this.collectionUrl(this.joinWebDavUrl(base, folderParts))
        : this.collectionUrl(base);
      const syncFolderLabel = folderParts.length ? folderParts.join("/") : "WebDAV root";

      if (!(await this.folderExists(config, syncFolderUrl, syncFolderLabel))) {
        throw new Error(`WebDAV folder not found: ${syncFolderLabel}.`);
      }

      const probeName = `quietmarks-write-test-${Date.now()}.json`;
      const probeUrl = this.joinWebDavUrl(base, folderParts.concat(probeName));
      let wroteProbe = false;

      try {
        const response = await this.fetchWithTimeout(probeUrl, {
          method: "PUT",
          headers: this.jsonHeaders(config),
          body: JSON.stringify({
            ok: true,
            at: new Date().toISOString()
          })
        }, "write test");

        if (![200, 201, 204].includes(response.status)) {
          if (response.status === 401 || response.status === 403) {
            throw new Error(`WebDAV login works but ${syncFolderLabel} is not writable (${response.status}). Check folder permissions and app-password WebDAV access.`);
          }
          if (response.status === 404) {
            throw new Error(`WebDAV folder not found: ${syncFolderLabel}. Use a sync file path like QuietMarks/state.json.`);
          }
          throw new Error(`WebDAV write test failed ${response.status}`);
        }

        wroteProbe = true;
        return {
          ok: true,
          message: `WebDAV is writable. QuietMarks will sync to ${cleanRemoteFile(config)}.`
        };
      } finally {
        if (wroteProbe) {
          await this.fetchWithTimeout(probeUrl, {
            method: "DELETE",
            headers: this.requestHeaders(config)
          }, "cleanup").catch(() => {});
        }
      }
    }

    async fetchState(config) {
      const response = await this.fetchWithTimeout(this.remoteFileUrl(config), {
        method: "GET",
        headers: this.requestHeaders(config),
        cache: "no-store"
      }, "GET");

      if (response.status === 404) {
        return {
          state: blankState(config.clientId),
          etag: null,
          exists: false
        };
      }

      if (!response.ok) {
        throw new Error(`WebDAV GET failed ${response.status}`);
      }

      const etag = response.headers.get("ETag");
      const envelope = await this.withTimeout(response.json(), "GET body", WEBDAV_TIMEOUT_MS);
      return {
        state: normalizeState(await this.cryptoCodec.decryptState(envelope, config.passphrase), config.clientId),
        etag,
        exists: true
      };
    }

    async putState(config, state, etag, exists) {
      await this.ensureRemoteFolders(config);
      const envelope = await this.cryptoCodec.encryptState(state, config.passphrase);
      const headers = this.jsonHeaders(config);
      if (etag) {
        headers.set("If-Match", etag);
      } else if (!exists) {
        headers.set("If-None-Match", "*");
      }

      const response = await this.fetchWithTimeout(this.remoteFileUrl(config), {
        method: "PUT",
        headers,
        body: JSON.stringify(envelope)
      }, "PUT", WEBDAV_PUT_TIMEOUT_MS);

      if ([409, 412].includes(response.status)) {
        const conflict = new Error(`Remote changed during sync (${response.status})`);
        conflict.retryable = true;
        throw conflict;
      }

      if (!response.ok && response.status !== 201 && response.status !== 204) {
        if (response.status === 404) {
          throw new Error("WebDAV target folder was not found. Use an existing WebDAV folder or set State file to a path like QuietMarks/state.json.");
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error(`WebDAV cannot write ${cleanRemoteFile(config)} (${response.status}). Check that Sync file path includes a file name, for example QuietMarks/state.json.`);
        }
        if (response.status === 405) {
          throw new Error("WebDAV refused the write. Sync file path must be a file such as QuietMarks/state.json, not just a folder name.");
        }
        throw new Error(`WebDAV PUT failed ${response.status}`);
      }

      return response.headers.get("ETag");
    }
  }

  QuietMarks.WebDavStore = WebDavStore;
})(globalThis);
