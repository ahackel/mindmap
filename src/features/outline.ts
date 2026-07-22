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
import { state, setStatus, isAnnotation, isLeafType, isQueryCard, type MindNode } from '../core/state.js';
import { PHONE_MQ, PORTRAIT_MQ } from '../core/ui-state.js';
import { childrenOf, isRoot, isAncestor, descendantCount, isLockedEffective, subtreeHasLocked } from '../utils/model.js';
import { orderedKids, sideOf, deriveSide, orderAxisIsX, applyLayouts } from '../view/layout.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, selectNode, focusNode, effectiveColor, subtreeIds, nodeH, NODE_W, toggleCollapse, toggleDone, setLockedSelection, LOCK_BADGE_SVG } from '../main.js';
import { openBranchEditor, closeBranchEditor, branchEditorOpen, addToBranch } from './branch-editor.js';
import { openEditorSheet } from './editor-sheet.js';
import { titleProblem } from './inline-edit.js';
import { createNode, deleteNode, duplicateSelection } from './crud.js';
import { reparentOnly } from './drag.js';
import { scheduleUrlSync } from '../nav/url-state.js';
import { openMenu } from './context-menu.js';
import { touch, commitStep } from './history.js';
import TRI from '../assets/icons/chevron.svg?raw';

const outlineScrollEl = document.getElementById('olScroll') as HTMLElement;
const rowsEl = document.getElementById('olRows') as HTMLElement;
const outlineBtn = document.getElementById('outlineBtn') as HTMLButtonElement;
const olCloseBtn = document.getElementById('olCloseBtn') as HTMLButtonElement;

// ---- view-local fold state (browsing-only reveals — see the header comment) ----
// Keyed by the node's FILE (ids are re-minted on every disk reload), falling back to the id
// for never-saved nodes. Absent → follow the map's saved mm_collapsed, so a fresh session
// starts from the same shape as the canvas. Deliberately NOT persisted across restarts. An
// EXPLICIT disc click bypasses this entirely (see rowFor) and toggles the real n.collapsed.
const outlineFold = new Map<string, boolean>();
const foldKey = (n: MindNode): string => n.file ?? n.id;
const isFolded = (n: MindNode): boolean => outlineFold.get(foldKey(n)) ?? n.collapsed;
const unfold = (n: MindNode): void => { outlineFold.set(foldKey(n), false); };

// ---- inline title rename, right on the row (mirrors features/inline-edit.ts's canvas version) ----
// A second click/tap on the already-selected row's title (or F2 / new-card creation, routed via
// startInlineEdit) turns the title span into a contenteditable, exactly like the canvas card. Kept
// here (rather than reusing the canvas editor) because it targets a row's `.ol-title`, not `.node
// .title`, and the row list must NOT rebuild out from under the caret while typing.
let rowEditId: string | null = null;
let rowEditIsNew = false;
function findRowTitle(id: string): HTMLElement | null {
  return rowsEl.querySelector<HTMLElement>(`.ol-row[data-id="${id}"] .ol-title`);
}
export function startRowTitleEdit(n: MindNode, { isNew = false }: { isNew?: boolean } = {}): void {
  if (state.readOnly || isLockedEffective(n)) return;
  const titleEl = findRowTitle(n.id); if (!titleEl) return;
  if (rowEditId && rowEditId !== n.id) endRowTitleEdit();
  touch(n.id);   // the whole edit session becomes ONE undo step (incl. a fresh card's creation)
  // Deliberately no selectNode() here — clicking a row in the outliner never touches canvas
  // selection (no sel ring here, and nothing to carry back when switching to the canvas view).
  rowEditId = n.id; rowEditIsNew = isNew;
  titleEl.setAttribute('contenteditable', 'plaintext-only');
  titleEl.classList.add('editing'); titleEl.classList.remove('invalid');
  titleEl.focus();
  const r = document.createRange(); r.selectNodeContents(titleEl);   // select-all so typing replaces
  const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
}
function onRowTitleInput(n: MindNode, titleEl: HTMLElement): void {
  if (rowEditId !== n.id) return;
  const problem = titleProblem(titleEl.textContent ?? '', n.id);
  titleEl.classList.toggle('invalid', !!problem);
}
function onRowTitleKeydown(e: KeyboardEvent, n: MindNode): void {
  if (rowEditId !== n.id) return;
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); endRowTitleEdit(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endRowTitleEdit({ cancel: true }); }
}
function endRowTitleEdit({ cancel = false }: { cancel?: boolean } = {}): void {
  const id = rowEditId; if (!id) return;
  rowEditId = null;                                    // null first → the blur handler becomes a no-op
  const isNew = rowEditIsNew; rowEditIsNew = false;
  const titleEl = findRowTitle(id);
  const n = state.nodes.get(id);
  if (titleEl) { titleEl.removeAttribute('contenteditable'); titleEl.classList.remove('editing', 'invalid'); titleEl.blur(); }
  if (!n) { commitStep(); return; }
  if (cancel && isNew) {                               // Esc on a freshly-created row = cancel creation
    deleteNode(n.id);
    commitStep();
    setStatus('Cancelled new card');
    return;
  }
  const val = (titleEl?.textContent ?? '').replace(/[\r\n]+/g, ' ').trim();   // titles map to filenames
  if (!cancel && !titleProblem(val, n.id)) n.title = val;
  n.dirty = true;
  scheduleSave();
  commitStep();                                        // one undo step per rename session
  renderOutline();                                      // restore the canonical (plain-text) row
}

// The node's ancestor chain, nearest parent first. Shared by the reveal (unfold up the chain)
// and the picker breadcrumb.
function* ancestors(n: MindNode): Generator<MindNode> {
  for (let p = n.parent ? state.nodes.get(n.parent) : null; p; p = p.parent ? state.nodes.get(p.parent) : null)
    yield p;
}
// Roots in the outline's canonical top-level order (canvas y, then x; filename as a stable tie).
function sortedRoots(exclude?: string): MindNode[] {
  return [...state.nodes.values()].filter(n => isRoot(n) && n.id !== exclude && !isAnnotation(n))
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.file ?? a.title).localeCompare(b.file ?? b.title));
}

// ---- mode toggle (persisted like theme / edge style) ----
const VIEW_KEY = 'mindmap.viewMode';   // 'canvas' | 'outline'
export function outlineActive(): boolean { return document.body.classList.contains('outline'); }
// On a PHONE the mode is dictated by orientation and can't be toggled — portrait is outline
// (reading/quick capture, no room for the 2D canvas), landscape is canvas (the extra width makes
// it usable) — the toolbar button is hidden there (CSS, kept in sync with PHONE_MQ) and the O
// shortcut / toggle no-op here. Everywhere else (desktop, tablet, a resized desktop window)
// canvas is the default with a free toggle, regardless of orientation.
function phoneWantsOutline(): boolean | null { return PHONE_MQ.matches ? PORTRAIT_MQ.matches : null; }
function outlineLocked(): boolean { return phoneWantsOutline() !== null; }
export function toggleOutlineView(): void { if (!outlineLocked()) setOutline(!outlineActive()); }
// `persist` records the choice as the user's own preference; forced/auto switches pass false so
// crossing a phone/orientation boundary doesn't overwrite what they picked elsewhere.
export function setOutline(on: boolean, persist = true): void {
  if (on === outlineActive()) return;
  if (document.body.classList.contains('sketching')) { setStatus('Leave sketch mode first (S)'); return; }
  if (!on) { closeBranchEditor(); olSearchInput.value = ''; outlineQuery = ''; disarmKeyboardTracking(); }   // leaving outline: drop any open branch editor + search filter
  document.body.classList.toggle('outline', on);
  outlineBtn.classList.toggle('active', on);
  if (persist) { try { localStorage.setItem(VIEW_KEY, on ? 'outline' : 'canvas'); } catch {} }
  if (on) renderOutline();
  // back to the canvas: orient at whatever you were just reading in the list
  else if (state.selId) focusNode(state.nodes.get(state.selId), true);
  scheduleUrlSync();
}
outlineBtn.onclick = toggleOutlineView;
olCloseBtn.onclick = toggleOutlineView;
// The effective mode: dictated by orientation on a phone, else the saved preference.
function wantOutline(): boolean {
  const forced = phoneWantsOutline();
  if (forced !== null) return forced;
  try { return localStorage.getItem(VIEW_KEY) === 'outline'; }
  catch { return false; }
}
// Runtime switch when the phone/breakpoint state or orientation changes (rotate / resize): a
// full setOutline, incl. the list re-render / canvas refocus. Safe here — main.ts is fully
// evaluated by the time either of these can fire.
PHONE_MQ.addEventListener('change', () => setOutline(wantOutline(), false));
PORTRAIT_MQ.addEventListener('change', () => setOutline(wantOutline(), false));
// Initial application at IMPORT time: set the body class ONLY — never setOutline/renderOutline.
// renderOutline reaches into main.ts (effectiveColor / nodeH / …), which is still mid-evaluation
// during this circular main↔outline import; calling it here throws. boot()'s first paintAll()
// renders the list (paintAll → renderOutline), so setting the class alone is enough + flash-free.
if (wantOutline()) { document.body.classList.add('outline'); outlineBtn.classList.add('active'); }

// ---- search (bottom bar, next to the + button) ----
// Filters the row list to matches (title OR body) plus their ancestors, so a hit stays reachable
// in its tree position; matched branches force-unfold regardless of mm_collapsed/outlineFold
// (restored automatically once the query is cleared, since neither is touched here).
const olHeadEl = document.querySelector('.ol-head') as HTMLElement;
const olSearchInput = document.getElementById('olSearch') as HTMLInputElement;
let outlineQuery = '';
function matchesOutlineQuery(n: MindNode, q: string): boolean {
  return n.title.toLowerCase().includes(q) || (!!n.body && n.body.toLowerCase().includes(q));
}
// Every match plus its ancestor chain, so filtered rows still read as a tree.
function outlineSearchVisible(q: string): Set<string> {
  const visible = new Set<string>();
  for (const n of state.nodes.values()) {
    if (isAnnotation(n) || !matchesOutlineQuery(n, q)) continue;
    visible.add(n.id);
    for (const p of ancestors(n)) visible.add(p.id);
  }
  return visible;
}
function clearOutlineSearch(): void {
  olSearchInput.value = ''; outlineQuery = ''; renderOutline(); updateAddBtnMode();
}
olSearchInput.addEventListener('input', () => { outlineQuery = olSearchInput.value; renderOutline(); updateAddBtnMode(); });
olSearchInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); clearOutlineSearch(); olSearchInput.blur(); }
});

// ---- lift the search bar above the software keyboard (iOS: a fixed bottom bar stays UNDER the
// keyboard because Safari doesn't resize the layout viewport when it appears — only the visual
// viewport shrinks). While the field is focused we track window.visualViewport and reposition the
// bar with `top` (not `bottom`) at its bottom edge; blur restores the normal docked position. A
// no-op on desktop (no keyboard → visualViewport tracks the window almost exactly, threshold below
// never trips) and wherever visualViewport isn't supported.
// Docked flush against the keyboard (no gap, edge-to-edge, flatter bar) — visually reads as one
// continuous strip with iOS's own Prev/Next/Done accessory bar right below it (which a web page
// can't draw into or remove — see the arm/disarm comment above), instead of a second floating
// pill hovering with a gap over it. The idle (undocked) look keeps the original floating pill.
function repositionOlHead(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const bottomInset = window.innerHeight - (vv.height + vv.offsetTop);
  const docked = bottomInset > 40;   // keyboard (or some other viewport-shrinking overlay) is showing
  olHeadEl.classList.toggle('kb-docked', docked);
  if (docked) {
    olHeadEl.style.bottom = 'auto';
    olHeadEl.style.top = `${vv.offsetTop + vv.height - olHeadEl.offsetHeight}px`;
  } else {
    olHeadEl.style.top = ''; olHeadEl.style.bottom = '';
  }
}
let vvTracking = false;
function armKeyboardTracking(): void {
  if (vvTracking || !window.visualViewport) return;
  vvTracking = true;
  window.visualViewport.addEventListener('resize', repositionOlHead);
  window.visualViewport.addEventListener('scroll', repositionOlHead);
  // iOS doesn't reliably fire visualViewport's resize/scroll the instant the keyboard starts
  // animating in (observed: the bar only snapped into place once some OTHER scroll happened) —
  // so poll every frame for the ~300ms the keyboard takes to slide up, instead of trusting the
  // events to land promptly. The events stay bound afterwards for orientation changes etc.
  let ticks = 0;
  const poll = (): void => {
    if (!vvTracking) return;
    repositionOlHead();
    if (++ticks < 20) requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}
function disarmKeyboardTracking(): void {
  if (vvTracking && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', repositionOlHead);
    window.visualViewport.removeEventListener('scroll', repositionOlHead);
  }
  vvTracking = false;
  olHeadEl.classList.remove('kb-docked');
  olHeadEl.style.top = ''; olHeadEl.style.bottom = '';
}
olSearchInput.addEventListener('focus', () => { armKeyboardTracking(); updateAddBtnMode(); });
olSearchInput.addEventListener('blur', () => { disarmKeyboardTracking(); updateAddBtnMode(); });

// ---- rendering ----
// Full rebuild — called from paintAll() so every mutation path (crud, undo, reload, selection)
// keeps the list in sync for free; a no-op while the canvas view is active. Cheap at this
// app's scale; scroll position is preserved across rebuilds.
export function renderOutline(): void {
  if (!outlineActive()) return;
  if (rowDragActive) return;   // a rebuild would replace the row mid-drag (e.g. autosave's paintAll)
  if (rowEditId) return;       // a rebuild would blow away the contenteditable mid-rename
  // #olRows is display:none while the single-card editor is open (styles.css), and every keystroke
  // in its card/props sheet already calls paintAll() — skip the wasted full rebuild while it's hidden.
  if (branchEditorOpen()) return;
  const scroll = outlineScrollEl.scrollTop;
  rowsEl.textContent = '';
  const q = outlineQuery.trim().toLowerCase();
  const visible = q ? outlineSearchVisible(q) : null;
  for (const r of sortedRoots()) walk(r, 0, visible);
  if (visible && !visible.size) {
    const none = document.createElement('div');
    none.className = 'ol-none'; none.textContent = 'No card matches';
    rowsEl.appendChild(none);
  }
  outlineScrollEl.scrollTop = scroll;
}
function walk(n: MindNode, depth: number, visible: Set<string> | null): void {
  if (visible && !visible.has(n.id)) return;
  const kids = childrenOf(n.id).filter(k => !isAnnotation(k));   // annotations aren't listed in the outliner
  rowsEl.appendChild(rowFor(n, depth, kids, !!visible));
  if (visible ? false : isFolded(n)) return;
  for (const k of orderedKids(n, kids)) walk(k, depth + 1, visible);
}
// A row shows a done checkbox only if its PARENT has `checklist` on — same Trello-style rule as
// the canvas (main.ts's showsDoneCheckbox): the setting lives on the parent, not the item.
function showsDoneCheckbox(n: MindNode): boolean {
  const p = n.parent ? state.nodes.get(n.parent) : undefined;
  return !!(p && p.checklist);
}
// Elements inside a row with their own click behaviour — a pointerdown/dblclick/touchstart on
// one of these must NOT also be read as "press the card" (drag-start / fold-on-double-tap).
const ROW_CONTROLS = '.ol-done, .ol-open, .ol-more';
function rowFor(n: MindNode, depth: number, kids: MindNode[], searching = false): HTMLElement {
  const folded = searching ? false : isFolded(n);   // search results force-unfold, see outlineSearchVisible
  const showDone = showsDoneCheckbox(n);
  const row = document.createElement('div');
  // rows carry the card's colour as their background via the shared .c-* classes (like .node).
  // Deliberately no selection ring here — clicking in the outliner never selects; rows only ever
  // show colour / fold / done state, nothing selection-shaped.
  row.className = `ol-row c-${effectiveColor(n)}` + (showDone && n.done ? ' done' : '') + (n.locked ? ' locked' : '');
  row.dataset.id = n.id;
  row.style.marginLeft = (depth * 14) + 'px';   // indent the whole card, not just its content

  // locked card: same corner padlock badge the canvas shows (main.ts) — upper-LEFT, mirroring
  // .ol-count's upper-right fold bubble so the two never collide on a locked+folded row.
  if (n.locked) {
    const lock = document.createElement('span');
    lock.className = 'ol-lock'; lock.title = 'Locked'; lock.innerHTML = LOCK_BADGE_SVG;
    row.appendChild(lock);
  }

  // checklist item: same donebox the canvas shows on a checklist parent's children (main.ts)
  if (showDone) {
    const done = document.createElement('input');
    done.type = 'checkbox'; done.className = 'ol-done'; done.checked = n.done;
    done.title = 'Mark done';
    done.addEventListener('pointerdown', (e) => e.stopPropagation());
    done.addEventListener('click', (e) => e.stopPropagation());
    done.addEventListener('change', () => toggleDone(n));
    row.appendChild(done);
  }

  const title = document.createElement('span');
  title.className = 'ol-title';
  title.textContent = n.title;
  // No click-to-rename any more — renaming is a ⋯-menu action (see openRowMenu) so a plain press
  // on the card is unambiguously "start a drag", never "start typing". Read-only sessions still
  // tap through to the sheet as a read-only viewer, since that's not an edit.
  if (state.readOnly) title.onclick = () => openEditorSheet(n);
  title.addEventListener('input', () => onRowTitleInput(n, title));
  title.addEventListener('keydown', (e) => onRowTitleKeydown(e, n));
  title.addEventListener('blur', () => { if (rowEditId === n.id) endRowTitleEdit(); });

  row.appendChild(title);
  // checklist owner: this row's own "n/m" progress over its direct children, same as the canvas
  if (n.checklist && kids.length) {
    const progress = document.createElement('span');
    progress.className = 'ol-progress';
    progress.textContent = `${kids.filter(k => k.done).length}/${kids.length}`;
    row.appendChild(progress);
  }
  if (folded && kids.length) {
    // straddles the row's top-right corner, same spot/size as the canvas' own hidden-count bubble
    // (main.ts paintNode) — the only "this is folded, double-click/-tap to expand" indicator now
    // that there's no disc button.
    const count = document.createElement('span');
    count.className = 'ol-count'; count.textContent = String(descendantCount(n.id));
    count.title = `${descendantCount(n.id)} hidden — double-click to expand`;
    row.appendChild(count);
  }
  if (!state.readOnly) {
    const open = document.createElement('button');
    open.className = 'ol-open'; open.innerHTML = TRI; open.title = 'Open card';
    open.setAttribute('aria-label', `Open “${n.title}” for editing`);
    open.onclick = () => openBranchEditor(n.id, 'none');
    const more = document.createElement('button');
    more.className = 'ol-more'; more.textContent = '⋮'; more.title = 'Card actions';
    more.setAttribute('aria-label', `Actions for “${n.title}”`);
    more.onclick = () => { const r = more.getBoundingClientRect(); openRowMenu(n, r.left, r.bottom + 4); };
    row.append(open, more);

    // press-and-drag anywhere on the card (outside its own buttons) reorders it — see
    // startRowDrag's header comment for how a plain tap/scroll is told apart from a real drag.
    // An edit action, so read-only skips it entirely (unlike the fold gestures below).
    row.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest(ROW_CONTROLS)) return;
      if (rowEditId === n.id) return;         // placing the caret while renaming, not a drag
      if (rowEditId) endRowTitleEdit();       // pressing elsewhere commits any other open rename
      startRowDrag(e, n, row);
    });
  }
  // double-click / double-tap anywhere on the card folds it (like the disc's single-click toggle,
  // just a bigger target for the same action) — collapsing is allowed in read-only, so this isn't
  // gated behind it the way the drag-start above is.
  row.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest(ROW_CONTROLS) || rowEditId === n.id) return;
    e.preventDefault();
    outlineFold.delete(foldKey(n)); toggleCollapse(n.id);
  });
  let lastTap = 0;
  row.addEventListener('touchstart', (e) => {
    if ((e.target as HTMLElement).closest(ROW_CONTROLS) || rowEditId === n.id) { lastTap = 0; return; }
    const now = performance.now();
    if (e.touches.length === 1 && now - lastTap < 300) {
      e.preventDefault();   // stop double-tap zoom / a synthetic dblclick firing too
      outlineFold.delete(foldKey(n)); toggleCollapse(n.id);
      lastTap = 0;
      return;
    }
    lastTap = now;
  }, { passive: false });
  return row;
}

// New-card button (floating +): while the single-card editor is open it adds a child of the open
// card (see addToBranch); in the row list — which carries no selection to be contextual about —
// it's always a fresh root card. The routed startInlineEdit opens the new card for editing.
// While search is active (focused or has a query) it doubles as a × that clears/cancels the
// search instead — the same swap iOS search fields make between their trailing action and Cancel.
const olAddBtn = document.getElementById('olAddBtn') as HTMLButtonElement;
const olAddPlus = olAddBtn.querySelector('.ol-add-plus') as HTMLElement;
function searchIsActive(): boolean { return document.activeElement === olSearchInput || !!outlineQuery; }
function updateAddBtnMode(): void {
  const active = searchIsActive();
  olAddBtn.classList.toggle('ol-clear-mode', active);
  olAddBtn.title = active ? 'Clear search' : 'New card — child of the selected card (Tab)';
  olAddBtn.setAttribute('aria-label', active ? 'Clear search' : 'New card');
  olAddPlus.textContent = active ? '×' : '+';
}
// A plain tap on this button while #olSearch is focused would otherwise blur the input FIRST
// (a button's default pointerdown behaviour steals focus) — which fires our own blur handler,
// snapping the bar back to its docked position and shifting the button out from under the
// finger before the click lands. The result: the first tap only dismissed the keyboard, and
// clearing took a second tap. Suppress that default focus-steal in clear-mode so the input
// stays focused (and the bar stays put) until the click itself has been delivered — the click
// handler below still blurs explicitly, once the clear has actually happened.
olAddBtn.addEventListener('pointerdown', (e) => {
  if (olAddBtn.classList.contains('ol-clear-mode')) e.preventDefault();
});
olAddBtn.onclick = () => {
  if (olAddBtn.classList.contains('ol-clear-mode')) { clearOutlineSearch(); olSearchInput.blur(); return; }
  if (state.readOnly) return;
  if (branchEditorOpen()) { addToBranch(); return; }
  createNode();
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
// Rename lives ONLY here — a card is a drag surface now (see startRowDrag), so there's no click
// left free to double as "start typing". Add/move still have their own direct affordances (the +
// button, drag-to-reorder-or-reparent).
function openRowMenu(n: MindNode, x: number, y: number): void {
  const locked = isLockedEffective(n);
  const query = isQueryCard(n);   // no renamable title — its title slot shows the query text instead
  openMenu([
    { label: 'Rename', run: () => startRowTitleEdit(n), disabled: locked || query },
    { label: 'Duplicate', shortcut: 'D', run: () => { selectNode(n.id); duplicateSelection({ edit: false }); } },
    { label: locked ? 'Unlock' : 'Lock', shortcut: 'L', run: () => setLockedSelection([n.id], !locked) },
    { label: 'Delete', shortcut: 'Del', run: () => deleteNode(n.id), danger: true, disabled: subtreeHasLocked(n.id) },
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
  if (n && isLockedEffective(n)) { setStatus('Locked — can’t move'); return; }
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

// ---- drag rows: reorder, reparent, or move between parents (press anywhere on the card) ----
// There's no dedicated handle any more — a press-and-drag ANYWHERE on the row (except its
// buttons/checkbox, filtered by the pointerdown listener in rowFor) starts a reorder. To keep
// that from fighting a plain tap (fold via double-tap, or just touch-scrolling the list), the
// gesture only actually ENGAGES — row lifts, .ol-dragging applies, native touch scroll is
// suppressed — once it's clearly a drag, not a tap:
//   · mouse  → a small pixel threshold (same idea as the canvas' own drag-vs-click test)
//   · touch  → a short press-and-hold (long-press), so a normal swipe still scrolls the list;
//     moving too far before the hold fires cancels it and leaves scrolling alone
// The dragged row rides the pointer (transform) once engaged. Drop targets, computed against
// every visible row EXCEPT the dragged subtree's own:
//   · middle of a row  → become a CHILD of that card (the row highlights)
//   · row edges / gaps → insert BEFORE/AFTER that row under ITS parent (accent bar, indented
//     to the target's depth) — reparenting on the way when that parent differs
// Move/up listen on `window`: pointer capture on the row is best-effort only (a mouse can
// outrun it, and any repaint would replace the row and break the capture) — same rationale as
// the ghost-card drag in main.ts. renderOutline is paused while actually dragging.
let rowDragActive = false;
const ROW_DRAG_PX = 4;         // mouse: pixels of movement before a press becomes a drag
const ROW_LONGPRESS_MS = 350;  // touch: hold time before a press becomes a drag
const ROW_LONGPRESS_SLOP = 10; // touch: movement past this before the hold fires = a scroll, not a drag
type RowDrop = { kind: 'child'; target: MindNode } | { kind: 'before' | 'after'; ref: MindNode };
function startRowDrag(e: PointerEvent, n: MindNode, row: HTMLElement): void {
  if (state.readOnly || rowDragActive || isLockedEffective(n)) return;
  if (e.button !== 0) return;                    // primary button / touch only
  const touchInput = e.pointerType === 'touch';
  const startX = e.clientX, startY = e.clientY;
  let curY = startY;
  let engaged = false;
  let longPressTimer: number | undefined;
  let drop: RowDrop | null = null;
  let hi: HTMLElement | null = null;             // row highlighted as the would-be parent
  let rows: { el: HTMLElement; node: MindNode; rect: DOMRect }[] = [];
  let listRect: DOMRect;
  let line: HTMLElement;
  const setHi = (el: HTMLElement | null): void => {
    if (hi) hi.classList.remove('ol-drop');
    hi = el;
    if (el) el.classList.add('ol-drop');
  };
  const EDGE = 0.3;   // top/bottom 30% of a row = insert in that gap; the middle 40% = nest
  const GAP = 12;     // inter-row spacing — MUST match .ol-row margin-bottom
  // Row rects are cached once at engage time, in viewport coordinates AS OF THEN. Edge
  // auto-scroll (scrollStep below) moves the list under the pointer afterwards, so every
  // comparison/placement translates by the scroll accumulated since engage instead of
  // re-measuring all rows per frame.
  let scroll0 = 0;
  const update = (cy: number): void => {
    const dy = outlineScrollEl.scrollTop - scroll0;   // list content moved up by dy since engage
    row.style.transform = `translateY(${cy - startY + dy}px)`;
    drop = null; setHi(null); line.style.display = 'none';
    if (!rows.length) return;
    // Pick the row whose band — its rect expanded by half the inter-row gap — contains cy. The
    // bands tile the list contiguously, so hovering in the literal gap between two rows resolves
    // to the nearer row's edge rather than falling through to the end of the list.
    const cyL = cy + dy;   // pointer y in the cached rects' (engage-time) coordinates
    const refRow = rows.find(r => cyL <= r.rect.bottom + GAP / 2) ?? rows[rows.length - 1];
    const frac = (cyL - refRow.rect.top) / refRow.rect.height;   // <0 above the row, >1 below it
    // A locked row is never a valid nest-under target — fall through to a before/after sibling
    // insert instead (that only touches the shared parent's order, not the locked card itself).
    if (frac > EDGE && frac < 1 - EDGE && !isLockedEffective(refRow.node)) {
      drop = { kind: 'child', target: refRow.node }; setHi(refRow.el); return;
    }
    drop = { kind: frac <= EDGE ? 'before' : 'after', ref: refRow.node };
    const indent = parseFloat(refRow.el.style.marginLeft || '0');
    line.style.display = '';
    line.style.left = (listRect.left + indent + 6) + 'px';
    line.style.width = (listRect.width - indent - 12) + 'px';
    // centre the 3px bar in the gap between the two rows (.ol-insert is position:fixed → viewport)
    const edge = (drop.kind === 'before' ? refRow.rect.top - GAP / 2 : refRow.rect.bottom + GAP / 2) - dy;
    line.style.top = (edge - 1.5) + 'px';
  };
  // Edge auto-scroll — the outline counterpart of the canvas drag's autoPanStep: while the
  // pointer sits in the top/bottom band of the scroll viewport, scroll the list at a speed
  // proportional to how deep into the band it is, and re-run update() so the drop target and
  // the lifted row track the moving list. Needed on touch especially, since the engaged drag
  // preventDefault()s native scrolling entirely.
  const SCROLL_M = 48, SCROLL_MAX = 12;   // edge band (px) and max scroll speed (px/frame)
  let scrollRAF = 0;
  const scrollStep = (): void => {
    scrollRAF = 0;
    if (!engaged) return;
    const sr = outlineScrollEl.getBoundingClientRect();
    let v = 0;
    if (curY < sr.top + SCROLL_M)         v = -SCROLL_MAX * Math.min(1, (sr.top + SCROLL_M - curY) / SCROLL_M);
    else if (curY > sr.bottom - SCROLL_M) v =  SCROLL_MAX * Math.min(1, (curY - (sr.bottom - SCROLL_M)) / SCROLL_M);
    if (v) {
      const before = outlineScrollEl.scrollTop;
      outlineScrollEl.scrollTop = before + v;
      if (outlineScrollEl.scrollTop !== before) update(curY);   // clamped at the ends → no repaint
    }
    scrollRAF = requestAnimationFrame(scrollStep);
  };
  const engage = (): void => {
    if (engaged) return;
    engaged = true;
    rowDragActive = true;
    const subtree = new Set(subtreeIds(n.id));   // can't drop into itself
    rows = [...rowsEl.querySelectorAll<HTMLElement>('.ol-row')]
      .filter(r => !subtree.has(r.dataset.id!))
      .map(r => ({ el: r, node: state.nodes.get(r.dataset.id!)!, rect: r.getBoundingClientRect() }))
      .filter(r => !!r.node);
    listRect = rowsEl.getBoundingClientRect();
    line = document.createElement('div');
    line.className = 'ol-insert';
    document.body.appendChild(line);
    row.classList.add('ol-dragging');
    try { row.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    scroll0 = outlineScrollEl.scrollTop;
    update(curY);
    scrollRAF = requestAnimationFrame(scrollStep);
  };
  // Blocking native touch scroll mid-gesture can't be done via touch-action (it's only read at
  // gesture START) — once engaged we must preventDefault() the raw touchmove, else the browser
  // starts scrolling the (full) list on the first move and pointercancels the drag. Registered
  // up-front (non-passive) so it's already in place when the long-press fires; it's a no-op
  // until `engaged`, so plain swipes still scroll.
  const touchBlock = (ev: TouchEvent): void => { if (engaged) ev.preventDefault(); };
  if (touchInput) {
    row.addEventListener('touchmove', touchBlock, { passive: false });
    longPressTimer = window.setTimeout(engage, ROW_LONGPRESS_MS);
  }
  const move = (ev: PointerEvent): void => {
    curY = ev.clientY;
    if (!engaged) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (touchInput) {
        if (Math.abs(dx) + Math.abs(dy) > ROW_LONGPRESS_SLOP) clearTimeout(longPressTimer);   // it's a scroll
        return;
      }
      if (Math.abs(dx) + Math.abs(dy) < ROW_DRAG_PX) return;
      engage();
      return;
    }
    update(ev.clientY);
  };
  const finish = (commit: boolean): void => {
    clearTimeout(longPressTimer);
    if (touchInput) row.removeEventListener('touchmove', touchBlock);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    if (!engaged) return;   // a plain tap/click — nothing was touched, nothing to repaint
    if (scrollRAF) cancelAnimationFrame(scrollRAF);
    rowDragActive = false;
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
// Reparent `child` under `parent`, seeding its subtree near it (like addChild) and — unless
// `reveal` is false — expanding the parent on the canvas + in the outline. Returns false (with a
// status) if the move is illegal. The caller picks the new side bucket + order afterwards. Shared
// by the drag drop (reveal suppressed — dropping onto a card shouldn't spring it open) and the
// "Move to…" picker (reveal on, since the user explicitly chose that target).
function seedUnderParent(child: MindNode, parent: MindNode, reveal = true): boolean {
  if (!reparentOnly(child.id, parent.id)) { setStatus('That card can’t be moved there'); return false; }
  shiftWhole(child, parent.x + 40 - child.x, parent.y + nodeH(parent) + 40 - child.y);
  if (reveal) {
    if (parent.collapsed) parent.collapsed = false;
    unfold(parent);
  }
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
    if (isLockedEffective(drop.target)) { setStatus('Locked — can’t drop there'); return false; }
    moveTo(n, drop.target, false);   // dropping onto a card shouldn't auto-expand it
    return true;
  }
  const ref = drop.ref;
  if (!ref.parent) return dropAtRootLevel(n, ref, drop.kind);   // beside a root row → join the top level
  const parent = state.nodes.get(ref.parent);
  if (!parent) return false;
  if (parent.id !== n.parent && isLockedEffective(parent)) { setStatus('Locked — can’t drop there'); return false; }
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
    .filter(c => c.id !== src.id && c.id !== src.parent && !isAncestor(src.id, c.id) && !isLeafType(c))   // leaves can't be parents
    .filter(c => !isLockedEffective(c))   // locked cards never adopt new children
    .filter(c => !q || c.title.toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title));
  for (const c of targets) item(c.title, crumbFor(c), effectiveColor(c), () => moveTo(src, c));
}
function moveTo(src: MindNode, target: MindNode | null, reveal = true): void {
  closePicker();
  if (state.readOnly) return;
  if (target) {
    if (!seedUnderParent(src, target, reveal)) return;
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
