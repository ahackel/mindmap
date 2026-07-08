// ============================================================
// Central mutable app state + the shared DOM handles every module renders into.
// `state` is a single object whose PROPERTIES are mutated in place (never reassign the
// binding) so the live view is shared across modules. DOM nodes live under #world /
// #stage; edges in the #edges SVG, collapse toggles in #toggles.
// ============================================================

export type LayoutType = 'none' | 'free' | 'line' | 'fan' | 'frame' | 'image';
// How a FRAME arranges its children: free placement (default), or auto-flow that fills one axis
// and wraps to the next — horizontal (left→right, wrap down) or vertical (top→bottom, wrap right).
export type FrameArrange = 'free' | 'flow-h' | 'flow-v';
export type LayoutSide = 'left' | 'right' | 'up' | 'down';
export type EdgeStyle = 'straight' | 'orthogonal' | 'bezier';

// One ordered frontmatter entry: a top-level `key:` line plus its continuation lines.
// `key` is null for leading content with no key (preserved verbatim on save).
export interface FmEntry {
  key: string | null;
  lines: string[];
}

// A mindmap node. One .md file per node; the filename is its identity on disk. In-memory
// `id`s are ephemeral (minted per load). Edges are DERIVED from `parent` — no edge list.
export interface MindNode {
  id: string;
  file: string | null;             // relative path on disk; null until first save
  x: number;
  y: number;
  parent: string | null;           // parent node id (resolved from mm_parent path at load)
  _parentPath?: string;            // transient: the mm_parent path, resolved to `parent` post-load
  collapsed: boolean;
  done: boolean;                   // this card is checked off (only meaningful when its parent
                                    // has `checklist` on — that's what shows the checkbox)
  checklist: boolean;              // Trello-style: treat my DIRECT children as a checklist — each
                                    // gets a done checkbox and I show their `n/m` progress. Doesn't
                                    // cascade further down; a child can run its own checklist too.
  bg: boolean;                     // draw a translucent background enclosing me + all my visible
                                    // descendants (see view/edges.ts paintBackgrounds)
  layoutType: LayoutType;
  // Resizable box size (world px). Meaningful for layoutType === 'frame' (the box whose interior
  // adopts cards dropped in) and layoutType === 'image' (an image-only leaf card — no children,
  // no title UI; its body is a single `![alt](path)` filling the box). Persisted as mm_w/mm_h.
  w?: number;
  h?: number;
  // How a frame arranges its children (only for layoutType === 'frame'). Persisted as mm_arrange;
  // absent/undefined means 'free'.
  arrange?: FrameArrange;
  // Which of the PARENT's 4 sides this node attaches on. Stored, not derived — set explicitly
  // by a drop (or copied onto a clone), and backfilled once from position on load/creation if
  // absent (see view/layout.ts sideOf/deriveSide). Meaningless (and omitted) for a root.
  side?: LayoutSide;
  title: string;
  color: string;                   // palette key, e.g. 'blue', or '' for none
  keepStatus: string;              // preserved `status:` frontmatter value
  tags: string[];
  body: string;
  fmEntries?: FmEntry[];           // original frontmatter, preserved verbatim on save
  dirty: boolean;                  // needs a disk write
  dirtyLayout: boolean;            // needs (re)positioning by applyLayouts
  kidOrder?: string[];             // stored child order (line/fan layouts); reseeded only on child drag
  el?: HTMLElement | null;         // the rendered card (added during paint)
}

// An image card is a leaf: no children, no title/body-edit UI (its body is just `![alt](path)`).
// Single source of truth for that fact — call this instead of comparing layoutType directly, so
// every "can this node have children / be renamed" check stays in sync as layout types evolve.
export function isImageCard(n: MindNode | null | undefined): boolean { return n?.layoutType === 'image'; }
// Layout types that carry their own resizable box size (w/h persisted as mm_w/mm_h) rather than
// sizing from title/body content.
export function isBoxLayoutType(t: LayoutType): boolean { return t === 'frame' || t === 'image'; }

export interface View { x: number; y: number; k: number; }

// A freehand sketch stroke drawn on the canvas. Stored (as pure data, not a node) in the
// vault's sketch.json — see data/persistence.ts. `pts` are WORLD coordinates, so ink pans /
// zooms with the map for free. Edges/nodes are unaffected; this is a separate ink layer.
export interface Stroke {
  id: string;
  color: string;                   // CSS colour (hex)
  width: number;                   // stroke width in world units
  pts: [number, number][];         // world-space polyline
}

export interface AppState {
  dir: unknown;
  nodes: Map<string, MindNode>;    // id -> node
  view: View;                      // pan/zoom
  selId: string | null;            // primary selection — drives the single-node editor fields
  sel: Set<string>;                // full selection set (⌘-click / marquee)
  edgeStyle: EdgeStyle;            // restored from localStorage
  strokes: Stroke[];               // freehand sketch layer (loaded from / saved to sketch.json)
  searchMatch: Set<string> | null; // ids to highlight for the find query (matches' visible reps), or null when not searching
  searchActiveId: string | null;   // visible rep of the active dropdown option → gets a white outline
  readOnly: boolean;               // read-only mode: no saves, no edits; collapse/expand only
  idSeq: number;
  toDelete: string[];
  lastSelfWrite?: number;          // guards the external-change reload against our own writes
}

export const state: AppState = {
  dir: null,
  nodes: new Map<string, MindNode>(),
  view: { x: 80, y: 40, k: 1 },
  selId: null,
  sel: new Set<string>(),
  edgeStyle: 'orthogonal',
  strokes: [],
  searchMatch: null,
  searchActiveId: null,
  readOnly: false,
  idSeq: 1,
  toDelete: [],
};

export const world = document.getElementById('world') as HTMLElement;
export const stage = document.getElementById('stage') as HTMLElement;
export const backgroundsSvg = document.getElementById('backgrounds') as unknown as SVGSVGElement;
// Freehand sketch layer — sits behind the cards (see index.html / styles.css z-index).
export const sketchSvg = document.getElementById('sketch') as unknown as SVGSVGElement;
export const edgesSvg = document.getElementById('edges') as unknown as SVGSVGElement;
export const togglesSvg = document.getElementById('toggles') as unknown as SVGSVGElement;
// Top overlay for drag-time edges (dragged card's connectors + reparent preview) — see view/edges.ts.
export const dragEdgesSvg = document.getElementById('dragEdges') as unknown as SVGSVGElement;
export const statusEl = document.getElementById('status') as HTMLElement;
export const setStatus = (t: string): void => { statusEl.textContent = t; };
