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

> **Best in Chrome or Edge**, which can read and write your folder directly. Firefox,
> Safari, and **iPad** lack the File System Access API, so there the app uses an
> **import / export bridge** instead (see *iPad & other browsers* below).

## Quick start

1. Open the [app](https://andreashackel.de/mindmap/).
2. Click **Open folder** and pick a directory of Markdown notes (grant write access).
3. Pan with two-finger scroll (or **Space** + drag), zoom with pinch / ctrl-scroll,
   and press **F** with nothing selected to fit everything.

Cards are linked parent → child; layout, colours, and positions are stored in each
note's frontmatter (`mm_x`, `mm_y`, …), so the map travels with the files.

## iPad & other browsers

iPad Safari (and any browser without the File System Access API) can't autosave to a
real folder, so the app falls back to a self-contained workflow:

1. **Import notes** — pick `.md` files from the Files app (iCloud Drive or *On My iPad*).
2. Edit with full touch support — **one finger pans**, **pinch zooms**, drag a card to
   reparent, and use the edit panel's **Rename / Child / Sibling / Duplicate / Delete**
   buttons (the desktop keyboard shortcuts, made tappable).
3. Your edits autosave to a private **on-device vault** that persists between visits.
4. **Export** (toolbar ⬇) downloads a `.zip` of all notes — *Save to Files* puts it
   back in iCloud or local storage.

Sync is manual (import / export); keep notes in a single folder, since subfolders
aren't preserved on import. Add `?nofsa` to the URL to preview this mode on desktop.

## Features

- Cards rendered from Markdown — headings, links, task lists
- Direction-aware two-sided layout with auto-fan
- Per-branch colours with inheritance
- Collapse / focus / find, read-only mode
- Inline rename, reparent, duplicate, extract-to-child
- Autosave back to the source files

## Architecture

All file I/O lives behind a single swappable `store` adapter (search `const store`
in `index.html`). There are two implementations with an identical interface —
`fsaStore` (File System Access API) and `opfsStore` (Origin Private File System, for
the import/export bridge) — selected at startup by `HAS_FSA`. Replacing only that
object would retarget the app to an Obsidian vault or a Tauri/native build.

## Hosting

The repo is the site: GitHub Pages serves `index.html` from the default branch.
To run locally, just open `index.html` in Chrome/Edge — no server required.
