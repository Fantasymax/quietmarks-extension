# Chrome Web Store Listing Draft

Use this draft when creating the Chrome Web Store listing for QuietMarks.

## Package

- Upload ZIP: `dist/quietmarks-extension-v0.1.17.zip`
- Small promotional tile: `dist/store-assets/promo-440x280.png`
- Screenshot: `dist/store-assets/screenshot-1280x800.png`
- Privacy policy file in repository: `PRIVACY.md`

## Store Listing

Name:

QuietMarks

Summary:

Private bookmark sync through your own WebDAV storage.

Detailed description:

QuietMarks is a lightweight bookmark sync extension for users who want to keep browser bookmarks synchronized through a WebDAV location they control.

It syncs bookmarks through a single WebDAV JSON state file, supports optional AES-GCM encryption with a passphrase, and uses a three-way merge model to keep local and remote changes together.

QuietMarks can sync directly into the browser's native bookmark hierarchy or into a dedicated folder. It also verifies the browser bookmark tree after applying a merged state, so failed bookmark writes are reported instead of being treated as a successful sync.

Current features:

- WebDAV sync using a user-provided endpoint
- Optional encrypted remote bookmark payload
- Automatic background sync on bookmark changes
- Periodic sync using browser alarms
- Safe three-way merge for local and remote changes
- Recovery modes to prefer this browser or the WebDAV cloud state
- Post-apply verification with local, cloud, merged, applied, missing, and conflict counts

QuietMarks does not operate a sync server and does not send analytics or telemetry to the developer.

Category:

Productivity

Language:

English

## Single Purpose

QuietMarks synchronizes browser bookmarks through a WebDAV endpoint chosen by the user.

## Permission Justification

`bookmarks`:

Required to read, create, update, move, and remove browser bookmarks during sync.

`offscreen`:

Required to run user-started WebDAV sync requests from a hidden extension document because Manifest V3 service workers can be interrupted during long WebDAV fetches. The offscreen document does not display UI, access web pages, or collect data; it only performs WebDAV requests to the user-configured sync endpoint and sends runtime keepalive messages during an active sync.

`storage`:

Required to store settings, WebDAV configuration, bookmark ID mappings, and the last synced base state locally in the browser extension profile.

`alarms`:

Required to run periodic background sync at the interval selected by the user.

`unlimitedStorage`:

Required so larger bookmark collections and sync state snapshots can be stored locally without hitting small extension storage quotas.

Host permissions for `http://*/*` and `https://*/*`:

QuietMarks does not know the user's WebDAV host in advance because users can choose any WebDAV provider. Host access is used only for WebDAV sync requests to the URL configured by the user.

## Privacy Practices

Data usage:

- Bookmarks: used for bookmark sync.
- Authentication information: WebDAV username and app password are stored locally and sent only to the user-configured WebDAV endpoint.
- User activity / website content: not collected.
- Personal communications, location, web history, financial/payment information, health information: not collected.

Data transfer:

Bookmark sync data is sent only to the WebDAV endpoint configured by the user.

Data sale:

No user data is sold.

Analytics:

No analytics or telemetry are collected.

Encryption:

If the user sets a passphrase, the bookmark payload written to WebDAV is encrypted with AES-GCM. If no passphrase is set, the WebDAV sync file contains readable bookmark JSON.

## Reviewer Notes

QuietMarks requires the user to enter their own WebDAV URL, username, and app password. The extension has no developer-operated backend.

QuietMarks uses host access only for WebDAV requests to the user-configured sync endpoint. It does not read or modify website pages.

The test connection action writes a temporary JSON probe file to the configured WebDAV folder and deletes it afterward.

## Manual Publish Steps

1. Open the Chrome Web Store Developer Dashboard.
2. Choose `New item`.
3. Upload `dist/quietmarks-extension-v0.1.17.zip`.
4. Complete Store Listing using the text above.
5. Upload `dist/store-assets/screenshot-1280x800.png`.
6. Upload `dist/store-assets/promo-440x280.png` if requested.
7. Complete Privacy Practices using the text above.
8. Set distribution visibility.
9. Submit for review.

## API / OAuth Notes

For first-time publishing, use the Developer Dashboard manually. The Chrome Web Store API is mainly useful for updating an existing item after it already has an item ID.

If using the API later, create or select a Google Cloud project, enable the Chrome Web Store API, create OAuth credentials, authorize the required Chrome Web Store scope, then use the extension item ID to upload and publish updates.

Do not store OAuth client secrets, refresh tokens, service credentials, or access tokens in this repository.
