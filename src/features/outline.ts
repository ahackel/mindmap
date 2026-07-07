// ---------- outline mode: the map as a collapsible tree list ----------
// An alternative VIEW over the same nodes (body.outline hides the canvas, rows render into
// #outline), aimed at phones — reading, quick capture and light editing without the 2D canvas.
// Toggled by the toolbar button / the O key; the choice persists per device (VIEW_KEY).
// Sibling order is exactly the canvas order (orderedKids). Expand/collapse via the row's disc
// is a REAL toggle — it calls the same toggleCollapse() the canvas uses, so it mirrors mm_collapsed
// on disk and what the canvas shows. Ancestor-reveal while just BROWSING (search jump, "scroll to
// this card after a reparent") stays VIEW-LOCAL instead (outlineFold below) — it never rewrites
// mm_collapsed, so jumping around the tree doesn't silently expand/save a pile of ancestors. All
// edits reuse the existing kernels (crud / drag reparent / history), so undo, autosave and
// read-only behave the same as on the canvas.
import { state, setStatus, type MindNode } from '../core/state.js';
import { NARROW_MQ } from '../core/ui-state.js';
import { childrenOf, isRoot, isAncestor, descendantCount } from '../utils/model.js';
import { orderedKids, sideOf, deriveSide, orderAxisIsX, applyLayouts } from '../view/layout.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, selectNode, focusNode, effectiveColor, subtreeIds, nodeH, NODE_W, toggleCollapse } from '../main.js';
import { openBranchEditor, closeBranchEditor, branchEditorOpen, addToBranch } from './branch-editor.js';
import { openEditorSheet } from './editor-sheet.js';
import { addChild, createNode, deleteNode, duplicateSelection } from './crud.js';
import { reparentOnly } from './drag.js';
import { openMenu } from './context-menu.js';
import { touch, commitStep } from './history.js';
import TRI from '../assets/icons/chevron.svg?raw';
import GRIP from '../assets/icons/grip.svg?raw';

const outlineScrollEl = document.getElementById('olScroll') as HTMLElement;
const rowsEl = document.getElementById('olRows') as HTMLElement;
const outlineBtn = document.getElementById('outlineBtn') as HTMLButtonElement;

// ---- view-local fold state (browsing-only reveals — see the header comment) ----
// Keyed by the node's FILE (ids are re-minted on every disk reload), falling back to the id
// for never-saved nodes. Absent → follow the map's saved mm_collapsed, so a fresh session
// starts from the same shape as the canvas. Deliberately NOT persisted across restarts. An
// EXPLICIT disc click bypasses this entirely (see rowFor) and toggles the real n.collapsed.
const outlineFold = new Map<string, boolean>();
const foldKey = (n: MindNode): string => n.file ?? n.id;
const isFolded = (n: MindNode): boolean => outlineFold.get(foldKey(n)) ?? n.collapsed;
const unfold = (n: MindNode): void => { outlineFold.set(foldKey(n), false); };

// The node's ancestor chain, nearest parent first. Shared by the reveal (unfold up the chain)
// and the picker breadcrumb.
function* ancestors(n: MindNode): Generator<MindNode> {
  for (let p = n.parent ? state.nodes.get(n.parent) : null; p; p = p.parent ? state.nodes.get(p.parent) : null)
    yield p;
}
// Roots in the outline's canonical top-level order (canvas y, then x; filename as a stable tie).
// Exported: branch-editor.ts's root sibling group uses the same order.
export function sortedRoots(exclude?: string): MindNode[] {
  return [...state.nodes.values()].filter(n => isRoot(n) && n.id !== exclude)
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.file ?? a.title).localeCompare(b.file ?? b.title));
}

// ---- mode toggle (persisted like theme / edge style) ----
const VIEW_KEY = 'mindmap.viewMode';   // 'canvas' | 'outline'
export function outlineActive(): boolean { return document.body.classList.contains('outline'); }
// On narrow screens (phones) the 2D canvas is impractical, so outline is FORCED on and can't be
// toggled off — the toolbar button is hidden (CSS) and the O shortcut / toggle no-op here.
function outlineForced(): boolean { return NARROW_MQ.matches; }
export function toggleOutlineView(): void { if (!outlineForced()) setOutline(!outlineActive()); }
// `persist` records the choice as the user's WIDE-screen preference; forced/auto switches pass
// false so visiting on a phone doesn't overwrite what they picked on desktop.
function setOutline(on: boolean, persist = true): void {
  if (on === outlineActive()) return;
  if (document.body.classList.contains('sketching')) { setStatus('Leave sketch mode first (S)'); return; }
  if (!on) closeBranchEditor();   // leaving outline: drop any open branch editor first
  document.body.classList.toggle('outline', on);
  outlineBtn.classList.toggle('active', on);
  if (persist) { try { localStorage.setItem(VIEW_KEY, on ? 'outline' : 'canvas'); } catch {} }
  if (on) renderOutline();
  // back to the canvas: orient at whatever you were just reading in the list
  else if (state.selId) focusNode(state.nodes.get(state.selId), true);
}
outlineBtn.onclick = toggleOutlineView;
// The effective mode for the current width: forced on when narrow, else the saved preference.
function wantOutline(): boolean {
  try { return outlineForced() || localStorage.getItem(VIEW_KEY) === 'outline'; }
  catch { return outlineForced(); }   // no localStorage → only the forced (narrow) case
}
// Runtime switch when the viewport crosses the 700px breakpoint (rotate / resize): a full
// setOutline, incl. the list re-render / canvas refocus. Safe here — main.ts is fully evaluated.
NARROW_MQ.addEventListener('change', () => setOutline(wantOutline(), false));
// Initial application at IMPORT time: set the body class ONLY — never setOutline/renderOutline.
// renderOutline reaches into main.ts (effectiveColor / nodeH / …), which is still mid-evaluation
// during this circular main↔outline import; calling it here throws. boot()'s first paintAll()
// renders the list (paintAll → renderOutline), so setting the class alone is enough + flash-free.
if (wantOutline()) { document.body.classList.add('outline'); outlineBtn.classList.add('active'); }

// ---- rendering ----
// Full rebuild — called from paintAll() so every mutation path (crud, undo, reload, selection)
// keeps the list in sync for free; a no-op while the canvas view is active. Cheap at this
// app's scale; scroll position is preserved across rebuilds.
export function renderOutline(): void {
  if (!outlineActive()) return;
  if (rowDragActive) return;   // a rebuild would replace the row mid-drag (e.g. autosave's paintAll)
  // #olRows is display:none while the branch editor is open (styles.css), and every keystroke in
  // its cards/props sheet already calls paintAll() — skip the wasted full rebuild while it's hidden.
  if (branchEditorOpen()) return;
  const scroll = outlineScrollEl.scrollTop;
  rowsEl.textContent = '';
  for (const r of sortedRoots()) walk(r, 0);
  outlineScrollEl.scrollTop = scroll;
}
function walk(n: MindNode, depth: number): void {
  const kids = childrenOf(n.id);
  rowsEl.appendChild(rowFor(n, depth, kids));
  if (isFolded(n)) return;
  for (const k of orderedKids(n, kids)) walk(k, depth + 1);
}
function rowFor(n: MindNode, depth: number, kids: MindNode[]): HTMLElement {
  const folded = isFolded(n);
  const row = document.createElement('div');
  // rows carry the card's colour as their background via the shared .c-* classes (like .node)
  row.className = `ol-row c-${effectiveColor(n)}` + (state.sel.has(n.id) ? ' sel' : '');
  row.dataset.id = n.id;
  row.style.marginLeft = (depth * 18) + 'px';   // indent the whole card, not just its content

  const disc = document.createElement('button');
  disc.className = 'ol-disc' + (kids.length ? (folded ? '' : ' open') : ' leaf');
  disc.innerHTML = TRI;
  disc.title = folded ? 'Expand' : 'Collapse';
  disc.setAttribute('aria-label', (folded ? 'Expand' : 'Collapse') + ` “${n.title}”`);
  // an EXPLICIT collapse/expand toggle mirrors the canvas (unlike the ancestor-reveal unfolds
  // below, which stay view-local) — toggleCollapse mutates n.collapsed and persists, then
  // paintAll's renderOutline() call repaints this row. Drop any stale local override so the row
  // reflects that fresh canvas truth rather than a shadow left over from a browsing-reveal.
  disc.onclick = () => { outlineFold.delete(foldKey(n)); toggleCollapse(n.id); };

  const title = document.createElement('span');
  title.className = 'ol-title';
  title.textContent = n.title;
  // tapping a row opens the branch editor (this card + siblings as full cards, see branch-editor.ts);
  // read-only sessions can't edit, so they fall back to the sheet as a viewer for the note.
  title.onclick = () => { if (state.readOnly) { selectNode(n.id); openEditorSheet(n); } else openBranchEditor(n.id); };

  row.append(disc, title);
  if (n.body && n.body.trim()) {
    // "has a note" marker = the same empty white disc a collapsed leaf shows on the canvas
    // (main.ts paintNode: the hidden-count bubble with no number), not a burger icon.
    const note = document.createElement('span');
    note.className = 'ol-note'; note.title = 'Has a note';
    row.appendChild(note);
  }
  if (folded && kids.length) {
    const count = document.createElement('span');
    count.className = 'ol-count'; count.textContent = String(descendantCount(n.id));
    row.appendChild(count);
  }
  if (!state.readOnly) {
    const drag = document.createElement('button');
    drag.className = 'ol-drag'; drag.innerHTML = GRIP; drag.title = 'Drag to reorder';
    drag.setAttribute('aria-label', `Drag “${n.title}” to reorder`);
    drag.addEventListener('pointerdown', (e) => startRowDrag(e, n, row, drag));
    const more = document.createElement('button');
    more.className = 'ol-more'; more.textContent = '⋮'; more.title = 'Card actions';
    more.setAttribute('aria-label', `Actions for “${n.title}”`);
    more.onclick = () => { const r = more.getBoundingClientRect(); openRowMenu(n, r.left, r.bottom + 4); };
    row.append(drag, more);
  }
  return row;
}

// New-card button (floating +): in the branch editor it adds a card to the open group (a sibling
// of the anchor); in the list it adds a child of the selected card, else a fresh root card.
// Either way the routed startInlineEdit opens the new card for editing.
const olAddBtn = document.getElementById('olAddBtn') as HTMLButtonElement;
olAddBtn.onclick = () => {
  if (state.readOnly) return;
  if (branchEditorOpen()) { addToBranch(); return; }
  const sel = state.selId ? state.nodes.get(state.selId) : undefined;
  if (sel) { unfold(sel); addChild(sel.id); }
  else createNode();
};

// Unfold the hit's ancestors, select it and scroll it into view — the outline counterpart of
// the canvas' focusNode reveal; used by the search dropdown (features/search.ts).
export function revealInOutline(id: string): void {
  const n = state.nodes.get(id); if (!n) return;
  for (const p of ancestors(n)) unfold(p);
  selectNode(id);   // applySelection → paintAll → renderOutline, so the row exists now
  const row = rowsEl.querySelector<HTMLElement>(`.ol-row[data-id="${id}"]`);
  if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); }
}

// ---- row actions (⋯ menu — reuses the canvas context menu surface) ----
// Deliberately minimal: rename/add/move all have direct affordances (tap to edit, the + button,
// the ⠿ drag handle), so the menu is just Duplicate + Delete.
function openRowMenu(n: MindNode, x: number, y: number): void {
  openMenu([
    { label: 'Duplicate', shortcut: 'D', run: () => { selectNode(n.id); duplicateSelection({ edit: false }); } },
    { label: 'Delete', shortcut: 'Del', run: () => deleteNode(n.id), danger: true },
  ], x, y);
}

// ---- reorder (Move up / Move down) ----
// Position helpers that walk the WHOLE subtree regardless of visibility — layout.ts's
// subtreeBox/shiftSubtree skip hidden nodes, but a reorder under a canvas-collapsed parent
// must still move the (hidden) cards: kidOrder is in-memory only and layoutSubtree skips
// collapsed parents, so the rewritten positions are the ONLY thing that persists the order.
function shiftWhole(n: MindNode, dx: number, dy: number): void {
  if (!dx && !dy) return;
  for (const id of subtreeIds(n.id)) {
    const m = state.nodes.get(id);
    if (m) { m.x += dx; m.y += dy; m.dirtyLayout = true; }
  }
}
// A subtree's extent along one axis (visibility-independent, unlike subtreeBox).
function extentAlong(n: MindNode, axisX: boolean): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const id of subtreeIds(n.id)) {
    const m = state.nodes.get(id); if (!m) continue;
    const a = axisX ? m.x : m.y;
    min = Math.min(min, a);
    max = Math.max(max, a + (axisX ? NODE_W : nodeH(m)));
  }
  return { min, max };
}
// Commit a new order for one side bucket: updates the stored kidOrder (what a visible line/fan
// relayout packs by) AND re-packs the bucket's subtrees sequentially along the ordering axis.
// kidOrder is never saved, so the next load re-derives order from positions (kidsByPosition
// sorts by subtree-box midpoint) — sequential non-overlapping packing is the one arrangement
// that's guaranteed to re-derive to exactly this order, whatever the subtree sizes.
function reorderBucket(parent: MindNode, sibs: MindNode[], newOrder: MindNode[], axisX: boolean): void {
  touch(parent.id, ...sibs.flatMap(s => subtreeIds(s.id)));   // pre-images incl. kidOrder
  const inBucket = new Set(newOrder.map(s => s.id));
  const queue = [...newOrder];
  parent.kidOrder = orderedKids(parent, childrenOf(parent.id))
    .map(k => (inBucket.has(k.id) ? queue.shift()!.id : k.id));
  const GAP = 12;   // matches layout.ts LAYOUT_CHAIN
  const extent = new Map(newOrder.map(s => [s.id, extentAlong(s, axisX)]));   // one subtree walk each
  let cur = Math.min(...sibs.map(s => (extent.get(s.id) ?? extentAlong(s, axisX)).min));
  for (const s of newOrder) {
    const e = extent.get(s.id)!;
    shiftWhole(s, axisX ? cur - e.min : 0, axisX ? 0 : cur - e.min);
    cur += (e.max - e.min) + GAP;
  }
  applyLayouts(); paintAll(); scheduleSave(); commitStep();
}
// Swap `id` with its neighbour in the parent's order — only within the same side bucket
// (up/down across sides has no canvas meaning). Shared by the ⋯ menu's Move up / Move down.
export function reorderSibling(id: string, dir: -1 | 1): void {
  if (state.readOnly) return;
  const n = state.nodes.get(id);
  const parent = n?.parent ? state.nodes.get(n.parent) : undefined;
  if (!n || !parent) return;
  const side = sideOf(parent, n);
  const sibs = orderedKids(parent, childrenOf(parent.id)).filter(k => sideOf(parent, k) === side);
  const i = sibs.findIndex(k => k.id === id);
  const other = i >= 0 ? sibs[i + dir] : undefined;
  if (!other) { setStatus(`“${n?.title}” is already at the ${dir < 0 ? 'top' : 'bottom'}`); return; }
  const newOrder = sibs.slice(); newOrder[i] = other; newOrder[i + dir] = n;
  reorderBucket(parent, sibs, newOrder, orderAxisIsX(parent, side));
  setStatus(`Moved “${n.title}” ${dir < 0 ? 'up' : 'down'}`);
}

// ---- drag rows: reorder, reparent, or move between parents (the ⠿ handle) ----
// The handle is touch-action:none, so a pointer drag on it never scrolls the list. The dragged
// row rides the pointer (transform). Drop targets, computed against every visible row EXCEPT
// the dragged subtree's own:
//   · middle of a row  → become a CHILD of that card (the row highlights)
//   · row edges / gaps → insert BEFORE/AFTER that row under ITS parent (accent bar, indented
//     to the target's depth) — reparenting on the way when that parent differs
// Move/up listen on `window`, not the handle: pointer capture on the button is best-effort
// only (a mouse can outrun it, and any repaint would replace the row and break the capture) —
// same rationale as the ghost-card drag in main.ts. renderOutline is paused while dragging.
let rowDragActive = false;
type RowDrop = { kind: 'child'; target: MindNode } | { kind: 'before' | 'after'; ref: MindNode };
function startRowDrag(e: PointerEvent, n: MindNode, row: HTMLElement, handle: HTMLElement): void {
  if (state.readOnly || rowDragActive) return;
  if (e.button !== 0) return;                    // primary button / touch only
  e.preventDefault();
  const subtree = new Set(subtreeIds(n.id));     // can't drop into itself
  const rows = [...rowsEl.querySelectorAll<HTMLElement>('.ol-row')]
    .filter(r => !subtree.has(r.dataset.id!))
    .map(r => ({ el: r, node: state.nodes.get(r.dataset.id!)!, rect: r.getBoundingClientRect() }))
    .filter(r => !!r.node);
  if (!rows.length) return;
  const startY = e.clientY;
  const listRect = rowsEl.getBoundingClientRect();
  const line = document.createElement('div');
  line.className = 'ol-insert';
  document.body.appendChild(line);
  let drop: RowDrop | null = null;
  let hi: HTMLElement | null = null;             // row highlighted as the would-be parent
  const setHi = (el: HTMLElement | null): void => {
    if (hi) hi.classList.remove('ol-drop');
    hi = el;
    if (el) el.classList.add('ol-drop');
  };
  const EDGE = 0.3;   // top/bottom 30% of a row = insert in that gap; the middle 40% = nest
  const GAP = 8;      // inter-row spacing — MUST match .ol-row margin-bottom
  const update = (cy: number): void => {
    row.style.transform = `translateY(${cy - startY}px)`;
    drop = null; setHi(null); line.style.display = 'none';
    // Pick the row whose band — its rect expanded by half the inter-row gap — contains cy. The
    // bands tile the list contiguously, so hovering in the literal gap between two rows resolves
    // to the nearer row's edge rather than falling through to the end of the list.
    const refRow = rows.find(r => cy <= r.rect.bottom + GAP / 2) ?? rows[rows.length - 1];
    const frac = (cy - refRow.rect.top) / refRow.rect.height;   // <0 above the row, >1 below it
    if (frac > EDGE && frac < 1 - EDGE) { drop = { kind: 'child', target: refRow.node }; setHi(refRow.el); return; }
    drop = { kind: frac <= EDGE ? 'before' : 'after', ref: refRow.node };
    const indent = parseFloat(refRow.el.style.marginLeft || '0');
    line.style.display = '';
    line.style.left = (listRect.left + indent + 6) + 'px';
    line.style.width = (listRect.width - indent - 12) + 'px';
    // centre the 3px bar in the gap between the two rows
    const edge = drop.kind === 'before' ? refRow.rect.top - GAP / 2 : refRow.rect.bottom + GAP / 2;
    line.style.top = (edge - 1.5) + 'px';
  };
  rowDragActive = true;
  row.classList.add('ol-dragging');
  update(e.clientY);
  // best-effort: keeps the handle's own button behaviour quiet; window listeners do the work
  try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  const move = (ev: PointerEvent): void => update(ev.clientY);
  const finish = (commit: boolean): void => {
    rowDragActive = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    line.remove();
    setHi(null);
    row.classList.remove('ol-dragging');
    row.style.transform = '';
    if (!commit || !drop || !commitRowDrop(n, drop))
      renderOutline();   // nothing changed → catch up on any repaint skipped while dragging
  };
  const up = (): void => finish(true);
  const cancel = (): void => finish(false);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}
// Reparent `child` under `parent`, seeding its subtree near it (like addChild) and revealing the
// parent on the canvas + in the outline. Returns false (with a status) if the move is illegal.
// The caller picks the new side bucket + order afterwards. Shared by the drag drop and the picker.
function seedUnderParent(child: MindNode, parent: MindNode): boolean {
  if (!reparentOnly(child.id, parent.id)) { setStatus('That card can’t be moved there'); return false; }
  shiftWhole(child, parent.x + 40 - child.x, parent.y + nodeH(parent) + 40 - child.y);
  if (parent.collapsed) parent.collapsed = false;
  unfold(parent);
  return true;
}
// Detach `n` to the top level, shifting its whole subtree by `dy` (keeping its formation), then
// persist as one undo step. Shared by the picker's "Make root" and a drop beside a root row.
function makeRoot(n: MindNode, dy = 0): void {
  touch(n.id, n.parent);
  n.parent = null; n.side = undefined; n.dirtyLayout = true;
  shiftWhole(n, 0, dy);
  applyLayouts(); paintAll(); scheduleSave(); commitStep();
}

// Apply a drop: nest under a card (same path as the Move-to picker), or slot before/after a
// reference row under that row's parent — reparenting first when the parent differs, then
// committing the order via reorderBucket (one undo step for the whole gesture).
function commitRowDrop(n: MindNode, drop: RowDrop): boolean {
  if (drop.kind === 'child') {
    if (drop.target.id === n.parent) return false;   // already that card's child
    moveTo(n, drop.target);
    return true;
  }
  const ref = drop.ref;
  if (!ref.parent) return dropAtRootLevel(n, ref, drop.kind);   // beside a root row → join the top level
  const parent = state.nodes.get(ref.parent);
  if (!parent) return false;
  if (parent.id !== n.parent) {
    if (!seedUnderParent(n, parent)) return false;
  } else {
    touch(n.id, parent.id);   // pre-image before the side change below
  }
  const side = sideOf(parent, ref);
  n.side = side;   // same side bucket as the reference row
  const sibs = orderedKids(parent, childrenOf(parent.id)).filter(k => sideOf(parent, k) === side);
  const others = sibs.filter(s => s.id !== n.id);
  const idx = others.findIndex(s => s.id === ref.id);
  const newOrder = others.slice();
  newOrder.splice(drop.kind === 'before' ? idx : idx + 1, 0, n);
  reorderBucket(parent, sibs, newOrder, orderAxisIsX(parent, side));
  setStatus(`Moved “${n.title}” ${drop.kind} “${ref.title}”`);
  return true;
}
// Drop beside a ROOT row → make the card a top-level root too, ordered among the roots by its
// position (renderOutline sorts roots by y, then x). We place it at the midpoint y between `ref`
// and its neighbour on the drop side, so dragging to the very top lands it above the topmost card.
function dropAtRootLevel(n: MindNode, ref: MindNode, pos: 'before' | 'after'): boolean {
  const roots = sortedRoots(n.id);
  const idx = roots.findIndex(r => r.id === ref.id);
  const prev = pos === 'before' ? roots[idx - 1] : roots[idx];
  const next = pos === 'before' ? roots[idx] : roots[idx + 1];
  const newY = prev && next ? (prev.y + next.y) / 2 : prev ? prev.y + 200 : next!.y - 200;
  makeRoot(n, newY - n.y);   // land the subtree at newY among the roots, formation kept
  setStatus(`“${n.title}” is now a top-level card`);
  return true;
}

// ---- "Move to…" picker (reparent without drag) ----
// A full-screen filterable list of every valid target (own subtree and current parent
// excluded — same cycle guard as drag), each with its ancestor breadcrumb, plus "Make root".
const picker = document.createElement('div');
picker.id = 'movePicker';
picker.innerHTML =
  `<div class="mp-head">
     <input id="mpFilter" type="text" placeholder="Move to…" autocomplete="off" spellcheck="false" aria-label="Filter target cards">
     <button id="mpCancel">Cancel</button>
   </div>
   <div id="mpList"></div>`;
document.body.appendChild(picker);
const mpFilter = picker.querySelector('#mpFilter') as HTMLInputElement;
const mpList = picker.querySelector('#mpList') as HTMLElement;
let moveSrc: string | null = null;

function openMovePicker(n: MindNode): void {
  moveSrc = n.id;
  mpFilter.value = '';
  renderPicker();
  picker.classList.add('open');
  mpFilter.focus();
}
function closePicker(): void { picker.classList.remove('open'); moveSrc = null; }

function crumbFor(n: MindNode): string {
  return [...ancestors(n)].reverse().map(p => p.title).join(' › ');
}
function renderPicker(): void {
  const src = moveSrc ? state.nodes.get(moveSrc) : undefined;
  if (!src) return;
  const q = mpFilter.value.trim().toLowerCase();
  mpList.textContent = '';
  const label = document.createElement('div');
  label.className = 'mp-label';
  label.textContent = `Move “${src.title}” under…`;
  mpList.appendChild(label);
  const item = (title: string, crumb: string, color: string | null, run: () => void): void => {
    const b = document.createElement('button');
    b.className = 'mp-item'; b.type = 'button';
    const t = document.createElement('span'); t.className = 'mp-title';
    const dot = document.createElement('span'); dot.className = 'ol-dot';
    if (color && color !== 'none') dot.style.setProperty('--ol-c', `var(--pal-${color})`);
    t.append(dot, title);
    b.appendChild(t);
    if (crumb) { const c = document.createElement('span'); c.className = 'mp-crumb'; c.textContent = crumb; b.appendChild(c); }
    b.onclick = run;
    mpList.appendChild(b);
  };
  if (src.parent && !q) item('⌂ Make root', 'detach from its parent', null, () => moveTo(src, null));
  const targets = [...state.nodes.values()]
    .filter(c => c.id !== src.id && c.id !== src.parent && !isAncestor(src.id, c.id))
    .filter(c => !q || c.title.toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title));
  for (const c of targets) item(c.title, crumbFor(c), effectiveColor(c), () => moveTo(src, c));
}
function moveTo(src: MindNode, target: MindNode | null): void {
  closePicker();
  if (state.readOnly) return;
  if (target) {
    if (!seedUnderParent(src, target)) return;
    const side = deriveSide(target, src);
    src.side = side;
    // Slot it LAST in its new side bucket and pack the positions accordingly — the seed spot
    // alone would re-derive to a different (usually first) place on the next load.
    const sibs = orderedKids(target, childrenOf(target.id)).filter(k => sideOf(target, k) === side);
    const others = sibs.filter(s => s.id !== src.id);
    reorderBucket(target, sibs, [...others, src], orderAxisIsX(target, side));   // packs + saves + commits
    setStatus(`Moved “${src.title}” → “${target.title}”`);
  } else {
    makeRoot(src);
    setStatus(`“${src.title}” is now a root`);
  }
}
mpFilter.addEventListener('input', renderPicker);
(picker.querySelector('#mpCancel') as HTMLButtonElement).onclick = closePicker;
picker.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
});
