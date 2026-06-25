# Markdown Mindmap

A single-file, zero-build mindmap editor for a **local folder of Markdown notes**.
Open a folder, and every `.md` file becomes a card on an infinite canvas; edits are
saved straight back to disk as plain Markdown.

**[▶ Open the app](https://ahackel.github.io/mindmap/)**

## How it works

The whole app is one static `index.html` — no server, no backend, no build step.
It reads and writes your files directly through the browser's
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API),
so your notes never leave your machine.

> **Requires Chrome or Edge.** Firefox and Safari don't implement the File System
> Access API needed to read/write a local folder.

## Quick start

1. Open the [app](https://ahackel.github.io/mindmap/).
2. Click **Open folder** and pick a directory of Markdown notes (grant write access).
3. Pan with two-finger scroll (or **Space** + drag), zoom with pinch / ctrl-scroll,
   and press **F** with nothing selected to fit everything.

Cards are linked parent → child; layout, colours, and positions are stored in each
note's frontmatter (`mm_x`, `mm_y`, …), so the map travels with the files.

## Features

- Cards rendered from Markdown — headings, links, task lists
- Direction-aware two-sided layout with auto-fan
- Per-branch colours with inheritance
- Collapse / focus / find, read-only mode
- Inline rename, reparent, duplicate, extract-to-child
- Autosave back to the source files

## Architecture

All file I/O lives behind a single swappable `store` adapter (search `const store`
in `index.html`). It's backed by the File System Access API today; replacing only
that object would retarget the app to an Obsidian vault or a Tauri/native build.

## Hosting

The repo is the site: GitHub Pages serves `index.html` from the default branch.
To run locally, just open `index.html` in Chrome/Edge — no server required.
