# QuietMarks Privacy Policy

QuietMarks is designed for private bookmark sync through a WebDAV endpoint chosen by the user.

## Data Processed

QuietMarks reads and writes browser bookmarks so it can synchronize bookmark folders and bookmark entries across browsers.

QuietMarks stores these settings in browser extension local storage:

- WebDAV root URL
- WebDAV username
- WebDAV app password
- Optional encryption passphrase
- Sync file path
- Sync preferences
- Local bookmark identifier mappings
- Last synced bookmark state

QuietMarks writes bookmark sync data to the WebDAV file selected by the user. By default, that file path is `QuietMarks/state.json`.

## Remote Sync

QuietMarks does not operate a server. Sync traffic goes directly from the browser to the user-provided WebDAV endpoint.

When an encryption passphrase is set, QuietMarks encrypts the bookmark payload before writing it to WebDAV using AES-GCM. The WebDAV file still contains metadata needed to decrypt the payload, such as salt and IV.

If no encryption passphrase is set, bookmark titles and URLs are stored in the WebDAV sync file as readable JSON.

## Data Sharing

QuietMarks does not sell user data.

QuietMarks does not send bookmark data, credentials, analytics, or telemetry to the developer.

Data is shared only with the WebDAV service configured by the user, because that service stores the sync file.

## Permissions

QuietMarks requests bookmark access so it can read and update browser bookmarks.

QuietMarks requests storage access so it can save settings, local sync state, and bookmark identifier mappings.

QuietMarks requests alarm access so it can run automatic background sync.

QuietMarks requests host access so it can reach the WebDAV endpoint entered by the user. It uses host access only for WebDAV sync requests.

## User Control

Users can disable automatic sync in the extension settings.

Users can remove local QuietMarks data by uninstalling the extension or clearing extension storage from the browser.

Users can remove remote QuietMarks data by deleting the configured WebDAV sync file.
