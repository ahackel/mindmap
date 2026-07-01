// ============================================================
// Central mutable app state + the shared DOM handles every module renders into.
// `state` is a single object whose PROPERTIES are mutated in place (never reassign the
// binding) so the live view is shared across modules. DOM nodes live under #world /
// #stage; edges in the #edges SVG, collapse toggles in #toggles.
// ============================================================

export type LayoutType = 'none' | 'free' | 'line' | 'fan';
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
  layoutType: LayoutType;
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

export interface View { x: number; y: number; k: number; }

export interface AppState {
  dir: unknown;
  nodes: Map<string, MindNode>;    // id -> node
  view: View;                      // pan/zoom
  selId: string | null;            // primary selection — drives the single-node editor fields
  sel: Set<string>;                // full selection set (⌘-click / marquee)
  edgeStyle: EdgeStyle;            // restored from localStorage
  searchMatch: Set<string> | null; // ids matching the find query, or null when not searching
  readOnly: boolean;               // read-only mode: no saves, no edits; collapse/expand only
  idSeq: number;
  toDelete: string[];
  sidebarOpen: boolean;            // edit panel open by default; toolbar button toggles it
  lastSelfWrite?: number;          // guards the external-change reload against our own writes
}

export const state: AppState = {
  dir: null,
  nodes: new Map<string, MindNode>(),
  view: { x: 80, y: 40, k: 1 },
  selId: null,
  sel: new Set<string>(),
  edgeStyle: 'orthogonal',
  searchMatch: null,
  readOnly: false,
  idSeq: 1,
  toDelete: [],
  sidebarOpen: true,
};

export const world = document.getElementById('world') as HTMLElement;
export const stage = document.getElementById('stage') as HTMLElement;
export const edgesSvg = document.getElementById('edges') as unknown as SVGSVGElement;
export const togglesSvg = document.getElementById('toggles') as unknown as SVGSVGElement;
// Top overlay for drag-time edges (dragged card's connectors + reparent preview) — see view/edges.ts.
export const dragEdgesSvg = document.getElementById('dragEdges') as unknown as SVGSVGElement;
export const statusEl = document.getElementById('status') as HTMLElement;
export const setStatus = (t: string): void => { statusEl.textContent = t; };
