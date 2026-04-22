# Extension Folder

This folder contains the Chrome extension runtime code used by Resource Inspector.

## Files

- `background.js`: service worker that detects resources, manages the queue, handles downloads, and responds to popup messages.
- `content-script.js`: runs on matched pages, scans page resources, and sends detected file hints back to the background worker.

## How It Fits Together

The React UI lives in `src/`, but the actual browser extension behavior lives here.
When you run `npm run build`, Vite copies this folder into `dist/extension/` and also copies:

- `manifest.json`
- `logo.png`

That means Chrome should be pointed at the built `dist/` folder when loading the unpacked extension.

## Notes

- Keep extension-only logic in this folder.
- If you add new background or content-script files, make sure they are referenced by `manifest.json`.
- The extension icon/logo is `logo.png` from the project root.
