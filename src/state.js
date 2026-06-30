// ============================================================
// Central mutable app state + the shared DOM handles every module renders into.
// `state` is a single object whose PROPERTIES are mutated in place (never reassign the
// binding) so the live view is shared across modules. DOM nodes live under #world /
// #stage; edges in the #edges SVG, collapse toggles in #toggles.
// ============================================================

export const state = {
  dir: null,
  nodes: new Map(),   // id -> {id,file,x,y,parent,collapsed,title,status,tags[],body,el,dirty}
  view: { x: 80, y: 40, k: 1 },
  selId: null,         // the "primary" selected node — drives the single-node editor fields
  sel: new Set(),      // full selection set (⌘-click / marquee); colour applies to all of these
  edgeStyle: 'orthogonal',   // 'straight' | 'orthogonal' | 'bezier' — restored from localStorage
  searchMatch: null,         // Set of ids matching the find query, or null when not searching
  readOnly: false,           // read-only mode: no saves, no edits; collapse/expand only
  idSeq: 1,
  toDelete: [],
  sidebarOpen: true,   // edit panel is open by default; toolbar button toggles it
};

export const world = document.getElementById('world');
export const stage = document.getElementById('stage');
export const edgesSvg = document.getElementById('edges');
export const togglesSvg = document.getElementById('toggles');
export const statusEl = document.getElementById('status');
export const setStatus = (t) => statusEl.textContent = t;
