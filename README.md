# Markdown Mindmap

A single-file, zero-build mindmap editor for a **local folder of Markdown notes**.
Open a folder, and every `.md` file becomes a card on an infinite canvas; edits are
saved straight back to disk as plain Markdown.

**[▶ Open the app](https://andreashackel.de/mindmap/)**

## How it works

The whole app is one static `index.html` — no server, no backend, no build step.
It reads and writes your files directly through the browser's
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API),
so your notes never leave your machine.

> **Best in Chrome or Edge**, which can read and write a local folder directly. Firefox,
> Safari, and **iPad** lack the File System Access API, so there you connect a
> **WebDAV server** instead — the same files, synced across devices (see *iPad & other
> browsers* below).

## Quick start

1. Open the [app](https://andreashackel.de/mindmap/).
2. Click **Open folder** and pick a directory of Markdown notes (grant write access).
3. Pan with two-finger scroll (or **Space** + drag), zoom with pinch / ctrl-scroll,
   and press **F** with nothing selected to fit everything.

Cards are linked parent → child; layout, colours, and positions are stored in each
note's frontmatter (`mm_x`, `mm_y`, …), so the map travels with the files.

## iPad & other browsers — WebDAV sync

iPad Safari (and any browser without the File System Access API) can't autosave to a
local folder, so there you connect a **WebDAV server** (Nextcloud, Synology, etc.) and
work on the very same `.md` files as on your Mac:

1. On the start screen, open *☁ Sync with a WebDAV server*, enter the collection URL +
   an **app password**, and **Connect**. The config is remembered for one-tap reconnect.
2. Edit with full touch support — **one finger pans**, **pinch zooms**, drag a card to
   reparent, and use the edit panel's **Rename / Child / Sibling / Duplicate / Delete**
   buttons (the desktop keyboard shortcuts, made tappable).
3. Edits autosave straight to the server. The same form is on the Mac start screen, so
   point both devices at the same server and the files are shared (last-write-wins per
   file; switching back to a tab re-reads the other device's changes).

Add `?nofsa` to the URL to preview this mode on desktop.

> The server must send **CORS** headers allowing this site to use
> `PROPFIND / PUT / DELETE / MKCOL` with the `Authorization` and `Depth` headers —
> otherwise the browser blocks the requests. Credentials stay in this browser's
> `localStorage`.

## Features

- Cards rendered from Markdown — headings, links, task lists
- Direction-aware two-sided layout with auto-fan
- Per-branch colours with inheritance
- Collapse / focus / find, read-only mode
- Inline rename, reparent, duplicate, extract-to-child
- Autosave back to the source files

## Architecture

All file I/O lives behind a single swappable `store` adapter (search `let store`
in `index.html`). There are three implementations with an identical interface —
`fsaStore` (File System Access API, for a local folder on Chrome/Edge) and `webdavStore`
(cross-device sync, and the only option on iPad / no-FSA browsers) — chosen by `HAS_FSA`
and the start-screen actions. Replacing only that object would retarget the app to an
Obsidian vault or a Tauri/native build.

## Hosting

The repo is the site: GitHub Pages serves `index.html` from the default branch.
To run locally, just open `index.html` in Chrome/Edge — no server required.
