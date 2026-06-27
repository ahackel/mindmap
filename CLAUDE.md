# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file, zero-build mindmap editor for a local folder of Markdown notes. The
**entire app is `index.html`** (~2500 lines: `<style>`, then HTML, then one inline
`<script type="module">` starting at line 368). There is no build step, no
dependencies, no package manager, and no tests.

## Running / developing

- **Run locally:** serve over a secure context — `python3 -m http.server` then open
  `http://localhost:8000`. OPFS (the local-first store) needs https/localhost; from a
  bare `file://` it may not persist, so prefer the local server for real testing.
- **Works in any modern browser** (incl. iPad Safari) thanks to the OPFS default. The
  "Open folder" option additionally needs the File System Access API
  (`showDirectoryPicker`), which only Chrome/Edge implement.
- **Hosting:** the repo *is* the site. GitHub Pages serves `index.html` from the
  default branch; pushing to `main` deploys.
- **No lint/test/build commands exist.** Verify changes by opening the file in the
  browser and exercising the canvas.

## Core architecture

**One `.md` file per node; the filename is the node's identity.** There is no
database and no sidecar file. In-memory node `id`s are ephemeral, minted fresh on
every load — never persist them.

**Edges are derived, never stored.** A node's parent is `mm_parent` (the parent
note's relative path) in its frontmatter; the tree and all edges are computed from
that. There is no edge list.

**Layout lives in frontmatter as `mm_*` keys:** `mm_parent`, `mm_x`, `mm_y`,
`mm_collapsed`, `mm_layout`, `mm_dir`. `parseMd` (line ~577) reads them;
`serializeMd` (line ~606) writes them back. Serialization rewrites **only**
app-owned keys (`tags`, `color`, `mm_*`) and preserves every other frontmatter
field and the note body verbatim — be careful to keep that property when touching
frontmatter code (`parseFM`/`fmSet`/`fmRemove`).

**The app is local-first.** It boots straight onto the canvas with the last map (no start
gate) via `boot()`; the start screen (`#startScreen`) is now a **home/storage panel** opened
by the 🧠 toolbar button and closable (`startClose`).

**The `store` adapter is the single swappable I/O boundary.** All disk access
(`pick`, `openRecent`, `list`, `write`, `remove`, `watch`) goes through it. `store` is a
reassignable `let` (default `opfsStore`); `useStore(s, kind)` switches backend and records
`kind` in `localStorage` (`LAST_STORE_KEY`). Two implementations, same interface:
- `opfsStore` — **local-first default.** Origin Private File System (`navigator.storage
  .getDirectory()` → `vault/`), works on every browser incl. iPad. Same handle methods as
  FSA, so `list`/`write`/`remove` are identical; no picker/permission/watcher.
- `fsaStore` — File System Access API (Chrome/Edge only): a real local folder. `resume(key)`
  silently reopens at boot iff permission is still granted; directory handles persist in
  IndexedDB (`idbGet`/`idbPut`), the "recent folders" list in localStorage.
  `const HAS_FSA = !!window.showDirectoryPicker` gates the "Open folder" UI (`?nofsa` hides
  it to test the iPad-style layout on desktop).

**Boot order (`boot()`):** if last store was `folder` and `fsaStore.resume()` succeeds →
reopen it; else `openDevice()` (the OPFS vault). On-device is per-device — there's no
built-in cross-device sync. **Moving maps:** `.zip` import (`importFiles` → `unzip`, accepts
`.zip` or loose `.md`, strips a common top folder) and export (`exportZip` → `zipBlob`); the
inline ZIP reader/writer (store + `deflate-raw` via `DecompressionStream`) is zero-dependency.
Retargeting to an Obsidian vault or Tauri build means replacing only the `store` object —
don't scatter backend calls elsewhere. The focus/visibility reload is a shared listener
(`installWatch`) re-pointed at the active store (OPFS's `watch` is a no-op).

**Touch input:** pan/zoom on the canvas is a unified Pointer-Events gesture layer on
`#stage` (one finger pans, two fingers pinch-zoom + pan); node drag/reparent uses the
per-node pointer handlers in `bindNodeDrag`. `#stage`/`.node` set `touch-action:none`.
The edit-panel action row (`#edActions`) exposes rename/duplicate/delete/add as tappable
buttons — they call the same functions as the keyboard shortcuts.

**Central mutable `state` object (line ~377)** holds `nodes` (Map of id → node),
`view` (pan/zoom `{x,y,k}`), selection (`selId` + `sel` Set), `edgeStyle`,
`readOnly`, etc. The render pipeline is `paintNode` / `paintEdges` / `paintAll`;
DOM nodes live under `#world`/`#stage`, edges in the `#edges` SVG.

## Conventions that matter

- **Every mutation must call `scheduleSave()`** to persist. It debounces ~400ms and
  coalesces a burst of edits into one disk write (`flushSave` → `saveAll`).
- **`store.isOpen === false` means demo mode** — no folder open, saves are no-ops,
  in-memory layout changes are intentionally discarded.
- **`state.readOnly` disables all writes and edits** (collapse/expand still allowed);
  `scheduleSave` early-returns in this mode.
- **External-change reload:** `store.watch` fires `reloadFromDisk` on window
  focus / tab-visible (FSA can't truly watch files). It re-reads from disk but
  guards against clobbering in-progress typing/renaming and against re-reading the
  app's own recent writes (`state.lastSelfWrite`).
- **Markdown rendering is a small hand-rolled subset** (`renderBodyHTML`,
  `mdInline`, `mdLinks`, `mdEmphasis`) — headings, links, emphasis, task lists.
  It's not a full Markdown parser; extend these functions rather than reaching for a
  library (the no-dependency, single-file constraint is deliberate).
- **Theme** (light/dark) and **edge style** are persisted in localStorage and driven
  by CSS variables defined at the top of `<style>`.
