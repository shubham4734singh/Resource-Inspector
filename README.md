# Resource Inspector

Resource Inspector is a Chrome extension that helps detect downloadable files already loaded in your current browser session.

It is useful for pages where PDFs, PPTs, DOCs, Excel files, images, ZIP files, and similar resources are loaded in the background or inside viewers.

## What This Project Does

- Detects supported downloadable resources from the active page
- Shows files in a clean popup dashboard
- Lets users filter and review detected files
- Supports direct single-file download
- Lets users add files to a queue
- Exports queued files as one ZIP bundle

## How To Use

1. Open a website where files are loaded or viewed.
2. Click the Resource Inspector extension icon.
3. Refresh inside the extension if needed.
4. Review the detected files list.
5. Use:
   - `Add to queue` to collect files
   - `Download` to download a single file directly
   - `Open resource` to open the file in a new tab
   - `Download ZIP` to download queued files as one ZIP

## How To Add This Extension In Chrome

1. Open Chrome.
2. Go to `chrome://extensions/`
3. Turn on `Developer mode`
4. Click `Load unpacked`
5. Select this `Resource Inspector` folder

After loading, the extension should appear in Chrome with the project logo.

## Important Notes

- This extension works only with resources your browser session can already access.
- It does not bypass login, permissions, or protected content.
- Some protected or expiring links may still fail to download.
- The queue is temporary and clears when the extension window is closed.

## Project Structure In This Build

- `manifest.json`: Chrome extension manifest
- `logo.png`: extension icon
- `extension/`: background and content script files
- `assets/`: built frontend files for the extension UI
- `index.html`: popup entry file



