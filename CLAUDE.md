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
- **TypeScript:** the whole codebase is `.ts` and **fully strict-typed** — every module,
  including `src/main.ts` (the canvas+editing core), is covered by `npm run typecheck`
  (`tsc --noEmit`, run after touching types). No `@ts-nocheck` remains; keep it that way.
  `allowJs` is on for safety but nothing is `.js` anymore; keep `.js` in import specifiers
  (Vite/TS `bundler` resolution maps them to `.ts`).
- **Help content lives in `public/help/*.md`** and is **embedded into the bundle at
  build time** (`import.meta.glob(..., '?raw', eager)` in `src/boot.ts`) — NOT fetched at
  runtime, so the help mindmap works even when `dist/index.html` is opened from a `file://`
  path (browsers block `fetch()` under `file://`). Edit help content there; dev HMR picks it
  up. There is no `manifest.json` — the tree is derived from each note's `mm_parent`.
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
domain folders (all TypeScript). Pure functions live in `utils/`; the interactive subsystems
(drag, gestures, inline-edit, crud, attachments) are split into `features/` and share live
interaction state through the `ui` holder in `core/ui-state.ts`; `main.ts` keeps the render +
selection core and wires the global keyboard/toolbar events.
- `core/state.ts` — the shared mutable `state` object + domain types (`MindNode`, `View`,
  `AppState`, …) + DOM handles (`world`/`stage`/`edgesSvg`/`togglesSvg`) + `setStatus`.
- `core/ui-state.ts` — the shared mutable **`ui`** holder for the interactive subsystem
  (`drag`/`inlineEdit`/`bodyEdit`/`pan`/`marquee`/`pinch`/timers…) + their types, plus the
  `gPointers` map. Mutate its properties in place (never reassign `ui`) so drag / inline-edit /
  gestures / the render core all share one live interaction state across module boundaries.
- `utils/` — pure helpers: `markdown.ts` (`esc`, `renderBodyHTML`), `frontmatter.ts`
  (`parseMd`/`serializeMd`), `model.ts` (derived-tree queries), `zip.ts`, `idb.ts`.
- `store/` — **the swappable I/O boundary**, one concern per file: `opfs.ts`, `fsa.ts`,
  `idb-store.ts` (the three adapters, each `satisfies Store`), `handle-store.ts` (shared
  list/write/remove/read ops — DRY), `recents.ts`, `watch.ts`, `types.ts` (the `Store`
  contract), `index.ts` (barrel + `resolveOnDeviceStore`).
- `data/persistence.ts` — disk-I/O orchestration: the active `store` binding + `useStore`,
  debounced autosave (`scheduleSave`/`flushSave`/`saveAll`), `loadFromDir`, `reloadFromDisk`,
  import/export `.zip`. Signals recents-UI changes via `setOnRecentsChanged` (never renders UI).
- `view/` — `camera.ts` (pan/zoom/`fit`/`frameBox`), `layout.ts` (radial + line/fan/two-sided
  node layout: `applyLayouts`/`radialLayout`/`collapseAtDepth`/`effectiveLayout`), `edges.ts`
  (parent→child connector geometry + `paintEdges`), `theme.ts`, `icons.ts` (loads
  `assets/icons/*.svg` via `import.meta.glob` `?raw`, fills `[data-icon]`).
- `features/` — the interactive subsystems split out of `main.ts`, each owning its concern and
  sharing state via `ui`: `drag.ts` (`bindNodeDrag` + clone/detach/auto-pan + reparent-by-drop),
  `gestures.ts` (canvas pan/zoom/marquee, registers its own listeners on import), `inline-edit.ts`
  (in-place title/body editing: `startInlineEdit`/`startBodyEdit`/`end…`), `crud.ts` (node
  lifecycle: `createNode`/`addChild`/`createSibling`/`duplicateSelection`/`delete…`/`extractToChild`),
  `attachments.ts` (image paste/drop, registers document listeners), `search.ts` (find box,
  exports `searchBox`), `images.ts` (inline image resolution).
- `boot.ts` — `boot()` (local-first open of the last map) + the home/storage screen + help store.
- `main.ts` — entry (`<script type="module" src="/src/main.ts">`). ~600 lines: the render core
  (`nodeEl`/`paintNode`/`paintAll`/`effectiveColor`/relayout animation), selection + edit-panel
  (swatches/layout chips/`selectNode`/`setSelectionSet`), read-only mode, focus, and the global
  keyboard/toolbar wiring. Imports each feature module and exports the kernels they call back
  (`paintAll`/`paintNode`/`selectNode`/`subtreeIds`/`nodeH`/`toggleCollapse`…) — deliberate,
  runtime-only `main`↔module cycles that Rollup bundles fine. Fully strict-typed.

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
`openHelp()` switches to a read-only `helpStore` that serves the bundle-embedded `help/*.md`
notes (see the storage bullet above) — a real mindmap isolated in its own tab so the user's
vault is never touched. Titles carry a leading emoji (the filename is the title); the map goes
general→specific from a root welcome card, with each branch collapsed so users expand to go
deeper. Edit help content by editing those `.md` files; use backtick code spans, not raw HTML,
since `renderBodyHTML` escapes `<…>`, and avoid wrapping inline `code` in `**bold**`/`*italic*`
(the code span is extracted first, so the emphasis won't pair).

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
