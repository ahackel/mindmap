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
import { childrenOf, isHidden, descendantCount } from './utils/model.js';
import { state, world, stage, setStatus } from './core/state.js';
import { setupTheme } from './view/theme.js';
import { mountIcons } from './view/icons.js';
import { zoomAt, frameBox, screenToWorld } from './view/camera.js';
import { applyLayouts } from './view/layout.js';
import { paintEdges } from './view/edges.js';
import './features/gestures.js';   // registers the canvas pan/zoom/marquee gesture listeners
import './features/attachments.js';   // registers the OS image drag/drop listeners
import { startInlineEdit, startBodyEdit, endInlineEdit, endBodyEdit, onInlineInput, onInlineKeydown } from './features/inline-edit.js';
import { createNode, createDetachedNode, createSibling, addChild, duplicateSelection, deleteSelection, deleteNode } from './features/crud.js';
import { bindNodeDrag, startNodeDrag, feedDragMove, commitDrag, abortDrag } from './features/drag.js';   // also registers the Alt/Shift drag-modifier listeners
import { searchBox } from './features/search.js';
import { resetImageCache, hydrateImages } from './features/images.js';
import { store, scheduleSave, flushSave, loadFromDir } from './data/persistence.js';
import { showStart, openHelpTab, boot } from './boot.js';
import type { MindNode, LayoutType, EdgeStyle } from './core/state.js';
import { ui, isTypingInField, type Pt, type Drag } from './core/ui-state.js';

declare global {
  interface Window { __dbg: { readonly state: typeof state; readonly drag: Drag | null }; }
}

// The DOM shell (index.html) is fixed, so these elements always exist — assert non-null.
function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }

window.__dbg = { get state(){ return state; }, get drag(){ return ui.drag; } };   // TEMP debug hook

mountIcons();                         // fill [data-icon] placeholders with their SVG assets
setupTheme();




// ---------- rendering ----------
function nodeEl(n: MindNode): HTMLElement {
  if (n.el) return n.el;
  const el = document.createElement('div');
  el.dataset.id = n.id;
  el.innerHTML = `<div class="title-row"><input type="checkbox" class="donebox" title="Mark done"><div class="title"></div><span class="progress"></span></div><div class="body"></div>
    <span class="hidden-count"></span>
    <div class="addnote" title="Add note">Add note…</div>`;
  world.appendChild(el);
  n.el = el;
  bindNodeDrag(n);
  const addnote = el.querySelector('.addnote')!;
  addnote.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); });
  addnote.addEventListener('click', (e)=>{ e.stopPropagation(); startBodyEdit(n); });
  const bodyEl = el.querySelector('.body')!;
  // body links: open externally, or jump to a wikilink's node. Don't let the click bubble to
  // the card (which would select / toggle the panel); pointerdown is stopped in bindNodeDrag.
  bodyEl.addEventListener('click', (e)=>{
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
  doneEl.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); });
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
  return 'grey';
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
    + (state.sel.has(n.id) ? ' sel' : '')
    + (state.sel.size === 1 && state.sel.has(n.id) ? ' solo' : '')   // lone selection → show +
    + (collapsed ? ' collapsed' : '')
    + (hasBody ? '' : ' no-body')
    + (showDone ? ' show-done' : '')
    + (showDone && n.done ? ' done' : '')
    + (ui.drag?.targets?.has(n.id) ? ' dragging' : '')   // float the dragged subtree above all cards
    + (state.searchMatch && !state.searchMatch.has(n.id) ? ' search-dim' : '');
  (el.querySelector('.donebox') as HTMLInputElement).checked = n.done;
  // this card's own checklist (over ITS children) → an "n/m done" progress readout by the title
  el.querySelector('.progress')!.textContent =
    (n.checklist && hasKids) ? `${kids.filter(k => k.done).length}/${kids.length}` : '';
  // During drag: keep left/top frozen at the pre-drag origin and move via transform (compositor-only).
  // Outside drag: commit position normally and clear any leftover transform.
  const dragOrig = ui.drag?.origins?.get(n.id);
  if (dragOrig) {
    el.style.left = dragOrig.x + 'px'; el.style.top = dragOrig.y + 'px';
    el.style.transform = `translate(${n.x - dragOrig.x}px,${n.y - dragOrig.y}px)`;
  } else {
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
    if (el.style.transform) el.style.transform = '';
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
export function nodeH(n: MindNode): number { return (n.el && n.el.offsetHeight) || 64; } // live height (falls back pre-render)
// Height used for LAYOUT geometry. The selection affordances (+ and the "add note" bubble) are
// absolutely positioned and overhang the card, so they don't inflate its measured height — a
// title-only card lays out the same whether or not it's selected.
export function layoutH(n: MindNode): number {
  const el = n.el; if (!el) return 64;
  return el.offsetHeight;
}
export function paintAll(): void {
  for (const n of state.nodes.values()) paintNode(n);
  paintEdges();
}

// ---------- animated relayout (expand / collapse) ----------
function prefersReducedMotion(): boolean { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
function placeNodeEl(n: MindNode): void { if (n.el){ n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px'; } }
function setNodeElXY(n: MindNode, x: number, y: number): void { if (n.el){ n.el.style.left = x + 'px'; n.el.style.top = y + 'px'; } }
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
      n.x = parseFloat(c.left) || n.x; n.y = parseFloat(c.top) || n.y;
    }
    paintEdges();
    for (const [n,x,y] of saved){ n.x = x; n.y = y; }   // restore logical (final) positions
    if (now - t0 < ms) requestAnimationFrame(tick); else paintEdges();
  };
  requestAnimationFrame(tick);
}
// Run a structural change (a collapse toggle) and CSS-animate the resulting reflow.
function withLayoutAnimation(mutate: () => void): void {
  const before = new Map<string, Pt>();
  for (const m of state.nodes.values()) if (m.el && !isHidden(m)) before.set(m.id, { x:m.x, y:m.y });
  mutate();
  paintAll();          // reveal/hide DOM and measure real heights
  applyLayouts();      // compute FINAL positions into n.x/n.y (DOM not updated yet)
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
function initEdgeStyle(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem(EDGE_KEY); } catch {}
  if (saved && (EDGE_STYLES as string[]).includes(saved)) state.edgeStyle = saved as EdgeStyle;
}
function cycleEdgeStyle(): void {
  const i = EDGE_STYLES.indexOf(state.edgeStyle);
  state.edgeStyle = EDGE_STYLES[(i + 1) % EDGE_STYLES.length];
  try { localStorage.setItem(EDGE_KEY, state.edgeStyle); } catch {}
  paintEdges();
  setStatus(`Edge style: ${state.edgeStyle}`);
}
initEdgeStyle();

// Toggle one node's collapse: folds it down to just its title — hides its body and, if it has
// children, folds them (and everything below) too. A leaf with a body can fold its body alone.
export function toggleCollapse(id: string): void {
  const n = state.nodes.get(id); if (!n) return;
  const hasKids = childrenOf(n.id).length > 0;
  const hasBody = !!(n.body && n.body.trim());
  if (!hasKids && !hasBody) return;   // nothing to fold: no children and no body
  // animate the reflow; withLayoutAnimation paints, measures heights, and lays out the children
  withLayoutAnimation(() => { n.collapsed = !n.collapsed; n.dirtyLayout = true; });
  scheduleSave();
  setStatus(n.collapsed ? `Collapsed “${n.title}”` : `Expanded “${n.title}”`);
}
// Fold/unfold a whole set of cards together (double-clicking one card of a multi-selection).
// Only foldable cards (children or a body) count; the group lands on one shared state — expand
// if they're all collapsed already, otherwise collapse them all.
export function toggleCollapseSelection(ids: Iterable<string>): void {
  const cards = [...ids].map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n)
    .filter(n => childrenOf(n.id).length > 0 || !!(n.body && n.body.trim()));
  if (!cards.length) return;
  const target = !cards.every(n => n.collapsed);   // all collapsed → expand; otherwise collapse all
  withLayoutAnimation(() => { for (const n of cards){ n.collapsed = target; n.dirtyLayout = true; } });
  scheduleSave();
  setStatus(`${target ? 'Collapsed' : 'Expanded'} ${cards.length} card${cards.length > 1 ? 's' : ''}`);
}
// Flip a checklist item's done mark (mm_done) and persist. Independent of any body task list.
// Also repaints the parent so its "n/m" checklist progress readout stays in sync.
function toggleDone(n: MindNode): void {
  if (state.readOnly) return;
  n.done = !n.done;
  n.dirty = true;
  paintNode(n);
  if (n.parent){ const p = state.nodes.get(n.parent); if (p) paintNode(p); }
  scheduleSave();
}
// Flip the idx-th task checkbox in a node's body and write the change back to disk.
function toggleTask(n: MindNode, idx: number): void {
  if (state.readOnly) return;
  let i = 0;
  n.body = n.body.replace(/^(\s*[-*+]\s+)\[([ xX])\]/gm, (m, pre, mark) =>
    i++ === idx ? pre + (mark === ' ' ? '[x]' : '[ ]') : m);
  n.dirty = true;
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


// Focus a card: un-collapse hiding ancestors, select it, frame it + all its visible descendants.
export function focusNode(target: MindNode | undefined): void {
  if (!target) return;
  let revealed = false;
  for (let p = target.parent ? state.nodes.get(target.parent) : null; p; p = p.parent ? state.nodes.get(p.parent) : null){
    if (p.collapsed){ p.collapsed = false; p.dirtyLayout = true; revealed = true; }
  }
  selectNode(target.id);                       // paint first so heights are known / editor opens
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
  else frameBox([...state.nodes.values()]);
}

// ---------- selection + editor ----------
// Selection and the edit panel are decoupled: a node can stay selected while the
// panel is closed (press Esc). That closed-but-selected state is when Delete works.
const editor = byId('editor');
export const edName = byId('edName');   // read-only node name at the top of the sidebar
const edTags  = byId<HTMLInputElement>('edTags');
const edLayoutTypes = byId('edLayoutTypes');
const edColors = byId('edColors');
const edChecklist = byId<HTMLInputElement>('edChecklist');
const edBg = byId<HTMLInputElement>('edBg');

// colour palette (keys match the .c-* CSS classes); 'grey' is the old neutral "none" look.
// The hexes themselves live in ONE place — the --pal-* custom properties in styles.css's
// :root — so CSS (.c-*, #ghostCard) and JS (edges/backgrounds fills, swatch dots below) can
// never drift apart. Read once at load; palette colours don't change with the theme.
const PALETTE = ['slate','red','amber','green','teal','blue','violet','pink','grey','white'];
const rootStyle = getComputedStyle(document.documentElement);
const pal = (name: string): string => rootStyle.getPropertyValue(`--pal-${name}`).trim();
export const SWATCH_BG: Record<string, string> = Object.fromEntries(PALETTE.map(c => [c, pal(c)]));
// build the swatch row once: inherit (default) + the palette colours + explicit "none".
// '' = inherit the nearest coloured ancestor (effectiveColor walks up); 'none' = no colour, terminal.
(function buildSwatches(){
  let html = `<div class="swatch inherit" data-color="" title="inherit colour from parent (default)"></div>`;
  for (const c of PALETTE)
    html += `<div class="swatch" data-color="${c}" title="${c}" style="--sw:${SWATCH_BG[c]}"></div>`;
  html += `<div class="swatch nofill" data-color="none" title="no colour — don’t inherit"></div>`;
  edColors.innerHTML = html;
  edColors.querySelectorAll<HTMLElement>('.swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      const ids = selectedIds();
      if (!ids.length) return;
      for (const id of ids){ const n = state.nodes.get(id); if (n){ n.color = sw.dataset.color ?? ''; n.dirty = true; } }
      markActiveSwatch(sw.dataset.color);
      paintAll(); scheduleSave();
    });
  });
})();
function markActiveSwatch(color: string | undefined): void {
  edColors.querySelectorAll<HTMLElement>('.swatch').forEach(sw =>
    sw.classList.toggle('active', sw.dataset.color === (color || '')));
}

// ---------- layout pickers (icon chips, like the colour swatches) ----------
const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const DOT = (cx: number, cy: number, r = 2.2) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;
const LAYOUT_TYPES = [
  { key:'none', label:'None — inherit layout from the parent (default)',
    icon: SVG_OPEN + '<rect x="5" y="7" width="14" height="10" rx="2" stroke-dasharray="3 2.5"/></svg>' },
  { key:'free', label:'Free — children stay where you drag them',
    icon: SVG_OPEN + DOT(6,7) + DOT(17,8) + DOT(11,17) + '</svg>' },
  { key:'line', label:'Line — children chained one after another, each on whichever side it sits on',
    icon: SVG_OPEN + DOT(4,12) + '<path d="M6.5 12h3"/>' + DOT(12,12) + '<path d="M14.5 12h3"/>' + DOT(20,12) + '</svg>' },
  { key:'fan', label:'Fan — children spread out, each to whichever side it’s placed on',
    icon: SVG_OPEN + DOT(4,12) + '<path d="M6 12l6-6M6 12h6M6 12l6 6"/>' + DOT(14,6,1.8) + DOT(14,12,1.8) + DOT(14,18,1.8) + '</svg>' },
];
// the ids currently being edited (one or many) — layout applies to all of them
export function selectedIds(): string[] { return state.sel.size ? [...state.sel] : (state.selId ? [state.selId] : []); }
// build the chip row once
(function buildLayoutChips(){
  edLayoutTypes.innerHTML = LAYOUT_TYPES.map(t =>
    `<div class="layoutchip" data-type="${t.key}" title="${t.label}">${t.icon}</div>`).join('');
  edLayoutTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.addEventListener('click', () => setLayout({ type: c.dataset.type as LayoutType })));
})();
// apply a type to every selected card, then re-snap their children
function setLayout({ type }: { type?: LayoutType }): void {
  const ids = selectedIds(); if (!ids.length) return;
  for (const id of ids){
    const n = state.nodes.get(id); if (!n) continue;
    if (type != null) n.layoutType = type;
    n.dirty = true;
  }
  markLayoutChips();
  applyLayouts(); paintAll(); scheduleSave();
}
// reflect the selection's current layout: a chip is active when ALL selected share that value
// (mixed → none active).
function markLayoutChips(): void {
  const ids = selectedIds();
  const types = new Set(ids.map(id => state.nodes.get(id)?.layoutType || 'none'));
  const t = types.size === 1 ? [...types][0] : null;
  edLayoutTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.classList.toggle('active', c.dataset.type === t));
}

// ---------- checklist toggle: off (default) / on — Trello-style, set on the PARENT. Turning it
// on gives each of its direct children a done checkbox and shows their "n/m" progress on this
// card; it does not cascade further down (see showsDoneCheckbox).
edChecklist.addEventListener('change', () => setChecklist(edChecklist.checked));
function setChecklist(on: boolean): void {
  const ids = selectedIds(); if (!ids.length) return;
  for (const id of ids){ const n = state.nodes.get(id); if (n){ n.checklist = on; n.dirty = true; } }
  markChecklistBox();
  paintAll(); scheduleSave();
}
// mixed selection (some on, some off) shows as indeterminate rather than picking a side
function markChecklistBox(): void {
  const ids = selectedIds();
  const vals = new Set(ids.map(id => !!state.nodes.get(id)?.checklist));
  edChecklist.indeterminate = vals.size > 1;
  edChecklist.checked = vals.size === 1 && [...vals][0];
}

// ---------- group background toggle: encloses a card + all its visible descendants in a
// translucent tint (see view/edges.ts paintBackgrounds), coloured by the card's effective colour.
edBg.addEventListener('change', () => setBg(edBg.checked));
function setBg(on: boolean): void {
  const ids = selectedIds(); if (!ids.length) return;
  for (const id of ids){ const n = state.nodes.get(id); if (n){ n.bg = on; n.dirty = true; } }
  markBgBox();
  paintAll(); scheduleSave();
}
function markBgBox(): void {
  const ids = selectedIds();
  const vals = new Set(ids.map(id => !!state.nodes.get(id)?.bg));
  edBg.indeterminate = vals.size > 1;
  edBg.checked = vals.size === 1 && [...vals][0];
}

function openEditor(n: MindNode | undefined): void {
  if (!n) return;
  editor.classList.remove('multi');
  edName.textContent = n.title;             // name is read-only here — rename on the canvas
  edTags.value = n.tags.join(', ');
  markActiveSwatch(n.color);
  markLayoutChips();
  markChecklistBox();
  markBgBox();
  editor.classList.add('has-selection');   // show fields instead of the empty hint
}
// many nodes selected → show just the colour picker + a count; swatches recolour all of them
function openMultiEditor(): void {
  const ids = [...state.sel];
  byId('edMulti').textContent =
    `${ids.length} cards selected — colour & layout apply to all`;
  const colors = new Set(ids.map(id => state.nodes.get(id)?.color || ''));
  markActiveSwatch(colors.size === 1 ? [...colors][0] : '');  // none active when mixed
  markLayoutChips();
  markChecklistBox();
  markBgBox();
  editor.classList.add('has-selection', 'multi');
}
// no node selected → keep the sidebar open but show the empty hint
function showEmptyEditor(): void { editor.classList.remove('has-selection', 'multi'); }
// reflect state.sel in the canvas + the editor panel
export function applySelection(): void { paintAll(); updateEditor(); updateNodeActions(); applySidebar(); }

// Enable/disable the toolbar's selected-card actions to match the current selection & mode.
function updateNodeActions(): void {
  const one = !!state.selId && !state.readOnly;   // single-target actions
  const any = state.sel.size > 0 && !state.readOnly;
  const set = (id: string, on: boolean) => { byId<HTMLButtonElement>(id).disabled = !on; };
  set('edRename', one); set('edDuplicate', one);
  set('edDelete', any);
}
function updateEditor(): void {
  const n = state.sel.size;
  if (n === 0) showEmptyEditor();
  else if (n === 1) openEditor(state.selId ? state.nodes.get(state.selId) : undefined);
  else openMultiEditor();
}
// Replace the whole selection with `ids` (a Set or array), recomputing the primary.
export function setSelectionSet(ids: Iterable<string>): void {
  state.sel = new Set(ids);
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
    state.sel.add(id); state.selId = id;
  }
  applySelection();
}

// The floating edit panel only appears when it's actually needed — i.e. something is
// selected (and not in read-only). The toolbar button toggles the user's preference.
function applySidebar(): void {
  const wanted = state.sidebarOpen && !state.readOnly;   // user pref, ignoring selection
  const open = wanted && state.sel.size > 0;             // only show when there's a selection
  editor.classList.toggle('open', open);
}
applySidebar();

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
  applySidebar();
  setStatus(ro ? 'Read-only — nothing is saved' : 'Editing enabled');
}
applyReadOnly();   // set the initial open-padlock icon
async function setReadOnly(on: boolean): Promise<void> {
  if (on === state.readOnly) return;
  if (on){
    await flushSave();                                   // persist anything pending before locking (clears the save timer)
    state.readOnly = true;
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
  else { state.sel = new Set([id]); state.selId = id; }
  applySelection();
}
// Tags / colour apply live from the sidebar. The TITLE and BODY are edited on the canvas
// (F2 / slow-click → inline edit), so the sidebar only handles tags, colour, and layout.
function applyRest(): void {
  const n = state.selId ? state.nodes.get(state.selId) : undefined; if (!n) return;
  n.tags = edTags.value.split(',').map(s=>s.trim()).filter(Boolean);
  n.dirty = true;
  // paint first so the card's height is up to date, then reflow: a taller/shorter card pushes
  // its siblings (and its own children) under any non-free parent. Order is untouched.
  paintAll(); applyLayouts(); paintAll(); scheduleSave();
}
edTags.addEventListener('input', applyRest);
// (layout is set via the icon chips above — see setLayout / buildLayoutChips)

// ---------- image attachments live in features/attachments.ts ----------
// ---------- inline title/body editing lives in features/inline-edit.ts ----------
// While a title is being renamed inline, the save loop defers the file rename until editing ends
// (so the folder isn't littered with M.md, Ma.md, Mag.md…) — it keys off `ui.inlineEdit` directly.

// keyboard:
//  · Space          → new node (only when nothing is selected)
//  · Enter          → add a sibling of the selected node
//  · Tab            → add a child of the selected node
//  · F2             → rename the selected node in place (also: slow-click its title)
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
  if (e.key === '/'){ e.preventDefault(); searchBox.focus(); searchBox.select(); return; }   // find a card
  // Space = hand-tool to pan while held; a quick tap (released without panning) makes a node.
  if (e.key === ' '){ e.preventDefault(); if (!e.repeat){ ui.spaceHeld = true; ui.spaceUsedForPan = false; } return; }
  if (e.key === 'f' || e.key === 'F'){ e.preventDefault(); focusOrFit(); return; }
  if ((e.key === 'd' || e.key === 'D') && state.sel.size){ e.preventDefault(); duplicateSelection(); return; }
  if (e.key === 'F2' && state.selId){ e.preventDefault(); startInlineEdit(state.nodes.get(state.selId)); return; }   // selId guards non-null
  if (e.key === 'Enter' && state.selId){ e.preventDefault(); createSibling(state.selId); return; }
  if (e.key === 'Tab' && state.selId){ e.preventDefault(); addChild(state.selId); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel.size){
    e.preventDefault(); deleteSelection();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key !== ' ') return;
  const wasPan = ui.spaceUsedForPan;
  ui.spaceHeld = false; ui.spaceUsedForPan = false;
  if (!isTypingInField() && !wasPan && !ui.pan && state.sel.size === 0) createNode();   // tap = new node
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
    if (onGhost) { abortDrag(); deleteNode(n.id); return; }
    commitDrag();                          // land / reparent exactly where the preview showed
    startInlineEdit(n, { isNew: true });   // drop straight into renaming; Esc cancels creation
  }
  function onCancel(): void {
    const n = endGhostDrag();
    if (n) { abortDrag(); deleteNode(n.id); }
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

// ---- edit-panel action buttons: on-screen equivalents of the keyboard shortcuts,
// so every editing action is reachable on a touch device with no keyboard ----
byId('edRename').onclick = () => { if (state.selId) startInlineEdit(state.nodes.get(state.selId)); };
byId('edDuplicate').onclick = () => duplicateSelection();
byId('edDelete').onclick = () => { if (state.sel.size) deleteSelection(); };


// keyboard shortcuts: ⌘S force-save  (duplicate = D, new node = Space — see plain-key handler)
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); flushSave(); }
});


boot();   // local-first: open straight into the last map
