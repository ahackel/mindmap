// ============================================================
// Central mutable app state + the shared DOM handles every module renders into.
// `state` is a single object whose PROPERTIES are mutated in place (never reassign the
// binding) so the live view is shared across modules. DOM nodes live under #world /
// #stage; edges in the #edges SVG, collapse toggles in #toggles.
// ============================================================

// A node's KIND, orthogonal to how it arranges its children (`layout` below):
//   · card       — an ordinary titled/bodied node.
//   · frame      — a resizable container box (mm_w/mm_h) that adopts cards dropped inside.
//   · image      — a leaf box (mm_w/mm_h) showing one image, no children, no title/body UI.
//   · annotation — a leaf note pinned to its parent: no title, no children, doesn't take part in
//                  layout, and renders ON TOP of everything (never clipped by a frame's mask). Its
//                  own colour drives its always-dotted connector; it never inherits a background.
//   · query      — a resizable box (mm_w/mm_h) with a search field over a scrollable list of
//                  title/body matches across the whole map; no children, keeps its title UI.
//                  Search text persisted as mm_query.
// Extensible: new kinds slot in here. Persisted as `mm_type` (omitted for the `card` default).
export type NodeType = 'card' | 'frame' | 'image' | 'annotation' | 'query';
// How a node ARRANGES its children. The valid set depends on the node's `type`:
//   · card  → inherit (take the parent's), free (stay where dragged), line (chained), fan (spread).
//   · frame → free (children placed freely inside), horizontal (auto-flow rows: left→right, wrap
//             down), vertical (auto-flow columns: top→bottom, wrap right).
//   · image / annotation → none (a leaf; `layout` is unused, kept `free`).
// Persisted as `mm_layout` (only for card/frame, omitted when it equals the type's default).
export type NodeLayout = 'inherit' | 'free' | 'line' | 'fan' | 'horizontal' | 'vertical';
// Node kinds that carry their own resizable box size (w/h persisted as mm_w/mm_h) rather than
// sizing from title/body content — a frame, an image, or a query card.
export const isBoxType = (t: NodeType): boolean => t === 'frame' || t === 'image' || t === 'query';
export type LayoutSide = 'left' | 'right' | 'up' | 'down';
export type EdgeStyle = 'straight' | 'orthogonal' | 'bezier';
export type GridStyle = 'none' | 'dot' | 'line';
export type GridSize = 0 | 20 | 40 | 80 | 160 | 320;

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
  // Position, two forms. x/y is the WORKING form (absolute world coords) — the layout and drag
  // engines read and mutate this. rx/ry is the PERSISTED form (offset from the parent, world
  // origin for a root), written as mm_position_x/y. commitRel() (view/layout.ts) derives rx/ry
  // from x/y just before a save; loadFromDir does the reverse. Between those, rx/ry may be stale.
  x: number;
  y: number;
  rx: number;                      // persisted as mm_position_x/y
  ry: number;
  parent: string | null;           // parent node id (resolved from mm_parent path at load)
  _parentPath?: string;            // transient: the mm_parent path, resolved to `parent` post-load
  collapsed: boolean;
  locked: boolean;                 // this card can be selected but not moved, (un)collapsed, or
                                    // edited (rename/body/color/type/layout/delete/add child); the
                                    // lock cascades to every descendant, which additionally can't
                                    // even be selected — see utils/model.ts hasLockedAncestor.
                                    // Persisted as mm_locked.
  done: boolean;                   // this card is checked off (only meaningful when its parent
                                    // has `checklist` on — that's what shows the checkbox)
  checklist: boolean;              // Trello-style: treat my DIRECT children as a checklist — each
                                    // gets a done checkbox and I show their `n/m` progress. Doesn't
                                    // cascade further down; a child can run its own checklist too.
  bg: boolean;                     // draw a translucent background enclosing me + all my visible
                                    // descendants (see view/edges.ts paintBackgrounds)
  type: NodeType;                  // card | frame | image | query — the node's kind (persisted as mm_type)
  layout: NodeLayout;              // how it arranges its children — valid set depends on `type`
  // Resizable box size (world px). Meaningful for a frame (the box whose interior adopts cards
  // dropped in), for type === 'image' (an image-only leaf card — no children, no title UI;
  // its body is a single `![alt](path)` filling the box), and for type === 'query' (a leaf card
  // with a search field over a scrollable results list). Persisted as mm_w/mm_h.
  w?: number;
  h?: number;
  // type === 'query' only: the search text typed into the card's own search field, matched
  // against every OTHER node's title/body across the whole map. Persisted as mm_query.
  query?: string;
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
  frameContentEl?: HTMLElement | null;   // this frame's overflow:hidden content wrapper (frames only)
  hostFrameId?: string | null;     // which frame's content wrapper el/frameContentEl currently live
                                    // in, DOM-wise (null = directly under #world) — transient render
                                    // bookkeeping, settled outside gestures (see main.ts settledHost)
}

// An image card is a leaf: no children, no title/body-edit UI (its body is just `![alt](path)`).
// Single source of truth for that fact — call this instead of comparing `type` directly, so
// every "can this node have children / be renamed" check stays in sync as kinds evolve.
export function isImageCard(n: MindNode | null | undefined): boolean { return n?.type === 'image'; }
// An annotation: a title-less leaf note pinned on top of its parent (see NodeType above).
export function isAnnotation(n: MindNode | null | undefined): boolean { return n?.type === 'annotation'; }
// A query card: a resizable leaf with a search field over a scrollable results list (see NodeType above).
export function isQueryCard(n: MindNode | null | undefined): boolean { return n?.type === 'query'; }
// Leaf kinds that cannot hold children (image + annotation + query). Card/frame can.
export function isLeafType(n: MindNode | null | undefined): boolean {
  return n?.type === 'image' || n?.type === 'annotation' || n?.type === 'query';
}

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
  gridStyle: GridStyle;            // restored per-map from settings.json — see data/persistence.ts
  gridSize: GridSize;               // pattern cell size in world px — restored per-map from settings.json
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
  gridStyle: 'none',
  gridSize: 20,
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
// Group-opacity layer for the CURRENTLY DRAGGED items: while a drag is live the dragged cards and
// their connectors are re-parented in here so the whole set composites as one translucent group
// (see #dragLayer in styles.css / dragRoot() in main.ts). dragLayerEdges holds their connectors.
export const dragLayer = document.getElementById('dragLayer') as HTMLElement;
export const dragLayerEdges = document.getElementById('dragLayerEdges') as unknown as SVGSVGElement;
export const statusEl = document.getElementById('status') as HTMLElement;
export const setStatus = (t: string): void => { statusEl.textContent = t; };
