# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first mindmap editor for a local folder of Markdown notes. Source lives in
`index.html` (the `<style>` + HTML shell) plus ES modules under `src/` (entry
`src/main.js`). A Vite build (`vite-plugin-singlefile`) bundles **everything back into
one self-contained `dist/index.html`** — JS and CSS inlined — so the *deployed* artifact
stays a single file and offline-via-HTTP-cache works the same as before. No runtime
dependencies; the only deps are the dev-time bundler. No tests.

## Running / developing

- **Run locally:** `npm install` once, then `npm run dev` (Vite dev server on
  `localhost:5173`, serves `src/` unbundled with HMR). OPFS (the local-first store)
  needs https/localhost, so use the dev server rather than a bare `file://`.
- **Build:** `npm run build` → `dist/index.html` (single self-contained file) plus
  `dist/help/` copied verbatim. `npm run preview` serves the built `dist/`.
- **TypeScript:** the codebase is migrating to TS incrementally. `core/`, `utils/`,
  `store/`, `view/`, `features/` are `.ts`; only `src/main.js` is still JS. `npm run
  typecheck` (`tsc --noEmit`) type-checks separately — Vite transpiles `.ts` itself, so
  typecheck never blocks the build. `allowJs` lets `.js`/`.ts` coexist; keep `.js` in
  import specifiers (Vite/TS `bundler` resolution maps them to `.ts`). Run `typecheck`
  after touching types.
- **`help/` is runtime-fetched**, so it lives in `public/help/` and Vite copies it to
  `dist/help/`; the relative `fetch('help/...')` resolves in dev and prod alike. Edit
  help content there.
- **Works in any modern browser** (incl. iPad Safari) thanks to the OPFS default. The
  "Open folder" option additionally needs the File System Access API
  (`showDirectoryPicker`), which only Chrome/Edge implement.
- **Hosting:** `.github/workflows/deploy.yml` runs `npm run build` and deploys `dist/`
  to GitHub Pages on push to `main` (Pages "Source" must be set to *GitHub Actions* in
  repo settings). The repo no longer serves a hand-written `index.html` directly.
- **No lint/test commands exist.** Verify changes by running the app in the browser and
  exercising the canvas.

## Core architecture

**Module layout (`src/`).** The app was split out of the old single inline script into
domain folders. Pure functions live in `utils/`; `main.js` is the entry/orchestrator that
still holds the render/view/layout/drag/edit/crud core and wires DOM events.
- `core/state.js` — the shared mutable `state` object + DOM handles (`world`/`stage`/
  `edgesSvg`/`togglesSvg`) + `setStatus`. Everyone imports the live object.
- `utils/` — pure helpers: `markdown.js` (`esc`, `renderBodyHTML`), `frontmatter.js`
  (`parseMd`/`serializeMd`), `model.js` (derived-tree queries), `zip.js` (`zipBlob`/`unzip`),
  `idb.js` (`idbGet/Put/Del`).
- `store/` — **the swappable I/O boundary**, one concern per file: `opfs.js`, `fsa.js`,
  `idb-store.js` (the three adapters), `handle-store.js` (the shared list/write/remove/read
  ops the OPFS+FSA adapters delegate to — DRY), `recents.js`, `watch.js`, and `index.js`
  (barrel + `resolveOnDeviceStore`). `main.js` keeps the active `let store` binding +
  `useStore`; the store signals recents-UI changes via `setOnRecentsChanged` (it never
  renders UI itself).
- `view/` — `camera.js` (pan/zoom/`fit`/`frameBox`), `theme.js` (`setupTheme()`).
- `features/` — `search.js` (find box, exports `searchBox`), `images.js` (inline image
  resolution). Both import the `paintAll`/`applyLayouts`/`focusNode`/`store` kernel from
  `main.js` — deliberate, runtime-only `main`↔feature cycles that Rollup bundles fine.
- `assets/icons/*.svg` — icon markup, imported via Vite `?raw` (inlined in the build).
- `main.js` — entry: `<script type="module" src="/src/main.js">`. Still ~2.2k lines of
  the interconnected render/view/layout/drag/edit/crud core + boot + event wiring.

NOTE: line numbers cited elsewhere in this file refer to the pre-split inline script and
are now only approximate — grep for the symbol.

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

**Help mindmap:** `F1` opens `?help` in a new tab (`openHelpTab`). On boot with `?help`,
`openHelp()` switches to a read-only `helpStore` that fetches `help/manifest.json` + the
listed `help/*.md` — a real mindmap shipped next to `index.html`, isolated in its own tab so
the user's vault is never touched. Edit help content by editing those `.md` files (and the
manifest); use backtick code spans, not raw HTML, since `renderBodyHTML` escapes `<…>`.

**Touch input:** pan/zoom on the canvas is a unified Pointer-Events gesture layer on
`#stage` (one finger pans, two fingers pinch-zoom + pan); node drag/reparent uses the
per-node pointer handlers in `bindNodeDrag`. `#stage`/`.node` set `touch-action:none`.
The toolbar has a divider-flanked **selected-card section** (`#edRename`/`edAddChild`/
`edAddSibling`/`edDuplicate`/`edDelete`) calling the same functions as the keyboard
shortcuts; `updateNodeActions()` (run from `applySelection`) enables/disables them by
selection + `readOnly`, and the titles show the shortcut.

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
