// The render + selection core. The interactive subsystems (drag / inline-edit / crud / gestures /
// attachments) live in features/ and share live state via the `ui` holder; this file owns the
// render pipeline (paintNode/paintAll/paintEdges), selection + edit-panel, read-only mode, focus,
// and the global keyboard/toolbar wiring. It exports the render kernels the feature modules call
// back into. Fully strict-typed and covered by `npm run typecheck`.
/* ============================================================
   Markdown Mindmap — PoC v2: hierarchy + collapse + add-child
   Storage: one .md per node. Layout lives in each note's frontmatter as mm_* keys
   (mm_parent = parent note's path, mm_x/mm_y, mm_collapsed) — no sidecar, no ids on disk.
   The filename IS the node's identity; in-memory ids are ephemeral, minted per load.
   Edges are DERIVED from parent — no separate edge list.
   ============================================================ */

import './styles.css';   // app styles (Vite bundles + singlefile inlines into dist/index.html)
import { renderBodyHTML } from './utils/markdown.js';
import { childrenOf, isHidden, descendantCount, hasLockedAncestor, isLockedEffective } from './utils/model.js';
import { state, world, dragLayer, stage, setStatus, isImageCard, isAnnotation } from './core/state.js';
import { setupTheme } from './view/theme.js';
import { setupGrid } from './view/grid.js';
import { mountIcons } from './view/icons.js';
import edgeStraightIcon from './assets/icons/edge-straight.svg?raw';
import edgeOrthogonalIcon from './assets/icons/edge-orthogonal.svg?raw';
import edgeBezierIcon from './assets/icons/edge-bezier.svg?raw';
import { zoomAt, frameBox, screenToWorld } from './view/camera.js';
import { applyLayouts, hostFrame, frameInterior, frameFlow } from './view/layout.js';
import { paintEdges } from './view/edges.js';
import './features/gestures.js';   // registers the canvas pan/zoom/marquee gesture listeners
import './features/attachments.js';   // registers the OS image drag/drop listeners
import './features/context-menu.js';   // registers the custom right-click menu on the canvas
import { startInlineEdit, startBodyEdit, endInlineEdit, endBodyEdit, onInlineInput, onInlineKeydown } from './features/inline-edit.js';
import { createNode, createDetachedNode, createAnnotationHere, createSibling, addChild, duplicateSelection, deleteSelection, deleteNode } from './features/crud.js';
import { bindNodeDrag, startNodeDrag, feedDragMove, commitDrag, abortDrag } from './features/drag.js';   // also registers the Alt/Shift drag-modifier listeners
import { openSearch } from './features/search.js';
import { renderOutline, toggleOutlineView, outlineActive } from './features/outline.js';   // also wires the outline toggle button
import { refreshSwatches } from './features/properties.js';
import { syncFloatBar, autoSizeSelection } from './features/float-bar.js';   // also registers the float bar's own listeners
import { copySelection, cutSelection, bindCardFileDrag } from './features/clipboard.js';
import { toggleSketchMode } from './features/sketch.js';   // also registers the sketch toolbar wiring
import { commitStep, record, touch, undo, redo, updateUndoButtons } from './features/history.js';
import { resetImageCache, hydrateImages } from './features/images.js';
import { openImageViewer } from './features/image-viewer.js';
import { store, scheduleSave, flushSave, loadFromDir } from './data/persistence.js';
import { showStart, openHelpTab, boot } from './boot.js';
import type { MindNode, EdgeStyle } from './core/state.js';
import { ui, isTypingInField, type Pt, type Drag } from './core/ui-state.js';

declare global {
  interface Window { __dbg: { readonly state: typeof state; readonly drag: Drag | null }; }
}

// The DOM shell (index.html) is fixed, so these elements always exist — assert non-null.
function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }

window.__dbg = { get state(){ return state; }, get drag(){ return ui.drag; } };   // TEMP debug hook

mountIcons();                         // fill [data-icon] placeholders with their SVG assets
setupTheme();
setupGrid();




// ---------- rendering ----------
// small closed-padlock badge shown on a locked card's title row (shares the glyph the read-only
// toolbar button uses — see ICON_LOCK_CLOSED further down).
const LOCK_BADGE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
function nodeEl(n: MindNode): HTMLElement {
  if (n.el) return n.el;
  const el = document.createElement('div');
  el.dataset.id = n.id;
  el.innerHTML = `<div class="title-row"><input type="checkbox" class="donebox" title="Mark done"><span class="lock-badge" title="Locked">${LOCK_BADGE_SVG}</span><div class="title"></div><span class="progress"></span></div><div class="body"></div>
    <span class="hidden-count"></span>
    <div class="addnote" title="Add note">Add note…</div>`;
  world.appendChild(el);
  n.el = el;
  bindNodeDrag(n);
  bindCardFileDrag(n);   // ⌥-drag out of the window = save as .md file(s)
  const addnote = el.querySelector('.addnote')!;
  addnote.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); });
  addnote.addEventListener('click', (e)=>{ e.stopPropagation(); startBodyEdit(n); });
  const bodyEl = el.querySelector('.body')!;
  // body links: open externally, or jump to a wikilink's node. Don't let the click bubble to
  // the card (which would select / toggle the panel); pointerdown is stopped in bindNodeDrag.
  bodyEl.addEventListener('click', (e)=>{
    const zoom = (e.target as HTMLElement).closest('.img-zoom') as HTMLElement | null;
    if (zoom){
      e.stopPropagation();
      const img = zoom.closest('.img-wrap')?.querySelector('img.md-img') as HTMLImageElement | null;
      if (img && img.src && !img.classList.contains('md-img-missing')) openImageViewer(img.src, img.alt);
      return;
    }
    const a = (e.target as HTMLElement).closest('a.lk') as HTMLElement | null; if (!a) return;
    e.stopPropagation();
    if (a.classList.contains('wikilink')){
      e.preventDefault();
      focusByTitle(a.dataset.target ?? '');
    }
  });
  // task checkboxes: toggle the matching [ ]/[x] in the body and persist
  bodyEl.addEventListener('change', (e)=>{
    const cb = (e.target as HTMLElement).closest('input.taskbox') as HTMLInputElement | null; if (!cb) return;
    e.stopPropagation();
    toggleTask(n, +(cb.dataset.ti ?? 0));
  });
  // done checkbox (title-only cards): toggle the card-level done mark, independent of drag/select
  const doneEl = el.querySelector('.donebox') as HTMLInputElement;
  doneEl.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); if (isLockedEffective(n)) e.preventDefault(); });
  doneEl.addEventListener('click', (e)=>{ e.stopPropagation(); });
  doneEl.addEventListener('change', (e)=>{ e.stopPropagation(); toggleDone(n); });
  // inline title rename: typing reflows + validates; Enter/Tab commit, Escape cancels, blur commits
  const titleEl = el.querySelector('.title') as HTMLElement;
  titleEl.addEventListener('input',   ()  => onInlineInput(n));
  titleEl.addEventListener('keydown', (e) => onInlineKeydown(e as KeyboardEvent, n));
  titleEl.addEventListener('blur',    ()  => { if (ui.inlineEdit && ui.inlineEdit.id === n.id) endInlineEdit(); });
  // double-click a node to fold/unfold it (cancels a pending slow-click rename). If the card was
  // part of a multi-selection an instant ago (the first click collapsed it to one), fold the whole
  // group and keep it selected, rather than just this card.
  el.addEventListener('dblclick', (e)=>{
    // while editing this card's title or body, a double-click selects a word — don't fold
    if ((ui.inlineEdit && ui.inlineEdit.id === n.id) || (ui.bodyEdit && ui.bodyEdit.id === n.id)) return;
    e.stopPropagation(); e.preventDefault();
    clearTimeout(ui.renameTimer);          // a double-click means "fold", not "rename"
    foldNodeOrGroup(n);
  });
  return el;
}
// Fold/unfold on double-click or double-tap: if this card was part of a multi-selection an instant
// ago (a `pendingGroupFold` was stashed when the first click reduced it to one), fold the whole group
// and keep it selected; otherwise just fold this one card. Shared by nodeEl (dblclick) and the touch
// double-tap in features/drag.ts.
export function foldNodeOrGroup(n: MindNode): void {
  const g = ui.pendingGroupFold;
  ui.pendingGroupFold = null;
  if (g && g.node === n.id && g.ids.has(n.id) && performance.now() - g.t < 600){
    toggleCollapseSelection(g.ids);
    setSelectionSet(g.ids);           // restore the group so it stays selected after folding
  } else {
    toggleCollapse(n.id);
  }
}
// A card's colour is its own, or — if unset — inherited from the nearest coloured ancestor. While
// dragging, preview what that inherited colour is ABOUT TO become, so it doesn't wait for the
// drop to update:
//  - Alt-dragging, or pulled past the rip threshold, to detach: treat the dragged node as a root
//    (stop the ancestor walk there) — mirrors the actual detach condition in dragPointerUp.
//  - Poised over a valid reparent target: continue the walk from the NEW parent instead of the
//    real (about-to-change) one — a sibling-mode drop adopts the target's own parent.
// Either way this only redirects the walk once it reaches the actively dragged node, so the whole
// dragged subtree's inheriting descendants preview correctly too (their own walk passes through it).
// An inheriting card with no coloured ancestor (a root left on the default "inherit") falls back
// to grey, so it gets the same neutral card bg as an explicit grey rather than going transparent.
// Explicit 'none' still short-circuits below (it's truthy), so "no colour" stays transparent.
export function effectiveColor(n: MindNode): string {
  // An annotation never inherits a background — only its OWN colour counts (drives its dotted
  // connector + the anchor dot on its parent); with none ('inherit') it takes the THEME'S CONTRAST
  // colour — white on the dark canvas, black on the light one — so it always stands out on top.
  if (isAnnotation(n)) return n.color || (document.body.classList.contains('light') ? 'black' : 'white');
  const drag = ui.drag;
  let previewId: string | null = null;
  let previewParent: MindNode | null | undefined;
  if (drag && !drag.shift && (drag.alt || drag.rip)) { previewId = drag.active.id; previewParent = null; }
  else if (drag && drag.dropTarget) {
    previewId = drag.active.id;
    const tgt = state.nodes.get(drag.dropTarget);
    previewParent = drag.dropMode === 'sibling' ? (tgt?.parent ? state.nodes.get(tgt.parent) : null) : tgt;
  }
  for (let c: MindNode | null | undefined = n; c; c = (c.id === previewId) ? previewParent : (c.parent ? state.nodes.get(c.parent) : null))
    if (c.color) return c.color;
  // light theme: the neutral fallback card reads better as white than as the dark-grey card
  return document.body.classList.contains('light') ? 'white' : 'grey';
}
// A card shows a done checkbox only if its PARENT has `checklist` on — Trello-style: the
// setting lives on the parent ("treat my children as a checklist"), not on the item itself, and
// doesn't cascade past that one level (a checklist item can run its own checklist for its kids).
function showsDoneCheckbox(n: MindNode): boolean {
  const p = n.parent ? state.nodes.get(n.parent) : undefined;
  return !!(p && p.checklist);
}
export function paintNode(n: MindNode): void {
  const el = nodeEl(n);
  if (isHidden(n)) { el.style.display = 'none'; return; }
  el.style.display = '';
  const kids = childrenOf(n.id);
  const hasKids = kids.length > 0;
  const editingBody = ui.bodyEdit && ui.bodyEdit.id === n.id;    // body editor open on this card
  const hasBody = editingBody || !!(n.body && n.body.trim());  // keep the body slot while editing
  const collapsedKids = n.collapsed && hasKids;            // hidden children → +N chip
  const collapsed = n.collapsed && (hasKids || hasBody);   // folded to just its title
  const showDone = showsDoneCheckbox(n);                   // checklist item of a checklist parent
  el.className = 'node c-' + effectiveColor(n)
    + (isFrameBox(n) ? ' frame' : '')
    + (isImageBox(n) ? ' image-card' : '')
    + (isAnnotation(n) ? ' annotation' : '')
    + (state.sel.has(n.id) ? ' sel' : '')
    + (state.sel.size === 1 && state.sel.has(n.id) ? ' solo' : '')   // lone selection → show +
    + (collapsed ? ' collapsed' : '')
    + (n.locked ? ' locked' : '')
    + (hasBody ? '' : ' no-body')
    + (showDone ? ' show-done' : '')
    + (showDone && n.done ? ' done' : '')
    + (ui.drag?.targets?.has(n.id) ? ' dragging' : '')   // float the dragged subtree above all cards
    + (state.searchMatch && !state.searchMatch.has(n.id) ? ' search-dim' : '')
    + (state.searchActiveId === n.id ? ' search-active' : '');   // active dropdown option → white outline
  (el.querySelector('.donebox') as HTMLInputElement).checked = n.done;
  // this card's own checklist (over ITS children) → an "n/m done" progress readout by the title
  el.querySelector('.progress')!.textContent =
    (n.checklist && hasKids) ? `${kids.filter(k => k.done).length}/${kids.length}` : '';
  // Which frame (if any) hosts this card's element — settled outside gestures (see settledHost).
  const host = settledHost(n);
  // During drag: keep left/top frozen at the pre-drag origin and move via transform (compositor-
  // only) — the SAME scheme applyDragTransform (drag.ts) uses on every pointermove. Doing it here
  // too means a mid-drag repaint (e.g. drop-target / rip colour change) can't desync the card from
  // the cursor: if paintNode instead placed the card at its LIVE, already-moved n.x and cleared the
  // transform, the next pointermove would re-add translate(n.x-origin) on top of that moved left/top
  // and double-count the delta — the "offset jumps when a card touches its frame's bounds" bug.
  // A dragged card lifts OUT of its frame's overflow:hidden content wrapper into #world for the
  // duration of the gesture, so it's never masked by the frame's bounds while being dragged (in
  // particular while being carried out of the box). It repaints in plain world coordinates — the
  // same as a top-level card. The one exception is a child CARRIED by its own host frame's drag:
  // that child stays inside the frame (the whole box moves together) and repaints at its live
  // host-relative position with no transform of its own (giving it one too would shift it twice —
  // mirrors applyDragTransform), so it keeps clipping to the frame that carries it.
  const drag = ui.drag;
  const carried = !!(drag && n.hostFrameId != null && drag.targets.has(n.hostFrameId));
  const dragOrig = !carried ? drag?.origins?.get(n.id) : undefined;
  if (dragOrig) {
    el.style.left = dragOrig.x + 'px'; el.style.top = dragOrig.y + 'px';
    el.style.transform = `translate(${n.x - dragOrig.x}px,${n.y - dragOrig.y}px)`;
    const root = dragRoot();
    if (el.parentElement !== root) root.appendChild(el);
  } else {
    if (el.style.transform) el.style.transform = '';
    // A child card is nested INSIDE its parent card's element, positioned by its offset from the
    // parent (n.x - parent.x — the live, staleness-proof form of rx/ry). So the parent carries its
    // whole subtree via the compositor: moving the parent's element moves every descendant with it,
    // no per-descendant left/top rewrite. Roots stay under #world; a direct frame child stays in the
    // frame's overflow:hidden wrapper (place()). isFrameBox covers frames (image cards are leaves).
    const p = n.parent ? state.nodes.get(n.parent) : null;
    if (isAnnotation(n)) {
      // An annotation always renders directly under #world at absolute coords — never nested in its
      // parent nor in a frame's overflow:hidden wrapper — so a high z-index (styles.css) floats it on
      // TOP of everything and no frame mask ever clips it. It still tracks its parent: layout keeps
      // n.x/n.y = parent + offset, and drag carries it (it's in the parent's subtreeIds → own transform).
      place(el, n.x, n.y, null);
    } else if (p && !isFrameBox(p)) {
      const pEl = nodeEl(p);
      el.style.left = (n.x - p.x) + 'px';
      el.style.top  = (n.y - p.y) + 'px';
      if (el.parentElement !== pEl) pEl.appendChild(el);
    } else {
      place(el, n.x, n.y, host);   // root → #world; direct frame child → frame content wrapper
    }
  }
  // A frame (or an image card) is its own resizable box; give the element that size and a
  // drag-to-resize handle. Any other card clears the inline size so a reverted box snaps back
  // to the CSS-fixed card.
  if (isBoxNode(n)) {
    el.style.width = (n.w ?? boxDefaultW(n)) + 'px';
    el.style.height = (n.h ?? boxDefaultH(n)) + 'px';
    // border matches this card's EDGE tint (same colour edges use), falling back to --edge
    el.style.setProperty('--frame-stroke', SWATCH_BG[effectiveColor(n)] ?? 'var(--edge)');
    ensureFrameHandle(n);
    // clear a stale min-height snapCardHeights left behind from when this was a plain card —
    // it's skipped for box nodes going forward, so nothing else would ever reset it, and a
    // leftover floor taller than n.h would silently distort the box (wrong aspect ratio, extra
    // height) after a round-trip through a non-box layout type and back.
    if (el.style.minHeight) el.style.minHeight = '';
    if (isFrameBox(n)) frameContentEl(n);   // create/reposition/resize this frame's overflow:hidden content wrapper
  } else if (el.style.width) {
    el.style.width = ''; el.style.height = '';
    el.style.removeProperty('--frame-stroke');
    el.querySelectorAll('.fh, .frame-resize').forEach(x => x.remove());
  }
  // don't clobber the title while it's being inline-edited (the user is typing into it)
  if (!(ui.inlineEdit && ui.inlineEdit.id === n.id)) el.querySelector('.title')!.textContent = n.title;
  const bodyEl = el.querySelector('.body') as HTMLElement;
  // don't clobber the body while it's being edited in place (the textarea lives inside .body)
  if (!editingBody) {
    bodyEl.innerHTML = renderBodyHTML(n.body);
    hydrateImages(bodyEl);   // swap inline-image placeholders for resolved (blob/remote) URLs
  }
  // folded branch → hidden-descendant count; folded leaf → empty bubble (a white dot)
  if (collapsed) el.querySelector('.hidden-count')!.textContent = collapsedKids ? String(descendantCount(n.id)) : '';
}
export const NODE_W = 200;
export const GRID_SNAP = 20;   // world-px grid dragged positions AND frame/image-card sizes snap to
export const FRAME_W = 360, FRAME_H = 260;   // default frame container size (world px)
export const IMAGE_W = 240, IMAGE_H = 180;   // default image-card size (world px)
export const FRAME_BORDER = 4;   // must match .node.frame's CSS `border` width (styles.css)
// Whether a node currently renders as a frame BOX. A collapsed frame folds to an ordinary card, so
// its footprint reverts to a normal card (matching paintNode). Shared by the geometry helpers below.
function isFrameBox(n: MindNode): boolean { return n.type === 'frame' && !n.collapsed; }
// An image card: a resizable leaf that shows nothing but its one image — no children, no title UI.
function isImageBox(n: MindNode): boolean { return n.type === 'image' && !n.collapsed; }
// Either kind of resizable box — shares sizing/resize-handle plumbing below.
function isBoxNode(n: MindNode): boolean { return isFrameBox(n) || isImageBox(n); }
function boxDefaultW(n: MindNode): number { return isImageBox(n) ? IMAGE_W : FRAME_W; }
function boxDefaultH(n: MindNode): number { return isImageBox(n) ? IMAGE_H : FRAME_H; }
// A node's footprint WIDTH: an (expanded) frame/image card is its own resizable box; everything
// else is NODE_W.
export function nodeW(n: MindNode): number { return isBoxNode(n) ? (n.w ?? boxDefaultW(n)) : NODE_W; }
// live height (falls back pre-render). An expanded frame/image card's height is its box (n.h), not
// its card.
export function nodeH(n: MindNode): number {
  if (isBoxNode(n)) return n.h ?? boxDefaultH(n);
  return (n.el && n.el.offsetHeight) || 64;
}
// Height used for LAYOUT geometry. The selection affordances (+ and the "add note" bubble) are
// absolutely positioned and overhang the card, so they don't inflate its measured height — a
// title-only card lays out the same whether or not it's selected. A box node reports its own height.
export function layoutH(n: MindNode): number {
  if (isBoxNode(n)) return n.h ?? boxDefaultH(n);
  const el = n.el; if (!el) return 64;
  return el.offsetHeight;
}
// ---------- frame content containment (real CSS clipping, not per-card math) ----------
// A card living inside a frame must never visually spill past its box — dragging near a border, or
// shrinking the frame below its content, shouldn't leave cards overhanging. Frame children are flat
// DOM siblings under #world like everything else, so real containment means giving each frame its
// own overflow:hidden wrapper and re-parenting whatever it hosts (cards AND nested frames) into it,
// rather than a per-card clip-path hack — that also makes nested frames and grandchildren clip for
// free, and respects the frame's rounded corners.
//
// Which frame `n`'s element is CURRENTLY, actually parented under, DOM-wise — settled outside any
// active gesture (drag / inline-edit / body-edit) so re-parenting can't drop a captured pointer or
// blur an open editor (same caution as the old orderFrames pass this replaces). Mid-gesture callers
// just get back whatever was last settled; paintNode still repositions live using that fixed host,
// so a card mid-drag stays visually clipped to wherever it's actually hosted until the drop settles.
// `hostFrame` (view/layout.ts) does the actual ancestor walk — shared with edges.ts so an edge
// between two cards inside the same frame clips to it too, not just the cards themselves.
function settledHost(n: MindNode): MindNode | null {
  if (ui.drag || ui.inlineEdit || ui.bodyEdit) return n.hostFrameId ? (state.nodes.get(n.hostFrameId) ?? null) : null;
  const want = hostFrame(n);
  n.hostFrameId = want ? want.id : null;
  return want;
}
// Position + (re)parent `el` so its border-box top-left lands at absolute world (absX,absY) — either
// directly under #world, or inside `host`'s content wrapper (offset by the host's own border so
// content never draws under the frame's border stroke). Shared by every hosted element: a plain
// card, a frame's own box, and a nested frame's own content wrapper.
// While a drag is live, dragged items live in #dragLayer (one opacity group) instead of directly
// under #world — so the whole dragged set composites translucently without shining through itself.
// Only DRAGGED nodes are painted mid-drag, so this only ever relocates them (and a dragged frame's
// own content wrapper); resting content is untouched. On drop ui.drag is nulled → back to #world.
function dragRoot(): HTMLElement { return (ui.drag && ui.drag.moved) ? dragLayer : world; }
function place(el: HTMLElement, absX: number, absY: number, host: MindNode | null): void {
  const container = host ? frameContentEl(host) : dragRoot();
  el.style.left = (host ? absX - host.x - FRAME_BORDER : absX) + 'px';
  el.style.top  = (host ? absY - host.y - FRAME_BORDER : absY) + 'px';
  if (el.parentElement !== container) container.appendChild(el);
}
// A frame's own clipping wrapper: a plain overflow:hidden box (styles.css .frame-content) sized to
// its INTERIOR (inside the border), holding every card/frame it hosts as flat DOM children. Created
// once and kept live (idempotent — safe to call from a child's paint before the frame's own paint
// runs in the same pass, since Map iteration order isn't parent-before-child).
function frameContentEl(f: MindNode): HTMLElement {
  let w = f.frameContentEl;
  if (!w) { w = document.createElement('div'); w.className = 'frame-content'; f.frameContentEl = w; }
  const box = frameInterior(f);
  place(w, box.x, box.y, settledHost(f));
  w.style.width  = box.w + 'px';
  w.style.height = box.h + 'px';
  return w;
}
// ---------- frame / image-card resize ----------
export const MIN_FRAME_W = NODE_W, MIN_FRAME_H = 120;   // a frame is never narrower than a normal card
export const MIN_IMAGE_W = 60, MIN_IMAGE_H = 60;        // an image card can shrink to a small thumbnail
function boxMinW(n: MindNode): number { return isImageBox(n) ? MIN_IMAGE_W : MIN_FRAME_W; }
function boxMinH(n: MindNode): number { return isImageBox(n) ? MIN_IMAGE_H : MIN_FRAME_H; }
// 8 resize handles: 4 edges (one axis) + 4 corners (two axes). A `w`/`n` component moves that edge,
// which shifts the frame's x/y (the opposite edge stays put); `e`/`s` just grow width/height.
const FRAME_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type FrameDir = typeof FRAME_DIRS[number];
// Ensure the frame has its 8 (invisible) resize hit-zones — one per edge/corner (added once,
// reused). No visible grip: the resize cursors on the border/corners are the affordance.
function ensureFrameHandle(n: MindNode): void {
  const el = n.el!; if (el.querySelector('.fh')) return;
  for (const dir of FRAME_DIRS) {
    const h = document.createElement('div');
    h.className = 'fh fh-' + dir;
    h.addEventListener('pointerdown', (e) => startFrameResize(e as PointerEvent, n, dir));
    el.appendChild(h);
  }
}
// Drag an edge/corner to resize. Work in edge coordinates (left/top/right/bottom) so the edges NOT
// being dragged stay fixed; the dragged edges snap to the grid and clamp to the min size. Top/left
// edges moving means the frame's x/y move too. Children inside are free, so only the parent's own
// layout reflows around the frame — done once on release, not every move.
// An image card's aspect ratio (width/height): the actual loaded image if hydrateImages has
// resolved it, else whatever the box currently shows (so an in-progress resize is stable even
// before the blob URL loads).
function imageAspect(n: MindNode): number {
  const img = n.el?.querySelector('img.md-img') as HTMLImageElement | null;
  if (img && img.naturalWidth && img.naturalHeight) return img.naturalWidth / img.naturalHeight;
  const w = n.w ?? IMAGE_W, h = n.h ?? IMAGE_H;
  return w / (h || 1);
}
function startFrameResize(e: PointerEvent, n: MindNode, dir: FrameDir): void {
  if (state.readOnly || isLockedEffective(n)) return;
  e.stopPropagation(); e.preventDefault();
  const minW = boxMinW(n), minH = boxMinH(n);
  const aspect = isImageBox(n) ? imageAspect(n) : null;   // width/height — locked while dragging an image card
  const flow = !!frameFlow(n);   // frame-h/frame-v: reflow its children live as the box resizes, not just on release
  const left0 = n.x, top0 = n.y, right0 = n.x + (n.w ?? boxDefaultW(n)), bottom0 = n.y + (n.h ?? boxDefaultH(n));
  const sx = e.clientX, sy = e.clientY;
  const west = dir.includes('w'), east = dir.includes('e'), north = dir.includes('n'), south = dir.includes('s');
  touch(n.id);
  let lastDx = 0, lastDy = 0;
  let subtreeRAF: number | null = null;
  const identity = (v: number): number => v;
  const snap = (v: number): number => Math.round(v / GRID_SNAP) * GRID_SNAP;
  // Apply the current drag delta, keeping the non-dragged edges fixed. We snap the SIZE (not the
  // edges) to the grid so a box's w/h are always multiples of the snap — the moving edge derives
  // from the fixed opposite edge minus the snapped size. Free (unsnapped) while dragging; snapped
  // on release. Clamped to the min size (also grid multiples).
  const resize = (round: (v: number) => number): void => {
    let left = left0, right = right0, top = top0, bottom = bottom0;
    if (aspect) {
      // Image card: whichever axis the user is actually dragging drives the size (grid-snapped);
      // the other axis is DERIVED from the image's own aspect ratio rather than dragged/snapped
      // independently. A corner drags both — drive by whichever axis implies the bigger relative
      // change, so the drag feels proportionate regardless of which corner is grabbed.
      const w0 = right0 - left0, h0 = bottom0 - top0;
      const hasX = east || west, hasY = north || south;
      let w = w0, h = h0;
      if (hasX && hasY) {
        const wCand = Math.max(minW, round(w0 + (east ? lastDx : -lastDx)));
        const hCand = Math.max(minH, round(h0 + (south ? lastDy : -lastDy)));
        if (Math.abs(wCand - w0) * h0 >= Math.abs(hCand - h0) * w0) { w = wCand; h = Math.max(minH, w / aspect); }
        else { h = hCand; w = Math.max(minW, h * aspect); }
      } else if (hasX) {
        w = Math.max(minW, round(w0 + (east ? lastDx : -lastDx)));
        h = Math.max(minH, w / aspect);
      } else if (hasY) {
        h = Math.max(minH, round(h0 + (south ? lastDy : -lastDy)));
        w = Math.max(minW, h * aspect);
      }
      left = west ? right0 - w : left0;  right = left + w;
      top  = north ? bottom0 - h : top0; bottom = top + h;
    } else {
      if (east)  { const w = Math.max(minW, round(right0 + lastDx - left0));  right = left0 + w; }
      if (west)  { const w = Math.max(minW, round(right0 - (left0 + lastDx))); left = right0 - w; }
      if (south) { const h = Math.max(minH, round(bottom0 + lastDy - top0));   bottom = top0 + h; }
      if (north) { const h = Math.max(minH, round(bottom0 - (top0 + lastDy))); top = bottom0 - h; }
    }
    n.x = left; n.y = top; n.w = right - left; n.h = bottom - top;
    n.dirty = true;
  };
  const move = (ev: PointerEvent): void => {
    lastDx = (ev.clientX - sx) / state.view.k; lastDy = (ev.clientY - sy) / state.view.k;
    resize(identity);
    paintNode(n); paintEdges();
    // A flow frame (frame-h/frame-v) arranges its children by wrapping them into the box's own
    // width/height — reflow them live as that box changes size, not just once on release, so the
    // wrap point visibly updates while dragging. Coalesced to once per animation frame (applyLayouts
    // walks every root's subtree, so it's not free) rather than once per raw pointermove.
    if (flow && !subtreeRAF) subtreeRAF = requestAnimationFrame(() => {
      subtreeRAF = null;
      applyLayouts(); paintAll();
    });
    // A north/west resize shifts the frame's own x/y, which shifts its content wrapper's origin —
    // repaint the whole subtree (not just direct children) so every hosted descendant's live,
    // wrapper-relative position compensates and stays put in absolute space as the box resizes
    // around it (an east/south-only resize doesn't move the origin, so this is skipped entirely).
    // subtreeIds walks the whole node map, so coalesce it to once per animation frame rather than
    // once per raw pointermove (which can fire far faster than the screen repaints). Skipped for a
    // flow frame — the applyLayouts()+paintAll() above already repaints the whole subtree.
    else if ((north || west) && !subtreeRAF) subtreeRAF = requestAnimationFrame(() => {
      subtreeRAF = null;
      for (const id of subtreeIds(n.id)) { const k = state.nodes.get(id); if (k) paintNode(k); }
    });
  };
  const up = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (subtreeRAF) { cancelAnimationFrame(subtreeRAF); subtreeRAF = null; }
    resize(snap);   // snap to the grid on release, like a dropped card
    applyLayouts(); paintAll(); scheduleSave(); commitStep();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
// Round every card's rendered height UP to the snap grid so all cards align on the 20px grid
// (frames/image cards size themselves). Done in three batches — reset → measure → apply — so it
// costs two layout flushes total, not two per card; the reset lets a shrunk card re-measure
// smaller (no ratcheting). Box nodes (which set their own box) and hidden cards are skipped.
function snapCardHeights(): void {
  const cards: MindNode[] = [];
  for (const n of state.nodes.values()) if (n.el && !isHidden(n) && !isBoxNode(n)) cards.push(n);
  for (const n of cards) n.el!.style.minHeight = '';
  const hs = cards.map(n => Math.ceil(n.el!.offsetHeight / GRID_SNAP) * GRID_SNAP);
  cards.forEach((n, i) => { n.el!.style.minHeight = hs[i] + 'px'; });
}
export function paintAll(): void {
  for (const n of state.nodes.values()) paintNode(n);
  snapCardHeights();
  paintEdges();
  updateEmptyHints();
  renderOutline();   // keep the outline list in sync (no-op while the canvas view is active)
}

// First-run hints ("Drag to create a card" / "Click for help") show only on an empty canvas.
// The help hint tracks the (centred, variable-x) help button; the ghost hint is CSS-anchored.
export function updateEmptyHints(): void {
  document.body.classList.toggle('empty-canvas', state.nodes.size === 0);
}

// ---------- animated relayout (expand / collapse) ----------
function prefersReducedMotion(): boolean { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
function placeNodeEl(n: MindNode): void { if (n.el) place(n.el, n.x, n.y, settledHost(n)); }
function setNodeElXY(n: MindNode, x: number, y: number): void { if (n.el) place(n.el, x, y, settledHost(n)); }
// Newly revealed cards emanate from the nearest ancestor that was already on screen.
function ancestorStart(node: MindNode, before: Map<string, Pt>): Pt {
  let p = node.parent ? state.nodes.get(node.parent) : null;
  while (p){ const b = before.get(p.id); if (b) return b; p = p.parent ? state.nodes.get(p.parent) : null; }
  return { x: node.x, y: node.y };
}
// Cards glide to new spots via a CSS transition; SVG edges can't transition, so for the duration
// we redraw them each frame from the cards' live (animating) on-screen positions.
function followEdges(tok: number, ms: number): void {
  const t0 = performance.now();
  const tick = (now: number): void => {
    if (tok !== ui.animToken) return;                  // superseded by a newer animation
    const saved: [MindNode, number, number][] = [];
    for (const n of state.nodes.values()){
      if (!n.el || isHidden(n)) continue;
      const c = getComputedStyle(n.el);             // interpolated left/top while transitioning
      saved.push([n, n.x, n.y]);
      // left/top are HOST-relative for a hosted card — project back to absolute world coords.
      const host = settledHost(n);
      const px = parseFloat(c.left), py = parseFloat(c.top);
      n.x = px ? (host ? px + host.x + FRAME_BORDER : px) : n.x;
      n.y = py ? (host ? py + host.y + FRAME_BORDER : py) : n.y;
    }
    paintEdges();
    for (const [n,x,y] of saved){ n.x = x; n.y = y; }   // restore logical (final) positions
    if (now - t0 < ms) requestAnimationFrame(tick); else paintEdges();
  };
  requestAnimationFrame(tick);
}
// Snapshot the on-screen position of every visible card — the START frame animateReflow
// glides away from. Take it BEFORE the structural change.
function layoutSnapshot(): Map<string, Pt> {
  const before = new Map<string, Pt>();
  for (const m of state.nodes.values()) if (m.el && !isHidden(m)) before.set(m.id, { x:m.x, y:m.y });
  return before;
}
// Run a structural change (a collapse toggle) and CSS-animate the resulting reflow.
function withLayoutAnimation(mutate: () => void): void {
  const before = layoutSnapshot();
  mutate();
  paintAll();          // reveal/hide DOM and measure real heights
  applyLayouts();      // compute FINAL positions into n.x/n.y (DOM not updated yet)
  animateReflow(before);
}
// CSS-animate every visible card from its snapshotted `before` spot to its current (final)
// n.x/n.y. Just-revealed cards (absent from `before`) fade in from their nearest ancestor.
function animateReflow(before: Map<string, Pt>): void {
  const visible = [...state.nodes.values()].filter(m => m.el && !isHidden(m));
  const tok = ++ui.animToken;                           // supersede any in-flight animation
  if (prefersReducedMotion()){ for (const m of visible){ m.el!.classList.remove('lt-anim'); placeNodeEl(m); } paintEdges(); return; }
  // 1) park every visible card at its STARTING spot with no transition; just-revealed cards
  //    also start invisible so they fade in (covers free layouts where nothing reflows)
  for (const m of visible){
    m.el!.classList.remove('lt-anim');
    const s = before.get(m.id) || ancestorStart(m, before);
    setNodeElXY(m, s.x, s.y);
    if (!before.has(m.id)) m.el!.style.opacity = '0';
  }
  void document.body.offsetWidth;                    // commit the start positions before transitioning
  // 2) turn on the transition and move every card to its FINAL spot → the browser animates left/top
  const DUR = 320;
  for (const m of visible){ m.el!.classList.add('lt-anim'); placeNodeEl(m); m.el!.style.opacity = ''; }
  // 3) edges follow the moving cards; drop the transition class once it's done
  followEdges(tok, DUR + 20);
  setTimeout(() => { if (tok !== ui.animToken) return; for (const m of visible) m.el && m.el.classList.remove('lt-anim'); paintEdges(); }, DUR + 60);
}

// ---------- edge style (straight / orthogonal / bezier), persisted ----------
const EDGE_KEY = 'mindmap.edgeStyle';
const EDGE_STYLES: EdgeStyle[] = ['orthogonal', 'bezier', 'straight'];
const EDGE_ICONS: Record<EdgeStyle, string> = { straight: edgeStraightIcon, orthogonal: edgeOrthogonalIcon, bezier: edgeBezierIcon };
// The toolbar button shows the ACTIVE style's icon (not a generic one); clicking cycles.
function updateEdgeIcon(): void {
  const span = document.querySelector('#edgeBtn .ic');
  if (span) span.innerHTML = EDGE_ICONS[state.edgeStyle];
  const btn = document.getElementById('edgeBtn');
  if (btn) btn.title = `Edge style: ${state.edgeStyle} — click to cycle`;
}
function initEdgeStyle(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem(EDGE_KEY); } catch {}
  if (saved && (EDGE_STYLES as string[]).includes(saved)) state.edgeStyle = saved as EdgeStyle;
  updateEdgeIcon();
}
function cycleEdgeStyle(): void {
  const i = EDGE_STYLES.indexOf(state.edgeStyle);
  state.edgeStyle = EDGE_STYLES[(i + 1) % EDGE_STYLES.length];
  try { localStorage.setItem(EDGE_KEY, state.edgeStyle); } catch {}
  updateEdgeIcon();
  paintEdges();
  setStatus(`Edge style: ${state.edgeStyle}`);
}
initEdgeStyle();

// Toggle one node's collapse: folds it down to just its title — hides its body and, if it has
// children, folds them (and everything below) too. A leaf with a body can fold its body alone.
export function toggleCollapse(id: string): void {
  const n = state.nodes.get(id); if (!n) return;
  if (isLockedEffective(n)) { setStatus('Locked — can’t collapse/expand'); return; }
  const hasKids = childrenOf(n.id).length > 0;
  const hasBody = !!(n.body && n.body.trim());
  if (!hasKids && !hasBody) return;   // nothing to fold: no children and no body
  // animate the reflow; withLayoutAnimation paints, measures heights, and lays out the children
  record([id], () => withLayoutAnimation(() => { n.collapsed = !n.collapsed; n.dirtyLayout = true; }));
  scheduleSave();
  setStatus(n.collapsed ? `Collapsed “${n.title}”` : `Expanded “${n.title}”`);
}
// Fold/unfold a whole set of cards together (double-clicking one card of a multi-selection).
// Only foldable cards (children or a body) count; the group lands on one shared state — expand
// if they're all collapsed already, otherwise collapse them all.
export function toggleCollapseSelection(ids: Iterable<string>): void {
  const cards = [...ids].map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n)
    .filter(n => !isLockedEffective(n))
    .filter(n => childrenOf(n.id).length > 0 || !!(n.body && n.body.trim()));
  if (!cards.length) return;
  const target = !cards.every(n => n.collapsed);   // all collapsed → expand; otherwise collapse all
  record(cards.map(n => n.id),
    () => withLayoutAnimation(() => { for (const n of cards){ n.collapsed = target; n.dirtyLayout = true; } }));
  scheduleSave();
  setStatus(`${target ? 'Collapsed' : 'Expanded'} ${cards.length} card${cards.length > 1 ? 's' : ''}`);
}
// Flip a checklist item's done mark (mm_done) and persist. Independent of any body task list.
// Also repaints the parent so its "n/m" checklist progress readout stays in sync.
// Exported: the outline row list shows the same donebox/progress readout (features/outline.ts).
export function toggleDone(n: MindNode): void {
  if (state.readOnly || isLockedEffective(n)) return;
  record([n.id], () => { n.done = !n.done; n.dirty = true; });
  paintNode(n);
  if (n.parent){ const p = state.nodes.get(n.parent); if (p) paintNode(p); }
  scheduleSave();
}
// Lock/unlock every selected card (context menu). Locking freezes that card in place — no move,
// (un)collapse, rename/body/color/type/layout edit, add-child, or delete — and cascades so its
// whole subtree becomes unselectable too (see utils/model.ts). Unlocking never touches descendants
// (lock is per-card, not stored on them). A descendant of a locked ancestor can't be selected, so
// it never reaches this function as a target; only cards actually selectable can be (un)locked.
export function setLockedSelection(ids: Iterable<string>, locked: boolean): void {
  if (state.readOnly) return;
  const cards = [...ids].map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n && n.locked !== locked);
  if (!cards.length) return;
  record(cards.map(n => n.id), () => { for (const n of cards){ n.locked = locked; n.dirty = true; } });
  paintAll();
  scheduleSave();
  setStatus(`${locked ? 'Locked' : 'Unlocked'} ${cards.length} card${cards.length===1?'':'s'}`);
}
// Flip the idx-th task checkbox in a node's body and write the change back to disk.
function toggleTask(n: MindNode, idx: number): void {
  if (state.readOnly || isLockedEffective(n)) return;
  let i = 0;
  record([n.id], () => {
    n.body = n.body.replace(/^(\s*[-*+]\s+)\[([ xX])\]/gm, (m, pre, mark) =>
      i++ === idx ? pre + (mark === ' ' ? '[x]' : '[ ]') : m);
    n.dirty = true;
  });
  if (ui.bodyEdit && ui.bodyEdit.id === n.id) ui.bodyEdit.ta.value = n.body;   // keep an open in-card editor in sync
  paintNode(n); scheduleSave();
}

// ---------- node dragging + reparent-by-drop live in features/drag.ts ----------
export function subtreeIds(id: string): string[] {
  // id + every descendant
  const out = [id];
  for (const ch of childrenOf(id)) out.push(...subtreeIds(ch.id));
  return out;
}
// ---------- pan / zoom / marquee-select gestures live in features/gestures.ts ----------


// Focus a card: un-collapse hiding ancestors (and, when openTarget, the card itself), select
// it, frame it + all its visible descendants. Ancestors are expanded shallowest-first with a
// layout pass after EACH level, so every newly revealed level lays out on the already-settled
// positions above it — expanding a nested chain in one shot mis-spaces the shallow branches.
export function focusNode(target: MindNode | undefined, openTarget = false): void {
  if (!target) return;
  const before = layoutSnapshot();             // pre-reveal frame to glide away from
  const toReveal: MindNode[] = [];
  for (let p = target.parent ? state.nodes.get(target.parent) : null; p; p = p.parent ? state.nodes.get(p.parent) : null)
    toReveal.push(p);
  toReveal.reverse();                          // root → immediate parent (shallowest first)
  if (openTarget) toReveal.push(target);       // open the card itself last (deepest level)
  let revealed = false;
  record(toReveal.map(n => n.id), () => {
    for (const n of toReveal){
      if (!n.collapsed) continue;
      n.collapsed = false; n.dirtyLayout = true; revealed = true;
      paintAll(); applyLayouts();              // settle this level before revealing the next
    }
  });
  selectNode(target.id);                       // select → the card shows its full body (grows)
  applyLayouts(); paintAll();                  // reflow siblings around the now-taller selection
  animateReflow(before);                       // one glide from the pre-reveal frame to the final
  frameBox(subtreeIds(target.id).map(id => state.nodes.get(id)));
  if (revealed && store.isOpen) scheduleSave();
}
// Follow a [[wikilink]]: find the node by title (case-insensitive) and focus it.
function focusByTitle(title: string): void {
  const t = title.trim().toLowerCase();
  const target = [...state.nodes.values()].find(n => n.title.trim().toLowerCase() === t);
  if (!target){ setStatus(`No node titled “${title}” in this map`); return; }
  focusNode(target);
}
// The "focus" command (toolbar button + F): frame the selected card (+ its subtree), or
// frame the whole map when nothing is selected — both glide with the same easing.
function focusOrFit(): void {
  if (state.selId && state.nodes.has(state.selId)) focusNode(state.nodes.get(state.selId));
  else frameBox([...state.nodes.values()], true);   // frame the whole map — strokes included
}

// ---------- selection + editor ----------
// Selection and the edit panel are decoupled: a node can stay selected while the
// panel is closed (press Esc). That closed-but-selected state is when Delete works.

// colour palette (keys match the .c-* CSS classes); 'grey' is the old neutral "none" look.
// The hexes themselves live in ONE place — the --pal-* custom properties in styles.css's
// :root/body.light — so CSS (.c-*, #ghostCard) and JS (edges/backgrounds fills, swatch dots
// below) can never drift apart. Read from document.body (not documentElement) so the
// body.light overrides are picked up; re-read on every theme toggle (see refreshPalette).
export const PALETTE = ['slate','red','amber','green','teal','blue','violet','pink','grey','white'];
const pal = (name: string): string => getComputedStyle(document.body).getPropertyValue(`--pal-${name}`).trim();
// `black` is NOT a pickable swatch — it's only the contrast fill for an inherit-bg annotation on the
// light canvas (see effectiveColor). Tracked in SWATCH_BG (and refreshPalette) so its edge/anchor tint
// resolves like any other colour key.
const SWATCH_KEYS = [...PALETTE, 'black'];
export const SWATCH_BG: Record<string, string> = Object.fromEntries(SWATCH_KEYS.map(c => [c, pal(c)]));
// re-derive the palette hexes after a theme switch (light/dark have different --pal-* values)
// and repaint everything that bakes them in as literal hex (edges, group backgrounds, swatches).
export function refreshPalette(): void {
  for (const c of SWATCH_KEYS) SWATCH_BG[c] = pal(c);
  refreshSwatches();
  paintAll();
}
// the ids currently being edited (one or many) — colour/layout/checklist/bg apply to all of them
export function selectedIds(): string[] { return state.sel.size ? [...state.sel] : (state.selId ? [state.selId] : []); }
// reflect state.sel in the canvas + the floating edit bar (features/float-bar.ts)
export function applySelection(): void { paintAll(); syncFloatBar(); }
// A descendant of a locked card can't be selected at all — the locked card itself still can be
// (see utils/model.ts hasLockedAncestor). Shared by every selection entry point below.
function isSelectable(id: string): boolean {
  const n = state.nodes.get(id); return !n || !hasLockedAncestor(n);
}
// Replace the whole selection with `ids` (a Set or array), recomputing the primary.
export function setSelectionSet(ids: Iterable<string>): void {
  state.sel = new Set([...ids].filter(isSelectable));
  if (state.sel.size === 0) state.selId = null;
  else if (state.sel.size === 1) state.selId = [...state.sel][0];
  else if (!state.selId || !state.sel.has(state.selId)) state.selId = [...state.sel].pop() ?? null;
  applySelection();
}
// ⌘/Ctrl-click: add or remove one card from the selection.
export function toggleSel(id: string): void {
  if (state.sel.has(id)){
    state.sel.delete(id);
    if (state.selId === id) state.selId = state.sel.size ? ([...state.sel].pop() ?? null) : null;
  } else {
    if (!isSelectable(id)) return;
    state.sel.add(id); state.selId = id;
  }
  applySelection();
}

syncFloatBar();

// ---------- read-only mode ----------
// View & collapse only: nothing saves, the sidebar hides, editing icons grey out, and the
// add-child + is hidden. Collapsing is allowed but in-memory only — leaving read-only reloads
// from disk so the saved collapse state is restored.
const roBtn = byId('roBtn');
// closed padlock (locked) vs open padlock (unlocked)
const ICON_LOCK_CLOSED = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
const ICON_LOCK_OPEN   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>`;
export function applyReadOnly(): void {
  const ro = state.readOnly;
  document.body.classList.toggle('readonly', ro);
  roBtn.classList.toggle('locked', ro);          // red when locked
  roBtn.innerHTML = ro ? ICON_LOCK_CLOSED : ICON_LOCK_OPEN;
  roBtn.title = ro ? 'Read-only — click to unlock & edit (R)' : 'Lock to read-only (R) — view & collapse only';
  // ghost card visibility is driven by body.readonly CSS rule
  updateUndoButtons();
  syncFloatBar();
  setStatus(ro ? 'Read-only — nothing is saved' : 'Editing enabled');
}
applyReadOnly();   // set the initial open-padlock icon
async function setReadOnly(on: boolean): Promise<void> {
  if (on === state.readOnly) return;
  if (on){
    await flushSave();                                   // persist anything pending before locking (clears the save timer)
    state.readOnly = true;
    // sketching stays available in read-only, but any strokes made there are in-memory only:
    // leaving read-only reloads sketch.json below, discarding them (like the collapse state).
    selectNode(null);                                    // close any open edit
  } else {
    state.readOnly = false;
    if (store.isOpen) await loadFromDir({ keepView:true }); // discard in-memory collapses, restore disk state
  }
  applyReadOnly();
}
roBtn.onclick = () => setReadOnly(!state.readOnly);

// Select exactly one node (or clear with null), replacing any multi-selection.
export function selectNode(id: string | null): void {
  if (id == null){ state.sel.clear(); state.selId = null; }
  else { if (!isSelectable(id)) return; state.sel = new Set([id]); state.selId = id; }
  applySelection();
}
// Colour / checklist / group-background / layout all apply live via the floating bar
// (features/float-bar.ts). The TITLE and BODY are edited on the canvas (F2 / slow-click → inline edit).


// ---------- image attachments live in features/attachments.ts ----------
// ---------- inline title/body editing lives in features/inline-edit.ts ----------
// While a title is being renamed inline, the save loop defers the file rename until editing ends
// (so the folder isn't littered with M.md, Ma.md, Mag.md…) — it keys off `ui.inlineEdit` directly.

// keyboard:
//  · Space          → new node at the pointer (only when nothing is selected)
//  · Enter          → add a sibling of the selected node
//  · Tab            → add a child of the selected node
//  · F2             → rename the selected node in place (also: slow-click its title)
//  · X              → collapse/eXpand the selected node(s) (also: double-click)
//  · E              → edit the selected node's note/body in place (also: slow-click the body)
//  · Delete/Backspace → delete the selected node (only when the edit panel is closed)
// A focused title editor (the sidebar field OR an in-card inline rename) counts as "typing",
// so these card shortcuts stay out of the way while you're naming something.
window.addEventListener('keydown', (e) => {
  // F1 opens the bundled help mindmap (read-only) in a new tab — works even while typing.
  if (e.key === 'F1'){ e.preventDefault(); openHelpTab(); return; }

  // Intercept browser zoom shortcuts (Cmd/Ctrl +/-/0) so they drive the canvas, not the viewport.
  // Must be checked before the `typing` guard so they work even while a text field is focused.
  if (e.metaKey || e.ctrlKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomAt(window.innerWidth/2, window.innerHeight/2, 1.2); return; }
    if (e.key === '-')                  { e.preventDefault(); zoomAt(window.innerWidth/2, window.innerHeight/2, 1/1.2); return; }
    if (e.key === '0')                  { e.preventDefault(); focusOrFit(); return; }
  }

  const active = document.activeElement as HTMLElement | null;
  const typing = isTypingInField();
  // Esc blurs the active field (so Delete works next), or deselects when not typing.
  if (e.key === 'Escape'){
    e.preventDefault();
    if (typing) { active?.blur?.(); }
    else if (state.sel.size) selectNode(null);
    return;
  }
  if (typing) return;
  if (e.key === 'r' || e.key === 'R'){ e.preventDefault(); setReadOnly(!state.readOnly); return; }
  if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey){ e.preventDefault(); if (!outlineActive()) toggleSketchMode(); return; }   // Sketch mode (canvas only)
  if ((e.key === 'o' || e.key === 'O') && !e.metaKey && !e.ctrlKey){ e.preventDefault(); toggleOutlineView(); return; }   // Outline view
  if (e.key === '/'){ e.preventDefault(); openSearch(); return; }   // find a card
  // Space = hand-tool to pan while held; a quick tap (released without panning) makes a node.
  if (e.key === ' '){ e.preventDefault(); if (!e.repeat){ ui.spaceHeld = true; ui.spaceUsedForPan = false; } return; }
  if (e.key === 'f' || e.key === 'F'){ e.preventDefault(); focusOrFit(); return; }
  if ((e.key === 'd' || e.key === 'D') && state.sel.size){ e.preventDefault(); duplicateSelection(); return; }
  if ((e.key === 'a' || e.key === 'A') && e.shiftKey && !e.metaKey && !e.ctrlKey && state.sel.size){ e.preventDefault(); autoSizeSelection(); return; }   // ⇧A: auto-size selected frames to fit
  // A -> create an annotation at the cursor (mirrors Space's new-card tap). If a card is selected
  // the annotation becomes its child; otherwise it's a root. ⇧A is auto-size (handled just above).
  if ((e.key === 'a' || e.key === 'A') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !outlineActive()){
    e.preventDefault();
    const p = ui.lastMouse ? screenToWorld(ui.lastMouse.x, ui.lastMouse.y) : screenToWorld(window.innerWidth/2, window.innerHeight/2);
    createAnnotationHere(p.x - 80, p.y - 16);
    return;
  }
  // ⌘/Ctrl C / X copy / cut the selected cards (with their subtrees). No ⌘V handler here —
  // the native `paste` event (features/attachments.ts) carries clipboardData permission-free.
  if ((e.key === 'c' || e.key === 'C') && (e.metaKey || e.ctrlKey) && state.sel.size){
    e.preventDefault(); void copySelection(); return;
  }
  if ((e.key === 'x' || e.key === 'X') && (e.metaKey || e.ctrlKey) && state.sel.size){
    e.preventDefault(); void cutSelection(); return;
  }
  if ((e.key === 'x' || e.key === 'X') && state.sel.size && !e.metaKey && !e.ctrlKey){   // don't shadow cut
    e.preventDefault(); toggleCollapseSelection(state.sel); return;
  }
  if ((e.key === 'l' || e.key === 'L') && state.sel.size && !e.metaKey && !e.ctrlKey && !state.readOnly){
    e.preventDefault();
    const anyLocked = [...state.sel].some(id => isLockedEffective(state.nodes.get(id)!));
    setLockedSelection(state.sel, !anyLocked);
    return;
  }
  // image cards have no title/body UI to rename or edit — they're a leaf that shows only the image
  if (e.key === 'F2' && state.selId && !isImageCard(state.nodes.get(state.selId))){
    e.preventDefault(); startInlineEdit(state.nodes.get(state.selId)); return;   // selId guards non-null
  }
  if ((e.key === 'e' || e.key === 'E') && state.selId && !e.metaKey && !e.ctrlKey){
    e.preventDefault(); const n = state.nodes.get(state.selId); if (n && !isImageCard(n)) startBodyEdit(n); return;
  }
  if (e.key === 'Enter' && state.selId){ e.preventDefault(); createSibling(state.selId); return; }
  if (e.key === 'Tab' && state.selId){ e.preventDefault(); addChild(state.selId); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel.size){
    e.preventDefault(); deleteSelection();
  }
});
// Track the mouse so keyboard/clipboard actions (Space-tap, paste) land AT the pointer.
window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') ui.lastMouse = { x: e.clientX, y: e.clientY };
});
window.addEventListener('keyup', (e) => {
  if (e.key !== ' ') return;
  const wasPan = ui.spaceUsedForPan;
  ui.spaceHeld = false; ui.spaceUsedForPan = false;
  if (isTypingInField() || wasPan || ui.pan || state.sel.size !== 0) return;
  if (outlineActive()) return;   // no invisible cards onto the hidden canvas
  if (ui.lastMouse){         // tap = new card under the cursor (centre when the mouse hasn't moved yet)
    const p = screenToWorld(ui.lastMouse.x, ui.lastMouse.y);
    createNode({ x: p.x - 100, y: p.y - 32 });
  } else createNode();
});

// Ghost-card drag: grab the corner card to spawn a new note that rides the cursor through the same
// move/reparent machinery as dragging an existing card — so the landing-ghost preview, child/sibling
// drop zones and managed-layout snapping all behave identically. Releasing back on the ghost cancels.
{
  const ghost = byId('ghostCard');
  let newNode: MindNode | null = null;

  // Move/up are handled on `window`, not the ghost, so the drop commits no matter where the pointer
  // is released or whether pointer-capture survived the mid-drag re-renders (a lost capture used to
  // deliver pointerup to the card underneath, whose handler ignores it — leaving the ghost stuck and
  // nothing created). setPointerCapture is still requested (best-effort) so the dragged card's own
  // handlers stay quiet; capture events bubble to window regardless.
  function endGhostDrag(): MindNode | null {
    const n = newNode;
    newNode = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    return n;
  }
  function onMove(e: PointerEvent): void { if (newNode) feedDragMove(e.clientX, e.clientY); }
  function onUp(e: PointerEvent): void {
    const n = endGhostDrag();
    if (!n) return;
    // released back on the ghost card itself -> cancel: discard the new card, create nothing
    const r = ghost.getBoundingClientRect();
    const onGhost = e.clientX >= r.left && e.clientX <= r.right &&
                    e.clientY >= r.top  && e.clientY <= r.bottom;
    if (onGhost) { abortDrag(); deleteNode(n.id); commitStep(); return; }   // nets null→null, discarded
    commitDrag();                          // land / reparent exactly where the preview showed
    startInlineEdit(n, { isNew: true });   // drop straight into renaming; Esc cancels creation
  }
  function onCancel(): void {
    const n = endGhostDrag();
    if (n) { abortDrag(); deleteNode(n.id); commitStep(); }   // nets null→null, discarded
  }

  ghost.addEventListener('pointerdown', (e: PointerEvent) => {
    if (state.readOnly) return;
    e.preventDefault();
    endInlineEdit(); endBodyEdit();         // grabbing the ghost commits any in-progress edit
    // anchor the new card at the grab offset within the ghost (i.e. the ghost's own top-left in
    // world space), then drive it with the real drag so it rides the cursor at that same offset
    const r = ghost.getBoundingClientRect();
    const w = screenToWorld(r.left, r.top);
    newNode = createDetachedNode(w.x, w.y) ?? null;
    if (!newNode) return;
    try { ghost.setPointerCapture(e.pointerId); } catch { /* no active pointer (e.g. synthetic) */ }
    startNodeDrag(newNode, e.clientX, e.clientY);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  });
}
byId('fitBtn').onclick = focusOrFit;
byId('edgeBtn').onclick = cycleEdgeStyle;
byId('homeBtn').onclick = showStart;   // icon + folder name → home screen
byId('helpBtn').onclick = openHelpTab;  // same as F1 — opens the help mindmap in a new tab

// (rename/duplicate/export/delete on-screen actions now live in the floating bar's kebab menu —
// features/float-bar.ts)

// keyboard shortcuts: ⌘S force-save, ⌘Z/⇧⌘Z/⌘Y undo-redo  (duplicate = D, new node = Space)
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); flushSave(); return; }
  // While typing in a field, leave ⌘Z to the browser's native undo inside that editor.
  if (k === 'z' && !isTypingInField()) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (k === 'y' && !isTypingInField()) { e.preventDefault(); redo(); }
});


boot();   // local-first: open straight into the last map
