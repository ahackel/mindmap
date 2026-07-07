# Markdown Mindmap

A single-file, zero-build mindmap editor for a **local folder of Markdown notes**.
Every `.md` file becomes a card on an infinite canvas; edits are saved straight back to
disk as plain Markdown.

**[▶ Open the app](https://andreashackel.de/mindmap/)** — usage is documented in the
built-in help mindmap (press **F1**).

## How it works

The deployed app is a single static `index.html` — no server, no backend, no runtime
dependencies. (Source lives in `src/` and is bundled back into that one file at build
time; see *Hosting* below.) It's **local-first**: the map is saved in a private on-device
store (the browser's
[Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system))
and reopens automatically every visit — no sign-in, no setup, works on every browser
including iPad. Notes never leave the machine.

Cards are linked parent → child; the tree and all edges are **derived** from each note's
`mm_parent` frontmatter — there is no stored edge list and no database. Layout, colours,
and positions live in the same frontmatter (`mm_x`, `mm_y`, `mm_collapsed`, `mm_layout`, …),
so a map travels with its files. Serialization only rewrites the app-owned keys and
preserves every other frontmatter field and the note body verbatim. One `.md` file per
node; the filename is the node's identity. The freehand sketch layer is the one exception —
it's stored as a single `sketch.json` data file beside the notes, as world-space polylines.

## Storage

All file I/O goes through a single swappable `store` adapter (`src/store/`). Two
implementations share one interface:

- **`opfsStore`** — the local-first on-device default (Origin Private File System). Works on
  every browser incl. iPad; per-device, no built-in cross-device sync.
- **`fsaStore`** — a real local folder on Chrome/Edge (File System Access API), autosaved
  directly. Point it at a cloud-synced folder (iCloud Drive, Dropbox, …) and the map lives
  in that cloud with no app-side server config.

`.zip` **import / export** moves a map in and out (the inline ZIP reader/writer is
zero-dependency). Add `?nofsa` to the URL to preview the no-local-folder (iPad-style)
layout on desktop.

## Features

- Cards rendered from a hand-rolled Markdown subset — headings, links, emphasis, task lists
- Direction-aware two-sided radial layout with auto-fan
- Per-branch colours with inheritance
- Collapse / focus / find, read-only mode
- Inline rename, reparent, duplicate, extract-to-child
- Freehand sketch layer (world-space ink that pans/zooms with the map)
- Undo / redo, image paste & drop
- Autosave back to the source files
- Built-in help mindmap (**F1**)

## Architecture

`src/` is split into domain folders, all fully strict-typed TypeScript: `core/` (shared
mutable `state` + interaction `ui`), `utils/` (pure helpers — Markdown, frontmatter, model
queries), `store/` (the swappable I/O boundary), `data/persistence.ts` (autosave / load /
zip orchestration), `view/` (camera, layout, edges, theme, icons), `features/` (the
interactive subsystems — drag, gestures, inline-edit, crud, attachments, search, sketch,
history), and `main.ts` (the render + selection core). Replacing only the `store` object
would retarget the app to an Obsidian vault or a Tauri/native build.

## Hosting

A GitHub Action (`.github/workflows/deploy.yml`) bundles the source with Vite
(`vite-plugin-singlefile`) into a self-contained `dist/index.html` and deploys it to GitHub
Pages on every push to `main`. Pages "Source" is set to *GitHub Actions* in the repo
settings.

To run locally: `npm install`, then `npm run dev` (Vite dev server on `localhost:5173`).
The on-device store needs a secure context, so use the dev server rather than opening the
file directly. `npm run build` produces the deployable single-file `dist/`; `npm run
typecheck` runs `tsc --noEmit`.

## Versioning

The displayed version is set by the deploy workflow: `0.1.<GitHub run number>`, so it
bumps automatically per deploy — local builds show `0.1.0-dev` instead. It's shown at
the bottom of the home sidebar (home button, top left).

## License

Open source under the [MIT License](LICENSE).
