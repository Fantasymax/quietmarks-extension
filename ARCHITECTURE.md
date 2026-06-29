# QuietMarks Architecture

QuietMarks is split into small replaceable layers so the sync model can be tested independently from the browser-extension UI.

## Layers

| Layer | Files | Responsibility |
|---|---|---|
| Bootstrap | `src/background.js` | Extension event listeners, alarms, message routing, dependency wiring |
| Core model | `src/core/*.js` | Constants, utility helpers, state normalization, encryption codec |
| Platform adapter | `src/platform/extension-api.js` | Chrome callback API / Firefox promise API normalization |
| Local state store | `src/storage/sync-state-store.js` | Extension local storage, config, base state, GUID maps |
| Remote store | `src/remote/webdav-store.js` | WebDAV GET/PUT/PROPFIND/MKCOL, ETag conditional writes, encrypted payload codec |
| Bookmark adapter | `src/bookmarks/bookmark-adapter.js` | Browser bookmark tree scan/apply, root detection, GUID mapping |
| Merge engine | `src/sync/merge-engine.js` | Pure state merge and conflict policy |
| Sync service | `src/sync/sync-service.js` | End-to-end sync orchestration and retry loop |
| UI | `src/popup.*`, `src/options.html`, `src/ui.css` | Popup/settings interface |

## Sync Flow

1. `background.js` receives a manual sync, alarm, startup, or bookmark-change event.
2. `SyncService` loads config/base state from `SyncStateStore`.
3. `WebDavStore` fetches the remote state and decrypts it when needed.
4. `BookmarkAdapter` scans browser bookmarks into QuietMarks' portable state model.
5. `MergeEngine` merges base/local/remote states and reports conflicts.
6. `BookmarkAdapter` applies the merged state back to the browser.
7. `WebDavStore` writes the merged state with `If-Match` or `If-None-Match`.
8. If WebDAV returns `409` or `412`, `SyncService` refetches and retries the merge.
9. `SyncStateStore` saves the new base state and local GUID mappings.

## Packaging

The extension intentionally avoids a JavaScript build step for now. Modules attach to `globalThis.QuietMarks` and are loaded by `importScripts` from the MV3 service worker.
