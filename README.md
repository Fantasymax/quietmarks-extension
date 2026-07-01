# QuietMarks

QuietMarks is a lightweight browser extension for private bookmark sync through a user-owned WebDAV endpoint. It targets Chromium-based browsers first, including Chrome, Edge, Opera, and profile-based Chromium environments.

The project is an early prototype. Export your bookmarks before using it on an important browser profile.

## Features

- Syncs bookmarks through a single WebDAV JSON state file.
- Uses three-way merge: last synced base, current local bookmarks, and current remote bookmarks.
- Supports automatic background sync on bookmark changes and periodic alarms.
- Supports optional AES-GCM encryption of the remote bookmark payload with a passphrase.
- Uses stable local GUID mappings so different browser bookmark IDs can converge.
- Avoids WebDAV move/rename operations for better compatibility with common providers.
- Includes a WebDAV write test before syncing.
- Verifies the native browser bookmark tree after applying a merged state, so apply failures are reported instead of being treated as a successful sync.

## Current Status

- Chrome / Chromium MV3 package: active prototype.
- Edge / Opera: expected to work through Chromium extension support.
- Firefox: code is structured for compatibility, but a dedicated Firefox package/signing flow still needs testing.

## Changelog

- `0.1.11`: Adds WebDAV request timeouts and clearer messaging when another sync is already running.
- `0.1.10`: Uses static WebDAV host permissions and restores the sync button state when pre-sync setup fails.
- `0.1.9`: Clamps bookmark move indexes against the live browser bookmark tree before calling the browser API.
- `0.1.8`: Falls back to placing bookmarks at the end of the parent folder when a browser rejects a remote bookmark index as out of bounds.
- `0.1.7`: Verifies the native browser bookmark tree after applying merged state and reports applied/missing counts.

## Install For Local Testing

1. Clone or download this repository.
2. Open `chrome://extensions` or the equivalent extension page in your browser.
3. Enable Developer mode.
4. Click `Load unpacked`.
5. Select the repository folder that contains `manifest.json`.

Chrome generally does not permanently install arbitrary local ZIP files by double-clicking them. For local development, use `Load unpacked`.

## Setup

1. Click the QuietMarks toolbar button.
2. Enter your WebDAV root URL, for example `https://example.com/dav`.
3. Enter a sync file path, for example `QuietMarks/state.json`.
4. Enter your WebDAV username and app password.
5. Set an encryption passphrase if you want the remote payload encrypted at rest.
6. Choose a bookmark location:
   - `Use native bookmark bar/menu`: sync directly into the normal browser bookmark hierarchy.
   - `Use a dedicated folder`: keep synced bookmarks inside one named folder.
7. Keep conflict handling on `Auto merge safely` unless you are doing recovery.
8. Press `Test WebDAV`.
9. Press `Save`.
10. Press `Sync now`.

The sync file path must include a file name. Use `QuietMarks/state.json`, not just `QuietMarks`.

## Conflict Behavior

QuietMarks is conservative by default:

- Changes made on only one side are kept.
- If both sides edit the same item, the newer observed change wins.
- If one side deletes an item while the other edits it, the edited item wins.
- Obvious duplicate bookmarks created independently may be merged when URL/title/path matching is confident.
- Unmatched independent creations remain separate.

The UI currently reports conflict counts. A detailed conflict history/review screen is planned.

## Status Details

QuietMarks reports the last sync result with local, cloud, merged, applied, missing, and conflict counts. In normal operation, `missing` should stay at `0`. If it is greater than `0`, the WebDAV state was read and merged, but one or more merged bookmarks were not visible in the browser bookmark tree after apply.

## Build Package

Generate a ZIP package:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
```

Generate a CRX when Chrome or Edge is available:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -Crx -ChromePath "C:\Path\to\chrome.exe"
```

## Development Checks

Run JavaScript syntax checks:

```powershell
Get-ChildItem -Recurse -Filter *.js .\src | ForEach-Object { node --check $_.FullName }
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

Run the focused Node tests:

```powershell
node .\tests\bookmark-adapter.test.js
node .\tests\sync-service.test.js
```

## Privacy Notes

QuietMarks stores extension settings locally in browser extension storage. WebDAV credentials and the optional encryption passphrase are currently stored there as part of this prototype. For higher assurance, use browser/profile protections and consider a future native integration with an encrypted local vault.

When a passphrase is set, bookmark payloads written to WebDAV are encrypted with AES-GCM. Metadata required for decryption, such as salt and IV, remains in the remote envelope.

## Roadmap

- Add detailed diagnostics and conflict history.
- Add more focused tests for merge behavior.
- Improve duplicate detection for independently created same-URL bookmarks.
- Add a first-run backup reminder or helper.
- Prepare a dedicated Firefox package.
- Move credentials to stronger local secret storage where platform APIs are available.
