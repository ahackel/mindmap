# Markdown Mindmap

A single-file, zero-build mindmap editor for a **local folder of Markdown notes**.
Open a folder, and every `.md` file becomes a card on an infinite canvas; edits are
saved straight back to disk as plain Markdown.

**[▶ Open the app](https://andreashackel.de/mindmap/)**

## How it works

The whole app is one static `index.html` — no server, no backend, no build step.
It's **local-first**: your map is saved in a private on-device store (the browser's
[Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system))
and reopens automatically every visit — no sign-in, no setup, works on every browser
including iPad. Your notes never leave your machine.

To keep notes as real `.md` files in a folder you choose, Chrome and Edge can also
**open a local folder** directly (via the File System Access API) and autosave to it.
Either way, move a map between devices with **Import / Export** as a `.zip`.

## Quick start

1. Open the [app](https://andreashackel.de/mindmap/) — it opens straight onto the canvas
   with your last map (empty on the first visit).
2. Press **Space** (or the **＋** toolbar button) to add a node; double-click the title to
   rename. Pan with one finger / two-finger scroll (or **Space** + drag), zoom with pinch /
   ctrl-scroll, press **F** to fit.
3. Click the **🧠 Home** button anytime to manage storage — open a local folder, or
   import / export a `.zip`.

Cards are linked parent → child; layout, colours, and positions are stored in each
note's frontmatter (`mm_x`, `mm_y`, …), so the map travels with the files.

## Storage & moving between devices

All storage is managed from the **home screen** (the 🧠 button):

- **On-device (default):** auto-saves locally and reopens on its own. Per-device — it does
  not sync between machines by itself.
- **Open a local folder** *(Chrome/Edge)*: work directly on a real folder of `.md` files.
  Point it at a folder your cloud client (iCloud Drive, Synology Drive, Dropbox, …) keeps
  synced, and your map effectively lives in that cloud — no server config in the app.
- **Import / Export `.zip`:** export the whole map as a `.zip`, then import it on another
  device (iPad included — *Save to Files* / pick from Files). Zips made by the app or by
  zipping a folder of `.md` both work.

Add `?nofsa` to the URL to preview the no-local-folder (iPad-style) layout on desktop.

## Features

- Cards rendered from Markdown — headings, links, task lists
- Direction-aware two-sided layout with auto-fan
- Per-branch colours with inheritance
- Collapse / focus / find, read-only mode
- Inline rename, reparent, duplicate, extract-to-child
- Autosave back to the source files

## Architecture

All file I/O lives behind a single swappable `store` adapter (search `let store`
in `index.html`). There are two implementations with an identical interface —
`opfsStore` (the local-first on-device default, Origin Private File System) and `fsaStore`
(a real local folder on Chrome/Edge, File System Access API). The home screen picks between
them; `.zip` import/export moves a map in and out. Replacing only that object would retarget
the app to an Obsidian vault or a Tauri/native build.

## Hosting

The repo is the site: GitHub Pages serves `index.html` from the default branch.
To run locally, serve it over `http://localhost` (e.g. `python3 -m http.server`) — the
on-device store needs a secure context, so a bare `file://` open won't persist reliably.
