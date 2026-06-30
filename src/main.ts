// @ts-nocheck — the canvas + in-place-editing core (render / drag / edit / crud / selection).
// Renamed from main.js so the whole codebase is uniformly TypeScript and Vite transpiles it
// the same as every other module. Its ~1.5k lines aren't strict-typed YET: it's one tightly
// coupled interactive subsystem sharing mutable UI state (inlineEdit/bodyEdit/selection) — the
// remaining incremental-typing target. Every OTHER module (core/utils/store/view/features/data
// /boot) is fully typed and checked; `npm run typecheck` covers them.
/* ============================================================
   Markdown Mindmap — PoC v2: hierarchy + collapse + add-child
   Storage: one .md per node. Layout lives in each note's frontmatter as mm_* keys
   (mm_parent = parent note's path, mm_x/mm_y, mm_collapsed) — no sidecar, no ids on disk.
   The filename IS the node's identity; in-memory ids are ephemeral, minted per load.
   Edges are DERIVED from parent — no separate edge list.
   ============================================================ */

import { esc, renderBodyHTML } from './utils/markdown.js';
import { zipBlob, unzip } from './utils/zip.js';
import { parseMd, serializeMd } from './utils/frontmatter.js';
import { childrenOf, isRoot, isHidden, descendantCount, isAncestor } from './utils/model.js';
import { state, world, stage, edgesSvg, togglesSvg, setStatus } from './core/state.js';
import { setupTheme } from './view/theme.js';
import { mountIcons } from './view/icons.js';
import { applyView, cancelViewAnim, screenToWorld, zoomAt, fit, frameBox } from './view/camera.js';
import { applyLayouts, reorderDraggedParents, dirSide, effectiveLayout } from './view/layout.js';
import { searchBox } from './features/search.js';
import { resetImageCache, hydrateImages } from './features/images.js';
import { store, scheduleSave, flushSave, loadFromDir } from './data/persistence.js';
import { showStart, openHelpTab, boot } from './boot.js';

window.__dbg = { get state(){ return state; }, get drag(){ return drag; } };   // TEMP debug hook

mountIcons();                         // fill [data-icon] placeholders with their SVG assets
setupTheme();




// ---------- rendering ----------
function nodeEl(n) {
  if (n.el) return n.el;
  const el = document.createElement('div');
  el.dataset.id = n.id;
  el.innerHTML = `<div class="title"></div><div class="body"></div>
    <span class="hidden-count"></span>
    <div class="addnote" title="Add note">Add note…</div>`;
  world.appendChild(el);
  n.el = el;
  bindNodeDrag(n);
  el.querySelector('.addnote').addEventListener('pointerdown', (e)=>{ e.stopPropagation(); });
  el.querySelector('.addnote').addEventListener('click', (e)=>{ e.stopPropagation(); startBodyEdit(n); });
  // body links: open externally, or jump to a wikilink's node. Don't let the click bubble to
  // the card (which would select / toggle the panel); pointerdown is stopped in bindNodeDrag.
  el.querySelector('.body').addEventListener('click', (e)=>{
    const a = e.target.closest('a.lk'); if (!a) return;
    e.stopPropagation();
    if (a.classList.contains('wikilink')){
      e.preventDefault();
      focusByTitle(a.dataset.target);
    }
  });
  // task checkboxes: toggle the matching [ ]/[x] in the body and persist
  el.querySelector('.body').addEventListener('change', (e)=>{
    const cb = e.target.closest('input.taskbox'); if (!cb) return;
    e.stopPropagation();
    toggleTask(n, +cb.dataset.ti);
  });
  // inline title rename: typing reflows + validates; Enter/Tab commit, Escape cancels, blur commits
  const titleEl = el.querySelector('.title');
  titleEl.addEventListener('input',   ()  => onInlineInput(n));
  titleEl.addEventListener('keydown', (e) => onInlineKeydown(e, n));
  titleEl.addEventListener('blur',    ()  => { if (inlineEdit && inlineEdit.id === n.id) endInlineEdit(); });
  // double-click a node to fold/unfold it (cancels a pending slow-click rename). If the card was
  // part of a multi-selection an instant ago (the first click collapsed it to one), fold the whole
  // group and keep it selected, rather than just this card.
  el.addEventListener('dblclick', (e)=>{
    // while editing this card's title or body, a double-click selects a word — don't fold
    if ((inlineEdit && inlineEdit.id === n.id) || (bodyEdit && bodyEdit.id === n.id)) return;
    e.stopPropagation(); e.preventDefault();
    clearTimeout(renameTimer);          // a double-click means "fold", not "rename"
    const g = pendingGroupFold;
    pendingGroupFold = null;
    if (g && g.node === n.id && g.ids.has(n.id) && performance.now() - g.t < 600){
      toggleCollapseSelection(g.ids);
      setSelectionSet(g.ids);           // restore the group so it stays selected after folding
    } else {
      toggleCollapse(n.id);
    }
  });
  return el;
}
// A card's colour is its own, or — if unset — inherited from the nearest coloured ancestor.
// While Alt-dragging to detach, preview the result: treat the dragged node as a root (stop the
// ancestor walk there), so it — and its descendants — show the colour they'd have once cut loose.
// An inheriting card with no coloured ancestor (a root left on the default "inherit") falls back
// to grey, so it gets the same neutral card bg as an explicit grey rather than going transparent.
// Explicit 'none' still short-circuits below (it's truthy), so "no colour" stays transparent.
function effectiveColor(n){
  const detachId = (drag && drag.alt && !drag.shift) ? drag.active.id : null;
  for (let c = n; c; c = (c.id === detachId) ? null : (c.parent && state.nodes.get(c.parent)))
    if (c.color) return c.color;
  return 'grey';
}
function paintNode(n) {
  const el = nodeEl(n);
  if (isHidden(n)) { el.style.display = 'none'; return; }
  el.style.display = '';
  const hasKids = childrenOf(n.id).length > 0;
  const editingBody = bodyEdit && bodyEdit.id === n.id;    // body editor open on this card
  const hasBody = editingBody || !!(n.body && n.body.trim());  // keep the body slot while editing
  const collapsedKids = n.collapsed && hasKids;            // hidden children → +N chip
  const collapsed = n.collapsed && (hasKids || hasBody);   // folded to just its title
  el.className = 'node c-' + effectiveColor(n)
    + (state.sel.has(n.id) ? ' sel' : '')
    + (state.sel.size === 1 && state.sel.has(n.id) ? ' solo' : '')   // lone selection → show +
    + (collapsed ? ' collapsed' : '')
    + (hasBody ? '' : ' no-body')
    + (state.searchMatch && !state.searchMatch.has(n.id) ? ' search-dim' : '');
  // During drag: keep left/top frozen at the pre-drag origin and move via transform (compositor-only).
  // Outside drag: commit position normally and clear any leftover transform.
  const dragOrig = drag?.origins?.get(n.id);
  if (dragOrig) {
    el.style.left = dragOrig.x + 'px'; el.style.top = dragOrig.y + 'px';
    el.style.transform = `translate(${n.x - dragOrig.x}px,${n.y - dragOrig.y}px)`;
  } else {
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
    if (el.style.transform) el.style.transform = '';
  }
  // don't clobber the title while it's being inline-edited (the user is typing into it)
  if (!(inlineEdit && inlineEdit.id === n.id)) el.querySelector('.title').textContent = n.title;
  const bodyEl = el.querySelector('.body');
  // don't clobber the body while it's being edited in place (the textarea lives inside .body)
  if (!editingBody) {
    bodyEl.innerHTML = renderBodyHTML(n.body);
    hydrateImages(bodyEl);   // swap inline-image placeholders for resolved (blob/remote) URLs
  }
  // folded branch → hidden-descendant count; folded leaf → empty bubble (a white dot)
  if (collapsed) el.querySelector('.hidden-count').textContent = collapsedKids ? String(descendantCount(n.id)) : '';
}
export const NODE_W = 200;
export function nodeH(n){ return (n.el && n.el.offsetHeight) || 64; } // live height (falls back pre-render)
// Height used for LAYOUT geometry. The selection affordances (+ and the "add note" bubble) are
// absolutely positioned and overhang the card, so they don't inflate its measured height — a
// title-only card lays out the same whether or not it's selected.
export function layoutH(n){
  const el = n.el; if (!el) return 64;
  return el.offsetHeight;
}
function nodeCenter(n){ return { x: n.x + NODE_W/2, y: n.y + nodeH(n)/2 }; }

// Bright per-branch line colours (match the .c-*-cardline borders); 'none' falls back to --edge.
const EDGE_TINT = { slate:'#7088e0', red:'#f25c72', amber:'#f2ab44', green:'#3fcf81',
  teal:'#33c5d8', blue:'#5fa3f5', violet:'#9d70f0', pink:'#f262ad', grey:'#4a5a6e' };
const EDGE_GAP = 0;    // px the line stops short of a card border (0 = touch the border)
const EDGE_R   = 12;   // corner radius on orthogonal elbows
// polyline → path with rounded corners (quadratic at each interior vertex, clamped to leg length)
function roundedPath(pts, r){
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length-1; i++){
    const p = pts[i], prev = pts[i-1], next = pts[i+1];
    const toward = (q, dist) => {
      const dx = q.x-p.x, dy = q.y-p.y, L = Math.hypot(dx, dy) || 1;
      return { x: p.x + dx/L*dist, y: p.y + dy/L*dist };
    };
    const e1 = toward(prev, Math.min(r, Math.hypot(p.x-prev.x, p.y-prev.y)/2));
    const e2 = toward(next, Math.min(r, Math.hypot(p.x-next.x, p.y-next.y)/2));
    d += ` L ${e1.x} ${e1.y} Q ${p.x} ${p.y} ${e2.x} ${e2.y}`;
  }
  const last = pts[pts.length-1];
  return d + ` L ${last.x} ${last.y}`;
}
// Build an SVG path `d` for a parent→child edge in the current style:
//   straight    — one diagonal segment between the facing borders
//   orthogonal  — right-angle elbow with rounded corners (H & V only)
//   bezier      — smooth curve with tangents along the dominant axis
// All styles leave a small gap at each card border.
// Which border a parent→child edge leaves from. A line/fan parent owns its children's side,
// so every edge leaves from its layoutDir border; a free parent connects each child from the
// nearest dominant-axis border (so a child dragged left connects on the left, etc.).
function edgeSide(parent, child){
  // Use the EFFECTIVE layout, not the raw field: a node with type `none` that inherits
  // line/fan from an ancestor owns its children's side too, so its edges must leave from
  // the inherited direction's border — otherwise an inherited-fan node draws free-style
  // edges and looks different from an explicit-fan node with the same placement.
  const eff = effectiveLayout(parent);
  if (eff.type === 'line' || eff.type === 'fan') return dirSide(eff.dir);
  const pc = nodeCenter(parent), cc = nodeCenter(child);
  // two-sided splits along the direction's AXIS, so the edge must leave from the axis end that
  // matches the child's wing — never the cross axis (outer children spread wide on the cross
  // axis would otherwise pick left/right on an up/down split).
  if (eff.type === 'two-sided'){
    const horizAxis = dirSide(eff.dir) === 'left' || dirSide(eff.dir) === 'right';
    return horizAxis ? (cc.x >= pc.x ? 'right' : 'left') : (cc.y >= pc.y ? 'down' : 'up');
  }
  const dx = cc.x - pc.x, dy = cc.y - pc.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}
function edgePath(parent, child){
  const pc = nodeCenter(parent), cc = nodeCenter(child);
  const side = edgeSide(parent, child);
  const horizontal = side === 'left' || side === 'right';
  let a, b;
  if (side === 'down')      { a = { x:pc.x, y:parent.y + nodeH(parent) }; b = { x:cc.x, y:child.y }; }
  else if (side === 'up')   { a = { x:pc.x, y:parent.y };                 b = { x:cc.x, y:child.y + nodeH(child) }; }
  else if (side === 'right'){ a = { x:parent.x + NODE_W, y:pc.y };        b = { x:child.x, y:cc.y }; }
  else                      { a = { x:parent.x, y:pc.y };                 b = { x:child.x + NODE_W, y:cc.y }; }
  if (state.edgeStyle === 'straight') return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  if (state.edgeStyle === 'bezier'){
    if (horizontal){ const k = (b.x - a.x)/2; return `M ${a.x} ${a.y} C ${a.x+k} ${a.y} ${b.x-k} ${b.y} ${b.x} ${b.y}`; }
    const k = (b.y - a.y)/2;  return `M ${a.x} ${a.y} C ${a.x} ${a.y+k} ${b.x} ${b.y-k} ${b.x} ${b.y}`;
  }
  // orthogonal: rounded elbow (H→V→H when horizontal, V→H→V when vertical)
  const pts = horizontal
    ? [a, { x:(a.x+b.x)/2, y:a.y }, { x:(a.x+b.x)/2, y:b.y }, b]
    : [a, { x:a.x, y:(a.y+b.y)/2 }, { x:b.x, y:(a.y+b.y)/2 }, b];
  return roundedPath(pts, EDGE_R);
}
function paintEdges() {
  // While filtering, hide ALL lines — dimmed cards are semi-transparent, so faint lines would
  // show through them and read as clutter. Cleaner to drop the lines entirely until search ends.
  if (state.searchMatch){ edgesSvg.innerHTML = ''; togglesSvg.innerHTML = ''; return; }
  let svg = '';
  // Draw a connector for every parent→child edge where BOTH ends are visible.
  // A collapsed node hides its children, so those edges simply don't appear.
  for (const n of state.nodes.values()) {
    if (isRoot(n)) continue;
    const parent = state.nodes.get(n.parent);
    if (!parent) continue;
    if (isHidden(parent) || isHidden(n)) continue;
    // While Alt-dragging this node we're previewing detach-to-root, so drop its parent
    // edge entirely (no line, not even a dotted one).
    if (drag && drag.alt && !drag.shift && drag.n.id === n.id) continue;
    // Poised over a valid new parent (the card is shown as a dotted ghost): hide its old
    // parent edge too, so the line doesn't dangle from a card that's about to move.
    if (drag && drag.dropTarget && drag.active.id === n.id) continue;
    // While Shift-cloning, the dragged copies aren't placed yet — don't draw their parent edges.
    if (drag && drag.cloned && drag.targets.has(n.id)) continue;
    // tint by the child's branch colour
    const tint = EDGE_TINT[effectiveColor(n)];
    const style = tint ? ` style="stroke:${tint}"` : '';
    svg += `<path${style} d="${edgePath(parent, n)}"/>`;
  }
  edgesSvg.innerHTML = svg;
  togglesSvg.innerHTML = '';             // no edge toggles anymore
}
export function paintAll() {
  for (const n of state.nodes.values()) paintNode(n);
  paintEdges();
}

// ---------- animated relayout (expand / collapse) ----------
function prefersReducedMotion(){ try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
function placeNodeEl(n){ if (n.el){ n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px'; } }
function setNodeElXY(n, x, y){ if (n.el){ n.el.style.left = x + 'px'; n.el.style.top = y + 'px'; } }
// Newly revealed cards emanate from the nearest ancestor that was already on screen.
function ancestorStart(node, before){
  let p = node.parent ? state.nodes.get(node.parent) : null;
  while (p){ const b = before.get(p.id); if (b) return b; p = p.parent ? state.nodes.get(p.parent) : null; }
  return { x: node.x, y: node.y };
}
// Cards glide to new spots via a CSS transition; SVG edges can't transition, so for the duration
// we redraw them each frame from the cards' live (animating) on-screen positions.
let animToken = 0;
function followEdges(tok, ms){
  const t0 = performance.now();
  const tick = (now) => {
    if (tok !== animToken) return;                  // superseded by a newer animation
    const saved = [];
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
function withLayoutAnimation(mutate){
  const before = new Map();
  for (const m of state.nodes.values()) if (m.el && !isHidden(m)) before.set(m.id, { x:m.x, y:m.y });
  mutate();
  paintAll();          // reveal/hide DOM and measure real heights
  applyLayouts();      // compute FINAL positions into n.x/n.y (DOM not updated yet)
  const visible = [...state.nodes.values()].filter(m => m.el && !isHidden(m));
  const tok = ++animToken;                           // supersede any in-flight animation
  if (prefersReducedMotion()){ for (const m of visible){ m.el.classList.remove('lt-anim'); placeNodeEl(m); } paintEdges(); return; }
  // 1) park every visible card at its STARTING spot with no transition; just-revealed cards
  //    also start invisible so they fade in (covers free layouts where nothing reflows)
  for (const m of visible){
    m.el.classList.remove('lt-anim');
    const s = before.get(m.id) || ancestorStart(m, before);
    setNodeElXY(m, s.x, s.y);
    if (!before.has(m.id)) m.el.style.opacity = '0';
  }
  void document.body.offsetWidth;                    // commit the start positions before transitioning
  // 2) turn on the transition and move every card to its FINAL spot → the browser animates left/top
  const DUR = 320;
  for (const m of visible){ m.el.classList.add('lt-anim'); placeNodeEl(m); m.el.style.opacity = ''; }
  // 3) edges follow the moving cards; drop the transition class once it's done
  followEdges(tok, DUR + 20);
  setTimeout(() => { if (tok !== animToken) return; for (const m of visible) m.el && m.el.classList.remove('lt-anim'); paintEdges(); }, DUR + 60);
}

// ---------- edge style (straight / orthogonal / bezier), persisted ----------
const EDGE_KEY = 'mindmap.edgeStyle';
const EDGE_STYLES = ['orthogonal', 'bezier', 'straight'];
function initEdgeStyle(){
  let saved = null;
  try { saved = localStorage.getItem(EDGE_KEY); } catch {}
  if (EDGE_STYLES.includes(saved)) state.edgeStyle = saved;
}
function cycleEdgeStyle(){
  const i = EDGE_STYLES.indexOf(state.edgeStyle);
  state.edgeStyle = EDGE_STYLES[(i + 1) % EDGE_STYLES.length];
  try { localStorage.setItem(EDGE_KEY, state.edgeStyle); } catch {}
  paintEdges();
  setStatus(`Edge style: ${state.edgeStyle}`);
}
initEdgeStyle();

// Toggle one node's collapse: folds it down to just its title — hides its body and, if it has
// children, folds them (and everything below) too. A leaf with a body can fold its body alone.
function toggleCollapse(id){
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
function toggleCollapseSelection(ids){
  const cards = [...ids].map(id => state.nodes.get(id)).filter(Boolean)
    .filter(n => childrenOf(n.id).length > 0 || !!(n.body && n.body.trim()));
  if (!cards.length) return;
  const target = !cards.every(n => n.collapsed);   // all collapsed → expand; otherwise collapse all
  withLayoutAnimation(() => { for (const n of cards){ n.collapsed = target; n.dirtyLayout = true; } });
  scheduleSave();
  setStatus(`${target ? 'Collapsed' : 'Expanded'} ${cards.length} card${cards.length > 1 ? 's' : ''}`);
}
// Flip the idx-th task checkbox in a node's body and write the change back to disk.
function toggleTask(n, idx){
  if (state.readOnly) return;
  let i = 0;
  n.body = n.body.replace(/^(\s*[-*+]\s+)\[([ xX])\]/gm, (m, pre, mark) =>
    i++ === idx ? pre + (mark === ' ' ? '[x]' : '[ ]') : m);
  n.dirty = true;
  if (bodyEdit && bodyEdit.id === n.id) bodyEdit.ta.value = n.body;   // keep an open in-card editor in sync
  paintNode(n); scheduleSave();
}

// ---------- node dragging (moves the whole subtree) ----------
let drag = null;
let dragRAF = null;   // pending rAF for drag paint; coalesces multiple pointermove events per frame
let autoPanRAF = null;
// While a node is dragged to the screen edge, pan the view so you can drop onto cards that are
// currently off-screen. The view pans toward the edge the cursor sits in, and the dragged subtree
// is shifted in world-space by the inverse so it stays glued under the (stationary) cursor.
// Drain the deferred drag paint: update drop-target highlight and redraw edges every frame.
function flushDragPaint(){
  dragRAF = null;
  if (!drag) return;
  if (drag.moved && !drag.multi) {
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
  }
  paintEdges();   // n.x/y is current, so edges track the dragged nodes correctly
  if (drag.moved && !autoPanRAF) autoPanRAF = requestAnimationFrame(autoPanStep);
}
function stopAutoPan(){ if (autoPanRAF){ cancelAnimationFrame(autoPanRAF); autoPanRAF = null; } }
function autoPanStep(){
  autoPanRAF = null;
  if (!drag || !drag.moved || state.readOnly) return;
  // Available canvas = the stage minus the toolbar (above it) and the edit panel (to its right).
  // Panning kicks in as the cursor reaches those obstructions, so you can drag onto / past them.
  const r = stage.getBoundingClientRect();
  const ed = document.getElementById('editor');
  const right = (ed && ed.classList.contains('open')) ? Math.min(r.right, ed.getBoundingClientRect().left) : r.right;
  const M = 56, MAX = 16;   // edge band (px) and max pan speed (px/frame)
  let vx = 0, vy = 0;
  const x = drag.cx, y = drag.cy;
  if (x < r.left + M)     vx =  Math.min(1, (r.left + M - x) / M);
  else if (x > right - M) vx = -Math.min(1, (x - (right - M)) / M);
  if (y < r.top + M)        vy =  Math.min(1, (r.top + M - y) / M);
  else if (y > r.bottom - M) vy = -Math.min(1, (y - (r.bottom - M)) / M);
  if (vx || vy){
    cancelViewAnim();
    vx *= MAX; vy *= MAX;
    state.view.x += vx; state.view.y += vy; applyView();
    // shift the dragged subtree's anchors opposite the pan so the cursor-to-card offset never
    // changes (only `targets` — `start` keeps its own positions for clone/reset).
    const wdx = -vx / state.view.k, wdy = -vy / state.view.k;
    for (const s of drag.targets.values()){ s.x += wdx; s.y += wdy; }
    const ddx = (drag.cx - drag.sx) / state.view.k, ddy = (drag.cy - drag.sy) / state.view.k;
    for (const [id, s] of drag.targets){
      const m = state.nodes.get(id); if (!m) continue;
      m.x = s.x + ddx; m.y = s.y + ddy; m.dirtyLayout = true;
      if (m.el) { const orig = drag.origins.get(id); if (orig) m.el.style.transform = `translate(${m.x-orig.x}px,${m.y-orig.y}px)`; }
    }
    if (!drag.multi) {
      updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
    }
    paintEdges();   // redraw edges every auto-pan frame so they follow the moving nodes
  }
  autoPanRAF = requestAnimationFrame(autoPanStep);
}
let inlineEdit = null;   // { id, orig, el } while a card title is being renamed in place
let renameTimer = null;  // pending slow-click rename; any node interaction cancels it
// A plain click on a card inside a multi-selection collapses the selection to that one card. We
// stash the just-cleared group here so a double-click that follows can fold the WHOLE group
// instead of only the clicked card. { ids, node, t } — consumed (and time-checked) by dblclick.
let pendingGroupFold = null;
export function subtreeIds(id){
  // id + every descendant
  const out = [id];
  for (const ch of childrenOf(id)) out.push(...subtreeIds(ch.id));
  return out;
}
function bindNodeDrag(n) {
  const el = n.el;
  // Double-tap on touch → collapse/expand (mirrors dblclick on desktop; also prevents iOS double-tap zoom)
  let lastTouchTap = 0, lastTouchTapTarget = null;
  el.addEventListener('touchstart', (e) => {
    // While editing this card, let the browser handle double-tap normally (word selection)
    if ((inlineEdit && inlineEdit.id === n.id) || (bodyEdit && bodyEdit.id === n.id)) { lastTouchTap = 0; return; }
    const now = performance.now();
    if (e.touches.length === 1 && now - lastTouchTap < 300) {
      e.preventDefault(); // stop double-tap zoom and synthetic dblclick
      clearTimeout(renameTimer);
      // Mirror the dblclick handler: fold/unfold (collapse/expand) the card or group
      const g = pendingGroupFold;
      pendingGroupFold = null;
      if (g && g.node === n.id && g.ids.has(n.id) && now - g.t < 600) {
        toggleCollapseSelection(g.ids);
        setSelectionSet(g.ids);
      } else {
        toggleCollapse(n.id);
      }
      lastTouchTap = 0;
      return;
    }
    lastTouchTap = now;
    lastTouchTapTarget = e.target;
  }, { passive: false });
  el.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('addnote')) return;
    if (e.target.closest('a.lk, input.taskbox')) { e.stopPropagation(); return; }  // let links/checkboxes click, not drag
    // Close an editor open on a DIFFERENT card (tap-outside on touch where blur may not fire)
    if (inlineEdit && inlineEdit.id !== n.id) endInlineEdit();
    if (bodyEdit   && bodyEdit.id   !== n.id) endBodyEdit();
    // while this card's title/body is being edited, let clicks place the caret — don't start a drag
    if ((inlineEdit && inlineEdit.id === n.id) || (bodyEdit && bodyEdit.id === n.id)) { e.stopPropagation(); return; }
    clearTimeout(renameTimer);   // any fresh interaction cancels a pending slow-click rename
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    // Dragging a card that's part of a multi-selection moves the WHOLE selection at once;
    // otherwise just this card's subtree. `active` is the node dragged/dropped; `targets`
    // are the nodes that follow the cursor (or, after a Shift-clone, just the clone).
    const multi = state.sel.has(n.id) && state.sel.size > 1;
    const rootIds = multi ? [...state.sel] : [n.id];
    const ids = [...new Set(rootIds.flatMap(id => subtreeIds(id)))];
    const start = new Map(ids.map(id => {
      const m = state.nodes.get(id); return [id, { x:m.x, y:m.y }];
    }));
    // targets gets its OWN {x,y} objects (not new Map(start), which shares the value refs) so the
    // edge auto-pan can shift the dragged anchors without also moving the pinned `start` positions.
    const targets = new Map([...start].map(([id, s]) => [id, { x:s.x, y:s.y }]));
    // origins = the left/top CSS values frozen at drag start; transforms are relative to these
    const origins = new Map(ids.map(id => { const m2 = state.nodes.get(id); return [id, { x:m2.x, y:m2.y }]; }));
    drag = { n, active:n, multi, sx:e.clientX, sy:e.clientY, cx:e.clientX, cy:e.clientY, start, targets, origins,
             moved:false, dropTarget:null, alt:e.altKey, shift:e.shiftKey, cloned:false,
             downTarget:e.target,              // where the press landed → slow-click edits title or body
             meta: e.metaKey || e.ctrlKey,     // ⌘/Ctrl-click toggles this card in the selection
             touch: e.pointerType === 'touch' }; // higher move threshold for finger taps
    for (const id of ids) { const m2 = state.nodes.get(id); if (m2?.el) m2.el.style.willChange = 'transform'; }
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || drag.n !== n) return;
    if (state.readOnly) return;        // no moving/reparenting in read-only (click & dbl-click still work)
    drag.alt = e.altKey; drag.shift = e.shiftKey;   // Shift = clone (live — release to cancel), Alt = detach
    drag.cx = e.clientX; drag.cy = e.clientY;   // remembered for edge auto-pan and RAF flush
    const dx = (e.clientX - drag.sx)/state.view.k, dy = (e.clientY - drag.sy)/state.view.k;
    if (Math.abs(dx)+Math.abs(dy) > (drag.touch ? 8 : 2)){ drag.moved = true; document.body.classList.add('grabbing'); }
    applyDragClone();   // Shift held → leave a clone & drag the copy; Shift released → undo it
    // Update world-space positions immediately (cheap) — visual render is deferred to rAF so that
    // multiple pointermove events arriving within one display frame collapse into a single paint.
    for (const [id, s] of drag.targets){
      const m = state.nodes.get(id); if (!m) continue;
      m.x = s.x + dx; m.y = s.y + dy; m.dirtyLayout = true;
      // Compositor fast path: move via transform (no layout) keeping left/top frozen at origin.
      if (m.el) { const orig = drag.origins.get(id); if (orig) m.el.style.transform = `translate(${m.x-orig.x}px,${m.y-orig.y}px)`; }
    }
    if (!dragRAF) dragRAF = requestAnimationFrame(flushDragPaint);
  });
  el.addEventListener('pointerup', () => {
    stopAutoPan();
    if (dragRAF){ cancelAnimationFrame(dragRAF); dragRAF = null; }
    if (drag && drag.n === n) {
      // Clear compositor transforms so paintAll()/paintNode() can commit final left/top cleanly.
      for (const id of new Set([...drag.targets.keys(), ...drag.start.keys()])){
        const m2 = state.nodes.get(id);
        if (m2?.el){ m2.el.style.transform = ''; m2.el.style.willChange = ''; }
      }
      const act = drag.active;
      if (!drag.moved) {
        if (drag.meta) toggleSel(n.id);                 // ⌘/Ctrl-click: add/remove from selection
        else if (state.selId !== n.id || state.sel.size !== 1) {
          // clicking one card of a multi-selection reduces to it — but remember the group so a
          // double-click can fold them all (see the dblclick handler).
          if (state.sel.has(n.id) && state.sel.size > 1)
            pendingGroupFold = { ids:new Set(state.sel), node:n.id, t:performance.now() };
          selectNode(n.id);
        }
        else if (!state.readOnly) {
          // a second (slow) click on the already-sole-selected card = edit in place, Finder-style.
          // Click the title → rename; click anywhere else on the card → edit the note.
          // Delay it so a double-click (which fires dblclick first) can cancel it and fold instead.
          clearTimeout(renameTimer);
          const onTitle = !!(drag.downTarget && drag.downTarget.closest && drag.downTarget.closest('.title'));
          renameTimer = setTimeout(() => onTitle ? startInlineEdit(n) : startBodyEdit(n), 260);
        }
      } else {
        // dropped onto a node? re-parent. Alt+drop on empty canvas? detach to root.
        // Otherwise it's just a move.
        const tgt = drag.dropTarget;
        const { cloned, targets, alt, shift, clones } = drag;
        clearDropTarget();
        act.el?.classList.remove('reparent-ghost');
        // Null drag NOW so every paintAll/paintEdges in the commit phase sees no active drag
        // and draws all edges. (Previously edges remained hidden because drag was still set
        // when paintAll was called, and nothing repainted after drag = null.)
        drag = null;
        document.body.classList.remove('grabbing');
        if (tgt && tgt !== act.parent) {
          // reparent in place: the card keeps its ORIGINAL position, only its parent changes
          // (a clone keeps where you dropped it, since that's a fresh card you're placing).
          if (!cloned){
            for (const [id, s] of targets){
              const m = state.nodes.get(id); if (m){ m.x = s.x; m.y = s.y; m.dirtyLayout = true; }
            }
          }
          reparent(act.id, tgt);
        } else {
          // snap onto the 20px grid: align the dragged node, shift the rest of its
          // subtree by the same delta so relative layout is preserved.
          const GRID = 20;
          const ddx = Math.round(act.x / GRID) * GRID - act.x;
          const ddy = Math.round(act.y / GRID) * GRID - act.y;
          for (const id of targets.keys()){
            const m = state.nodes.get(id); if (!m) continue;
            m.x += ddx; m.y += ddy; m.dirtyLayout = true;
          }
          if (alt && !shift && act.parent) {
            act.parent = null;
            setStatus(`”${act.title}” is now a root`);
          }
        }
        // Paint first so freshly-created clone cards have real DOM heights before applyLayouts
        // measures them — otherwise a chain/fan of clones lays out on the 64px height fallback
        // (only the first lands right). Mirrors the duplicate path: paint → layout → paint.
        paintAll();
        reorderDraggedParents(targets.keys());   // a drag is the ONLY thing that reorders siblings
        applyLayouts(); paintAll();   // re-snap any dragged child back into its parent's layout
        // select the new clone(s) you just dragged out
        if (cloned){ if (clones && clones.length > 1) setSelectionSet(clones.map(c => c.id)); else selectNode(act.id); }
        scheduleSave();
        return;   // drag/grabbing already cleared above
      }
    }
    drag = null;
    document.body.classList.remove('grabbing');
  });
}
// Bring the Shift-clone state in line with the live `drag.shift` flag. Shift down (and moved past
// the threshold) leaves a clone of each dragged card at its start spot and drags the COPIES away;
// Shift released before drop deletes the clones and reverts to plain-moving the originals.
function applyDragClone(){
  if (!drag || !drag.moved) return;
  if (drag.shift && !drag.cloned){
    drag.cloned = true;
    for (const [id, s] of drag.start){             // pin the original subtree(s) back to start
      const m = state.nodes.get(id); if (m){ m.x = s.x; m.y = s.y; m.dirtyLayout = false; }
      if (m?.el) m.el.style.transform = '';        // revert their compositor transforms
    }
    // clone each dragged root (just the card, not its subtree) at its own start spot
    const rootIds = drag.multi ? [...state.sel] : [drag.n.id];
    const clones = rootIds.map(id => leaveClone(state.nodes.get(id), drag.start.get(id)));
    drag.clones = clones;
    drag.active = clones[0];                        // representative (drives single-card reparent)
    drag.targets = new Map(rootIds.map((id, i) => { const sp = drag.start.get(id); return [clones[i].id, { x:sp.x, y:sp.y }]; }));
    drag.origins = new Map([...drag.targets].map(([id, s]) => [id, { x:s.x, y:s.y }]));
    drag.edgesPainted = false;
    paintAll();                                    // render + bind the new clone nodes
  } else if (!drag.shift && drag.cloned){
    for (const clone of (drag.clones || [])){
      if (clone.el){ clone.el.style.transform = ''; clone.el.style.willChange = ''; }
      state.nodes.delete(clone.id); clone.el?.remove();   // drop the clones we made
    }
    drag.clones = null;
    drag.cloned = false;
    drag.active = drag.n;                           // back to dragging the original
    drag.targets = new Map([...drag.start].map(([id, s]) => [id, { x:s.x, y:s.y }]));
    drag.origins = new Map([...drag.start]);         // restore origins for the original subtree
    drag.edgesPainted = false;
    setStatus(`Duplication cancelled — moving “${drag.n.title}”`);
    paintAll();
  }
}
// Snap the dragged subtree (and drop-target / edges) to the current cursor without a pointer move —
// used when a modifier toggles mid-drag, so the result is reflected instantly while the mouse is still.
function dragFollow(){
  if (!drag) return;
  const dx = (drag.cx - drag.sx)/state.view.k, dy = (drag.cy - drag.sy)/state.view.k;
  for (const [id, s] of drag.targets){
    const m = state.nodes.get(id); if (!m) continue;
    m.x = s.x + dx; m.y = s.y + dy; m.dirtyLayout = true;
    if (m.el) { const orig = drag.origins.get(id); if (orig) m.el.style.transform = `translate(${m.x-orig.x}px,${m.y-orig.y}px)`; }
  }
  if (drag.moved && !drag.multi) updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
  paintEdges();   // modifier changed mid-drag — always repaint (infrequent)
}
// Update the detach preview the instant Alt is pressed/released mid-drag, even if the pointer
// isn't moving: repaint the dragged subtree (its colour previews the detached result) and the edges.
function paintDetachPreview(){
  if (drag) for (const id of subtreeIds(drag.active.id)){ const m = state.nodes.get(id); if (m) paintNode(m); }
  paintEdges();
}
window.addEventListener('keydown', (e) => {
  if (!drag) return;
  if (e.key === 'Alt'){ drag.alt = true;  paintDetachPreview(); }
  if (e.key === 'Shift'){ drag.shift = true;  applyDragClone(); dragFollow(); }
});
window.addEventListener('keyup',   (e) => {
  if (!drag) return;
  if (e.key === 'Alt'){ drag.alt = false; paintDetachPreview(); }
  if (e.key === 'Shift'){ drag.shift = false; applyDragClone(); dragFollow(); }
});

// ---------- reconnect (re-parent by drag-and-drop) ----------
function updateDropTarget(dragged, e){
  const sub = new Set(subtreeIds(dragged.id)); // dragged card + all its descendants
  // Geometric hit test in world space — no layout read, no elementsFromPoint.
  // stage is position:fixed; inset:0 so its origin is always (0,0).
  const wx = (e.clientX - state.view.x) / state.view.k;
  const wy = (e.clientY - state.view.y) / state.view.k;
  let hovered = null;
  for (const [id, m] of state.nodes) {
    if (isHidden(m) || sub.has(id)) continue;
    const h = nodeH(m);
    if (wx >= m.x && wx <= m.x + NODE_W && wy >= m.y && wy <= m.y + h){ hovered = id; break; }
  }
  clearDropTarget();
  let target = null;
  // Refusing to drop onto your own child/descendant would make a cycle — say so out loud,
  // otherwise the drag just silently does nothing and looks broken.
  if (hovered && sub.has(hovered)){
    setStatus(`Can’t parent “${dragged.title}” onto its own child/descendant`);
  } else if (hovered && hovered === dragged.parent){   // already its parent — nothing to do
    const p = state.nodes.get(hovered);
    setStatus(`“${dragged.title}” is already a child of “${p ? p.title : 'that card'}”`);
  } else if (hovered){
    target = hovered;
  }
  if (drag) drag.dropTarget = target;
  if (target){
    const tEl = state.nodes.get(target)?.el;
    if (tEl) tEl.classList.add('drop-target');
  }
  // poised over a valid parent → ghost the dragged card so the parent shows through
  if (dragged.el) dragged.el.classList.toggle('reparent-ghost', !!target);
}
function clearDropTarget(){
  document.querySelectorAll('.node.drop-target').forEach(el => el.classList.remove('drop-target'));
}
function reparent(childId, newParentId){
  if (state.readOnly) return;
  const child = state.nodes.get(childId);
  if (!child || childId === newParentId) return;
  if (isAncestor(childId, newParentId)) return; // would create a cycle
  child.parent = newParentId;
  child.dirtyLayout = true;
  applyLayouts(); paintAll();
  setStatus(`Re-parented “${child.title}” → “${state.nodes.get(newParentId).title}”`);
}

// ---------- add child ----------
function addChild(parentId){
  if (state.readOnly) return;
  const parent = state.nodes.get(parentId); if (!parent) return;
  if (parent.collapsed){ parent.collapsed = false; } // reveal so the new child is visible
  const sibs = childrenOf(parentId);
  const id = 'n' + (state.idSeq++);
  const n = {
    id, file:null,
    x: parent.x + 40 + sibs.length * 30,
    y: parent.y + 150 + sibs.length * 10,
    parent: parentId, collapsed:false,
    title: uniqueTitle('New Node'), color:'', keepStatus:'', tags:[], body:'',
    layoutType:'none', layoutDir:'right',
    dirty:true, dirtyLayout:true,
  };
  state.nodes.set(id, n);
  applyLayouts();        // a line/fan parent immediately slots the new child into place
  paintAll();
  selectNode(id);
  startInlineEdit(n, { isNew: true });   // drop straight into renaming the fresh card; Esc cancels creation
  scheduleSave();
}

// Add a SIBLING of `refId` — a new node sharing its parent. For a parented node we delegate
// to addChild so the parent's order/layout handling stays in one place; a root-level node has
// no parent, so its "sibling" is a fresh unconnected node placed just below it.
function createSibling(refId){
  if (state.readOnly) return;
  const ref = state.nodes.get(refId); if (!ref) return;
  if (ref.parent != null) return addChild(ref.parent);
  return createNode({ x: ref.x, y: ref.y + nodeH(ref) + 40 });
}

// ---------- pan / zoom ----------
let pan = null, marquee = null, spaceHeld = false, spaceUsedForPan = false;
const marqueeEl = document.createElement('div');
marqueeEl.id = 'marquee'; stage.appendChild(marqueeEl);

// ---- touch gestures: track each finger that lands on the empty canvas. One finger marquee-selects
// (same as mouse), two fingers pinch-zoom + pan. (Mouse keeps Space-to-pan / marquee-select behaviour.)
const gPointers = new Map();   // pointerId -> {x,y}
let pinch = null;              // { dist, cx, cy } of the active two-finger gesture
const gDist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
function startPinch(){
  const [a,b] = [...gPointers.values()];
  pinch = { dist: gDist(a,b), cx:(a.x+b.x)/2, cy:(a.y+b.y)/2 };
}

// Empty-canvas drag = rubber-band SELECT (mouse and single-finger touch). Hold Space / middle-button to PAN.
stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.node')) return;            // node drags capture their own pointer
  cancelViewAnim();
  // Tapping the canvas background closes any open in-place text editor (important on touch)
  if (inlineEdit) { endInlineEdit(); return; }
  if (bodyEdit)   { endBodyEdit();   return; }

  if (e.pointerType !== 'mouse'){                   // touch / pen
    gPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if (gPointers.size === 1){                      // one finger → marquee select (pan with two fingers)
      marquee = { sx:e.clientX, sy:e.clientY, add:false, base:new Set(state.sel), moved:false };
      drawMarquee(e.clientX, e.clientY);
      marqueeEl.style.display = 'block';
      stage.setPointerCapture(e.pointerId);         // keep events on stage even when finger slides onto a node
    } else if (gPointers.size === 2){               // second finger → pinch-zoom + two-finger pan
      marquee = null; marqueeEl.style.display = 'none';
      startPinch();
    }
    return;
  }

  if (spaceHeld || e.button === 1){                 // hand-pan
    if (spaceHeld) spaceUsedForPan = true;
    pan = { sx:e.clientX, sy:e.clientY, ox:state.view.x, oy:state.view.y };
    stage.classList.add('panning');
    return;
  }
  // start a marquee. ⌘/Ctrl keeps the existing selection and adds to it.
  marquee = { sx:e.clientX, sy:e.clientY, add:e.metaKey||e.ctrlKey, base:new Set(state.sel), moved:false };
  drawMarquee(e.clientX, e.clientY);
  marqueeEl.style.display = 'block';
});
window.addEventListener('pointermove', (e) => {
  if (gPointers.has(e.pointerId)){
    gPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if (pinch && gPointers.size >= 2){
      const [a,b] = [...gPointers.values()];
      const nd = gDist(a,b), ncx = (a.x+b.x)/2, ncy = (a.y+b.y)/2;
      // stage is position:fixed; inset:0 so its origin is always (0,0) — no getBoundingClientRect needed
      if (pinch.dist > 0) zoomAt(ncx, ncy, nd / pinch.dist);
      state.view.x += ncx - pinch.cx;               // pan by the midpoint's movement
      state.view.y += ncy - pinch.cy;
      applyView();
      pinch.dist = nd; pinch.cx = ncx; pinch.cy = ncy;
      return;
    }
    // single finger falls through to the pan branch below
  }
  if (pan){
    state.view.x = pan.ox + (e.clientX - pan.sx);
    state.view.y = pan.oy + (e.clientY - pan.sy);
    applyView(); return;
  }
  if (marquee){
    if (Math.abs(e.clientX-marquee.sx) + Math.abs(e.clientY-marquee.sy) > 3) marquee.moved = true;
    drawMarquee(e.clientX, e.clientY);
    if (marquee.moved) selectWithinMarquee(e.clientX, e.clientY);
  }
});
function endGesturePointer(e){
  if (!gPointers.has(e.pointerId)) return false;
  gPointers.delete(e.pointerId);
  if (gPointers.size < 2) pinch = null;
  if (gPointers.size === 0){
    pan = null; stage.classList.remove('panning');
    // End marquee exactly like the mouse path does
    if (marquee){
      marqueeEl.style.display = 'none';
      if (!marquee.moved && !marquee.add) selectNode(null);   // tap on empty = deselect
      marquee = null;
    }
  }
  // gPointers.size === 1: one finger remains after pinch — don't start a new marquee mid-gesture
  return true;
}
window.addEventListener('pointerup', (e) => {
  if (endGesturePointer(e)) return;
  if (pan){ pan = null; stage.classList.remove('panning'); return; }
  if (marquee){
    marqueeEl.style.display = 'none';
    if (!marquee.moved && !marquee.add) selectNode(null);   // plain click on empty = deselect
    marquee = null;
  }
});
window.addEventListener('pointercancel', endGesturePointer);
function drawMarquee(cx, cy){
  const r = stage.getBoundingClientRect();
  marqueeEl.style.left   = (Math.min(marquee.sx, cx) - r.left) + 'px';
  marqueeEl.style.top    = (Math.min(marquee.sy, cy) - r.top)  + 'px';
  marqueeEl.style.width  = Math.abs(cx - marquee.sx) + 'px';
  marqueeEl.style.height = Math.abs(cy - marquee.sy) + 'px';
}
function selectWithinMarquee(cx, cy){
  const a = screenToWorld(Math.min(marquee.sx, cx), Math.min(marquee.sy, cy));
  const b = screenToWorld(Math.max(marquee.sx, cx), Math.max(marquee.sy, cy));
  const hits = [];
  for (const n of state.nodes.values()){
    if (isHidden(n)) continue;
    if (n.x < b.x && n.x + NODE_W > a.x && n.y < b.y && n.y + nodeH(n) > a.y) hits.push(n.id);
  }
  setSelectionSet(marquee.add ? new Set([...marquee.base, ...hits]) : hits);
}

// Trackpad on macOS delivers BOTH gestures as wheel events:
//  · pinch          → wheel with ctrlKey = true  → zoom toward the cursor
//  · two-finger pan → wheel with ctrlKey = false → pan by deltaX/deltaY
// (A mouse wheel also lands here with ctrlKey = false; we treat its vertical delta as zoom.)
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  cancelViewAnim();
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;

  if (e.ctrlKey){
    // pinch-zoom — deltaY is small & continuous; convert to a gentle factor
    zoomAt(mx, my, Math.exp(-e.deltaY * 0.01));
    return;
  }
  // a plain MOUSE wheel: deltaMode is "lines" (1) not "pixels" (0), or it's the classic
  // 100/120-px notch. Trackpad scroll is always pixel-mode with fractional deltas, so this
  // won't catch it — trackpad users zoom by pinching (handled above).
  const isMouseWheel = e.deltaX === 0 &&
    (e.deltaMode === 1 || Math.abs(e.deltaY) === 100 || Math.abs(e.deltaY) === 120);
  if (isMouseWheel){
    zoomAt(mx, my, e.deltaY < 0 ? 1.15 : 0.87);
    return;
  }
  // two-finger scroll → pan
  state.view.x -= e.deltaX;
  state.view.y -= e.deltaY;
  applyView();
}, { passive:false });

// Safari fires native gesture events for pinch instead of ctrl+wheel.
let gestureStartK = 1, gestureMid = {x:0,y:0};
stage.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  if (gPointers.size) return;   // touchscreen pinch is handled via pointer events instead
  gestureStartK = state.view.k;
  const r = stage.getBoundingClientRect();
  gestureMid = { x: e.clientX - r.left, y: e.clientY - r.top };
});
stage.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (gPointers.size) return;   // …so we don't double-apply zoom on iPad
  const k0 = state.view.k;
  const target = Math.min(2.5, Math.max(0.2, gestureStartK * e.scale));
  zoomAt(gestureMid.x, gestureMid.y, target / k0);
});
stage.addEventListener('gestureend', (e) => e.preventDefault());


// Focus a card: un-collapse hiding ancestors, select it, frame it + all its visible descendants.
export function focusNode(target){
  if (!target) return;
  let revealed = false;
  for (let p = target.parent && state.nodes.get(target.parent); p; p = p.parent && state.nodes.get(p.parent)){
    if (p.collapsed){ p.collapsed = false; p.dirtyLayout = true; revealed = true; }
  }
  selectNode(target.id);                       // paint first so heights are known / editor opens
  frameBox(subtreeIds(target.id).map(id => state.nodes.get(id)));
  if (revealed && store.isOpen) scheduleSave();
}
// Follow a [[wikilink]]: find the node by title (case-insensitive) and focus it.
function focusByTitle(title){
  const t = title.trim().toLowerCase();
  const target = [...state.nodes.values()].find(n => n.title.trim().toLowerCase() === t);
  if (!target){ setStatus(`No node titled “${title}” in this map`); return; }
  focusNode(target);
}
// The "focus" command (toolbar button + F): frame the selected card (+ its subtree), or
// frame the whole map when nothing is selected — both glide with the same easing.
function focusOrFit(){
  if (state.selId && state.nodes.has(state.selId)) focusNode(state.nodes.get(state.selId));
  else frameBox([...state.nodes.values()]);
}

// ---------- selection + editor ----------
// Selection and the edit panel are decoupled: a node can stay selected while the
// panel is closed (press Esc). That closed-but-selected state is when Delete works.
const editor = document.getElementById('editor');
const edName  = document.getElementById('edName');   // read-only node name at the top of the sidebar
const edTags  = document.getElementById('edTags');
const edLayoutTypes = document.getElementById('edLayoutTypes');
const edLayoutDirs  = document.getElementById('edLayoutDirs');
const edColors = document.getElementById('edColors');

// colour palette (keys match the .c-* CSS classes); 'grey' is the old neutral "none" look
const PALETTE = ['slate','red','amber','green','teal','blue','violet','pink','grey'];
const SWATCH_BG = { slate:'#4860c0', red:'#d62f48', amber:'#d18a1d', green:'#1ba85a',
  teal:'#129fb3', blue:'#2f7fe8', violet:'#7a42da', pink:'#d6368e', grey:'#2b3645' };
// build the swatch row once: inherit (default) + the palette colours + explicit "none".
// '' = inherit the nearest coloured ancestor (effectiveColor walks up); 'none' = no colour, terminal.
(function buildSwatches(){
  let html = `<div class="swatch inherit" data-color="" title="inherit colour from parent (default)"></div>`;
  for (const c of PALETTE)
    html += `<div class="swatch" data-color="${c}" title="${c}" style="--sw:${SWATCH_BG[c]}"></div>`;
  html += `<div class="swatch nofill" data-color="none" title="no colour — don’t inherit"></div>`;
  edColors.innerHTML = html;
  edColors.querySelectorAll('.swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      const ids = state.sel.size ? [...state.sel] : (state.selId ? [state.selId] : []);
      if (!ids.length) return;
      for (const id of ids){ const n = state.nodes.get(id); if (n){ n.color = sw.dataset.color; n.dirty = true; } }
      markActiveSwatch(sw.dataset.color);
      paintAll(); scheduleSave();
    });
  });
})();
function markActiveSwatch(color){
  edColors.querySelectorAll('.swatch').forEach(sw =>
    sw.classList.toggle('active', sw.dataset.color === (color || '')));
}

// ---------- layout pickers (icon chips, like the colour swatches) ----------
const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const DOT = (cx,cy,r=2.2) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;
const LAYOUT_TYPES = [
  { key:'none', label:'None — inherit layout & direction from the parent (default)',
    icon: SVG_OPEN + '<rect x="5" y="7" width="14" height="10" rx="2" stroke-dasharray="3 2.5"/></svg>' },
  { key:'free', label:'Free — children stay where you drag them',
    icon: SVG_OPEN + DOT(6,7) + DOT(17,8) + DOT(11,17) + '</svg>' },
  { key:'line', label:'Line — children chained along the direction',
    icon: SVG_OPEN + DOT(4,12) + '<path d="M6.5 12h3"/>' + DOT(12,12) + '<path d="M14.5 12h3"/>' + DOT(20,12) + '</svg>' },
  { key:'fan', label:'Fan — children spread out to one side',
    icon: SVG_OPEN + DOT(4,12) + '<path d="M6 12l6-6M6 12h6M6 12l6 6"/>' + DOT(14,6,1.8) + DOT(14,12,1.8) + DOT(14,18,1.8) + '</svg>' },
  { key:'two-sided', label:'Two-sided — children split to both ends of the direction’s axis, balanced (classic mind-map; best on a root)',
    icon: SVG_OPEN + DOT(12,12) + '<path d="M12 12l6-5M12 12l6 5M12 12l-6-5M12 12l-6 5"/>' + DOT(18,7,1.8) + DOT(18,17,1.8) + DOT(6,7,1.8) + DOT(6,17,1.8) + '</svg>' },
];
const LAYOUT_DIRS = [
  { key:'left',   label:'Left',   icon: SVG_OPEN + '<path d="M15 5l-7 7 7 7"/></svg>' },
  { key:'right',  label:'Right',  icon: SVG_OPEN + '<path d="M9 5l7 7-7 7"/></svg>' },
  { key:'top',    label:'Top',    icon: SVG_OPEN + '<path d="M5 15l7-7 7 7"/></svg>' },
  { key:'bottom', label:'Bottom', icon: SVG_OPEN + '<path d="M5 9l7 7 7-7"/></svg>' },
];
// the ids currently being edited (one or many) — layout applies to all of them
function selectedIds(){ return state.sel.size ? [...state.sel] : (state.selId ? [state.selId] : []); }
// build the two chip rows once
(function buildLayoutChips(){
  edLayoutTypes.innerHTML = LAYOUT_TYPES.map(t =>
    `<div class="layoutchip" data-type="${t.key}" title="${t.label}">${t.icon}</div>`).join('');
  edLayoutDirs.innerHTML = LAYOUT_DIRS.map(d =>
    `<div class="layoutchip" data-dir="${d.key}" title="${d.label}">${d.icon}</div>`).join('');
  edLayoutTypes.querySelectorAll('.layoutchip').forEach(c =>
    c.addEventListener('click', () => setLayout({ type: c.dataset.type })));
  edLayoutDirs.querySelectorAll('.layoutchip').forEach(c =>
    c.addEventListener('click', () => { if (!c.classList.contains('disabled')) setLayout({ dir: c.dataset.dir }); }));
})();
// apply a type and/or direction to every selected card, then re-snap their children
function setLayout({ type, dir }){
  const ids = selectedIds(); if (!ids.length) return;
  for (const id of ids){
    const n = state.nodes.get(id); if (!n) continue;
    if (type != null) n.layoutType = type;
    if (dir  != null) n.layoutDir  = dir;
    n.dirty = true;
  }
  markLayoutChips();
  applyLayouts(); paintAll(); scheduleSave();
}
// reflect the selection's current layout: a chip is active when ALL selected share that value
// (mixed → none active). Direction greys out when every selected card is Free or None (None
// inherits its direction from the parent, Free ignores it).
function markLayoutChips(){
  const ids = selectedIds();
  const types = new Set(ids.map(id => state.nodes.get(id)?.layoutType || 'none'));
  const dirs  = new Set(ids.map(id => state.nodes.get(id)?.layoutDir  || 'right'));
  const t = types.size === 1 ? [...types][0] : null;
  const d = dirs.size  === 1 ? [...dirs][0]  : null;
  const dirDisabled = t === 'free' || t === 'none';   // two-sided keeps dir: it picks the axis
  edLayoutTypes.querySelectorAll('.layoutchip').forEach(c =>
    c.classList.toggle('active', c.dataset.type === t));
  edLayoutDirs.querySelectorAll('.layoutchip').forEach(c => {
    c.classList.toggle('disabled', dirDisabled);
    c.classList.toggle('active', !dirDisabled && c.dataset.dir === d);
  });
}

function openEditor(n){
  editor.classList.remove('multi');
  edName.textContent = n.title;             // name is read-only here — rename on the canvas
  edTags.value = n.tags.join(', ');
  markActiveSwatch(n.color);
  markLayoutChips();
  editor.classList.add('has-selection');   // show fields instead of the empty hint
}
// many nodes selected → show just the colour picker + a count; swatches recolour all of them
function openMultiEditor(){
  const ids = [...state.sel];
  document.getElementById('edMulti').textContent =
    `${ids.length} cards selected — colour & layout apply to all`;
  const colors = new Set(ids.map(id => state.nodes.get(id)?.color || ''));
  markActiveSwatch(colors.size === 1 ? [...colors][0] : ' ');  // none active when mixed
  markLayoutChips();
  editor.classList.add('has-selection', 'multi');
}
// no node selected → keep the sidebar open but show the empty hint
function showEmptyEditor(){ editor.classList.remove('has-selection', 'multi'); }
// reflect state.sel in the canvas + the editor panel
function applySelection(){ paintAll(); updateEditor(); updateNodeActions(); applySidebar(); }

// Enable/disable the toolbar's selected-card actions to match the current selection & mode.
function updateNodeActions(){
  const one = !!state.selId && !state.readOnly;   // single-target actions
  const any = state.sel.size > 0 && !state.readOnly;
  const set = (id, on) => { const b = document.getElementById(id); if (b) b.disabled = !on; };
  set('edRename', one); set('edDuplicate', one);
  set('edDelete', any);
}
function updateEditor(){
  const n = state.sel.size;
  if (n === 0) showEmptyEditor();
  else if (n === 1) openEditor(state.nodes.get(state.selId));
  else openMultiEditor();
}
// Replace the whole selection with `ids` (a Set or array), recomputing the primary.
function setSelectionSet(ids){
  state.sel = new Set(ids);
  if (state.sel.size === 0) state.selId = null;
  else if (state.sel.size === 1) state.selId = [...state.sel][0];
  else if (!state.selId || !state.sel.has(state.selId)) state.selId = [...state.sel].pop();
  applySelection();
}
// ⌘/Ctrl-click: add or remove one card from the selection.
function toggleSel(id){
  if (state.sel.has(id)){
    state.sel.delete(id);
    if (state.selId === id) state.selId = state.sel.size ? [...state.sel].pop() : null;
  } else {
    state.sel.add(id); state.selId = id;
  }
  applySelection();
}

// The floating edit panel only appears when it's actually needed — i.e. something is
// selected (and not in read-only). The toolbar button toggles the user's preference.
function applySidebar(){
  const wanted = state.sidebarOpen && !state.readOnly;   // user pref, ignoring selection
  const open = wanted && state.sel.size > 0;             // only show when there's a selection
  editor.classList.toggle('open', open);
}
applySidebar();

// ---------- read-only mode ----------
// View & collapse only: nothing saves, the sidebar hides, editing icons grey out, and the
// add-child + is hidden. Collapsing is allowed but in-memory only — leaving read-only reloads
// from disk so the saved collapse state is restored.
const roBtn = document.getElementById('roBtn');
// closed padlock (locked) vs open padlock (unlocked)
const ICON_LOCK_CLOSED = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
const ICON_LOCK_OPEN   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>`;
export function applyReadOnly(){
  const ro = state.readOnly;
  document.body.classList.toggle('readonly', ro);
  roBtn.classList.toggle('locked', ro);          // red when locked
  roBtn.innerHTML = ro ? ICON_LOCK_CLOSED : ICON_LOCK_OPEN;
  roBtn.title = ro ? 'Read-only — click to unlock & edit (R)' : 'Lock to read-only (R) — view & collapse only';
  document.getElementById('fabAdd').disabled = ro;
  applySidebar();
  setStatus(ro ? 'Read-only — nothing is saved' : 'Editing enabled');
}
applyReadOnly();   // set the initial open-padlock icon
async function setReadOnly(on){
  if (on === state.readOnly) return;
  if (on){
    clearTimeout(saveTimer);
    await flushSave();                                   // persist anything pending before locking
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
export function selectNode(id, _openPanel = true) {
  if (id == null){ state.sel.clear(); state.selId = null; }
  else { state.sel = new Set([id]); state.selId = id; }
  applySelection();
}
// Why a title is invalid (empty or already used by another node), else '' (ok).
// Filenames collide case-insensitively on macOS/Windows, so compare lowercased.
function titleProblem(title, selfId){
  const t = title.trim();
  if (!t) return 'Title can’t be empty';
  const lc = t.toLowerCase();
  for (const o of state.nodes.values()){
    if (o.id !== selfId && o.title.trim().toLowerCase() === lc)
      return 'A node with this title already exists';
  }
  return '';
}
// Tags / colour apply live from the sidebar. The TITLE and BODY are edited on the canvas
// (F2 / slow-click → inline edit), so the sidebar only handles tags, colour, and layout.
function applyRest(){
  const n = state.nodes.get(state.selId); if (!n) return;
  n.tags = edTags.value.split(',').map(s=>s.trim()).filter(Boolean);
  n.dirty = true;
  // paint first so the card's height is up to date, then reflow: a taller/shorter card pushes
  // its siblings (and its own children) under any non-free parent. Order is untouched.
  paintAll(); applyLayouts(); paintAll(); scheduleSave();
}
edTags.addEventListener('input', applyRest);
// (layout is set via the icon chips above — see setLayout / buildLayoutChips)

// ---------- extract selected body text into a new child card ----------
// Triggered with ⌘⇧E while editing a card's body in place: cut the selected text out of the
// note and drop it into a fresh child card.
function extractToChild(){
  if (state.readOnly || !bodyEdit) return;
  const n = state.nodes.get(bodyEdit.id); if (!n) return;
  const ta = bodyEdit.ta;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e){ setStatus('Select some body text to extract'); return; }
  const sel = ta.value.slice(s, e);
  const lines = sel.split('\n');
  let ti = lines.findIndex(l => l.trim()); if (ti < 0) ti = 0;
  const title = uniqueTitle(
    lines[ti].replace(/^\s*(#{1,6}|[-*+]|>|\d+\.)\s*/, '').trim() || 'New Node');
  const childBody = lines.slice(ti+1).join('\n').trim();
  // cut the selection out of the parent (tidy up the blank lines it leaves) and close its editor
  n.body = (ta.value.slice(0, s) + ta.value.slice(e)).replace(/\n{3,}/g, '\n\n').trim();
  n.dirty = true;
  bodyEdit = null; bodyEditing = false; bodyEditId = null;   // commit & drop the in-card editor
  // make the child below the parent and jump to it
  const sibs = childrenOf(n.id);
  if (n.collapsed) n.collapsed = false;
  const id = 'n' + (state.idSeq++);
  const child = {
    id, file:null, x: n.x + 40 + sibs.length*30, y: n.y + 180 + sibs.length*10,
    parent: n.id, collapsed:false, title, color:'', keepStatus:'', tags:[], body: childBody,
    layoutType:'none', layoutDir:'right',
    dirty:true, dirtyLayout:true,
  };
  state.nodes.set(id, child);
  applyLayouts(); paintAll(); selectNode(id); scheduleSave();
  setStatus(`Extracted “${title}” as a child`);
}

// ---------- image attachments ----------
// Images are real files in the vault's attachments/ folder; the note just gets ![alt](attachments/…).
// Added by pasting, by dropping a file on a card (or the body editor), or by typing the markdown.
const IMG_EXT = { 'image/png':'.png', 'image/jpeg':'.jpg', 'image/gif':'.gif', 'image/webp':'.webp',
                  'image/svg+xml':'.svg', 'image/avif':'.avif', 'image/bmp':'.bmp' };
function imgExt(file){
  const m = (file.name || '').match(/\.[a-z0-9]+$/i);
  return m ? m[0].toLowerCase() : (IMG_EXT[file.type] || '.png');
}
const isImageFile = f => f && f.type && f.type.startsWith('image/');
const dragHasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
// Write one image file into attachments/ under a collision-proof name; return its vault path.
async function storeImage(file){
  const name = 'img-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + imgExt(file);
  const path = 'attachments/' + name;
  await store.write(path, file);          // a Blob writes straight through createWritable
  state.lastSelfWrite = Date.now();        // our own write — don't let focus-reload react to it
  return path;
}
// Store each image, returning the markdown that references them (one per line).
async function markdownForImages(files){
  const out = [];
  for (const f of files){
    const path = await storeImage(f);
    const alt = (f.name || 'image').replace(/\.[^.]*$/, '') || 'image';
    out.push(`![${alt}](${path})`);
  }
  return out.join('\n');
}
function canAttach(){
  if (state.readOnly){ setStatus('Read-only — can’t add images'); return false; }
  if (!store.isOpen){ setStatus('Open a folder to add images'); return false; }
  return true;
}
// Append images to the end of a card's body (used by drops onto a card).
async function appendImagesToNode(id, files){
  const imgs = [...files].filter(isImageFile);
  if (!imgs.length || !canAttach()) return;
  const n = state.nodes.get(id); if (!n) return;
  setStatus('Adding image…');
  const md = await markdownForImages(imgs);
  n.body = (n.body && n.body.trim()) ? n.body.replace(/\s*$/, '') + '\n\n' + md : md;
  n.dirty = true;
  if (bodyEdit && bodyEdit.id === id) bodyEdit.ta.value = n.body;   // sync an open in-card editor
  paintAll(); applyLayouts(); paintAll(); scheduleSave();
  setStatus(`Added ${imgs.length} image${imgs.length === 1 ? '' : 's'}`);
}
// Insert images at the caret in the in-card body editor (used by paste / drop onto it).
async function insertImagesAtCursor(files){
  const imgs = [...files].filter(isImageFile);
  if (!imgs.length || !canAttach()) return;
  if (!bodyEdit){ return; }                          // only meaningful while editing a body in place
  const n = state.nodes.get(bodyEdit.id); if (!n) return;
  const ta = bodyEdit.ta;
  setStatus('Adding image…');
  const md = await markdownForImages(imgs);
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const ins = (s > 0 && v[s-1] !== '\n' ? '\n' : '') + md + '\n';
  ta.value = v.slice(0, s) + ins + v.slice(e);
  ta.selectionStart = ta.selectionEnd = s + ins.length;
  autosizeBody(ta);
  n.body = ta.value; n.dirty = true;
  applyLayouts(); paintAll(); scheduleSave();        // reflow; the editing textarea is preserved
  setStatus(`Added ${imgs.length} image${imgs.length === 1 ? '' : 's'}`);
}

// Paste an image straight into the in-card body editor (bound per-textarea in startBodyEdit).
function onBodyPaste(e){
  const imgs = [...(e.clipboardData?.files || [])].filter(isImageFile);
  if (imgs.length){ e.preventDefault(); insertImagesAtCursor(imgs); }
}

// Drag an image file from the OS onto a card (or the body editor). We handle this at the document
// level so we can both highlight the target and stop the browser from navigating to the dropped file.
let imgDropTarget = null;   // the element currently showing the .img-drop hint
function setImgDropTarget(el){
  if (imgDropTarget === el) return;
  imgDropTarget?.classList.remove('img-drop');
  imgDropTarget = el;
  imgDropTarget?.classList.add('img-drop');
}
document.addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  if (state.readOnly){ setImgDropTarget(null); return; }
  setImgDropTarget(e.target.closest?.('.body-edit') || e.target.closest?.('#world [data-id]') || null);
});
document.addEventListener('dragleave', (e) => { if (e.relatedTarget == null) setImgDropTarget(null); });
document.addEventListener('drop', async (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  const onEditor = !!e.target.closest?.('.body-edit');
  const cardEl   = e.target.closest?.('#world [data-id]');
  setImgDropTarget(null);
  const imgs = [...e.dataTransfer.files].filter(isImageFile);
  if (!imgs.length) return;
  if (onEditor && bodyEdit){ await insertImagesAtCursor(imgs); }   // drop on the open editor → at the caret
  else if (cardEl){ selectNode(cardEl.dataset.id); await appendImagesToNode(cardEl.dataset.id, imgs); }
  else if (state.selId){ await appendImagesToNode(state.selId, imgs); }
  else setStatus('Drop an image onto a card to attach it');
});
// While a title is being renamed (inline, on the canvas) we DON'T rename the file on every
// keystroke (that would litter the folder with M.md, Ma.md, Mag.md…) — the save loop defers the
// file rename until editing ends. These flags are set/cleared by startInlineEdit / endInlineEdit.
export let titleEditing = false;
let titleEditId = null;

// ---------- inline title rename (edit the title on the card itself) ----------
// Entered via slow-click (a second click on the already-selected card), F2, or automatically
// when a node is created. Reuses titleEditing/titleEditId so the save loop still defers the file
// rename until editing ends (no M.md, Ma.md… litter).
function startInlineEdit(n, { isNew = false } = {}){
  if (state.readOnly || !n || !n.el) return;
  if (inlineEdit) endInlineEdit();                              // close any other open editor first
  if (state.selId !== n.id || state.sel.size !== 1) selectNode(n.id);
  const titleEl = n.el.querySelector('.title');
  // `isNew` marks a just-created card: Escape then cancels the whole creation (deletes it),
  // rather than just reverting the rename the way it does for an existing card.
  inlineEdit = { id:n.id, orig:n.title, el:titleEl, isNew };
  titleEditing = true; titleEditId = n.id;
  titleEl.setAttribute('contenteditable', 'plaintext-only');
  titleEl.classList.add('editing'); titleEl.classList.remove('invalid');
  titleEl.focus();
  const r = document.createRange(); r.selectNodeContents(titleEl);     // select-all so typing replaces
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
// Live: validate + reflow as the user types. We never touch n.title here (layout uses the live DOM
// height, not the stored title), so a half-typed invalid title can't corrupt anything.
function onInlineInput(n){
  if (!inlineEdit || inlineEdit.id !== n.id) return;
  const val = inlineEdit.el.textContent;
  const problem = titleProblem(val, n.id);
  inlineEdit.el.classList.toggle('invalid', !!problem);
  edName.textContent = val;     // mirror the live name into the sidebar's read-only header
  applyLayouts(); paintAll();   // a taller/shorter title reflows siblings (title text stays, guarded)
}
function onInlineKeydown(e, n){
  if (!inlineEdit || inlineEdit.id !== n.id) return;
  if (e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); e.stopPropagation(); endInlineEdit(); }
  else if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); endInlineEdit({ cancel:true }); }
  // ↓ from the title drops straight into editing the body (handy right after creating a card)
  else if (e.key === 'ArrowDown'){ e.preventDefault(); e.stopPropagation(); endInlineEdit(); startBodyEdit(n, { atStart:true }); }
}
// Commit (or cancel) the rename: keep the typed title if valid, else fall back to the node's
// current (last-valid) title. Restores canonical text, then reflows + saves.
function endInlineEdit({ cancel = false } = {}){
  const ie = inlineEdit; if (!ie) return;
  inlineEdit = null;                                  // null first → the blur handler becomes a no-op
  const n = state.nodes.get(ie.id);
  ie.el.removeAttribute('contenteditable');
  ie.el.classList.remove('editing', 'invalid');
  ie.el.blur();                                       // ensure keyboard closes on iOS when ended by keypress
  titleEditing = false; titleEditId = null;
  if (!n) return;
  if (cancel && ie.isNew){                            // Esc on a freshly-created card = cancel creation
    deleteNode(n.id);
    setStatus('Cancelled new card');
    return;
  }
  const val = ie.el.textContent.replace(/[\r\n]+/g, ' ').trim();   // titles map to filenames — no newlines
  if (!cancel && !titleProblem(val, n.id)) n.title = val;
  ie.el.textContent = n.title;                        // restore the canonical text
  n.dirty = true;
  edName.textContent = n.title;                       // keep the sidebar header in sync
  paintAll(); applyLayouts(); paintAll();             // title may have changed height → reflow
  scheduleSave();
}

// ---------- inline body edit (edit a card's note on the card itself) ----------
// Entered via slow-click on the body, or ↓ from the title editor. Shows the RAW markdown in a
// textarea inside .body; Enter inserts a newline, Esc cancels (restores the original), blur commits.
// `bodyEditing`/`bodyEditId` mirror the title guards so the save loop / disk-reload behave the same.
let bodyEdit = null;       // { id, orig, el, ta } while a card body is being edited in place
export let bodyEditing = false;
let bodyEditId = null;
function autosizeBody(ta){ ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
function startBodyEdit(n, { atStart = false } = {}){
  if (state.readOnly || !n || !n.el) return;
  if (bodyEdit && bodyEdit.id === n.id) return;                 // already editing this body
  if (inlineEdit) endInlineEdit();                             // close a title editor first
  if (bodyEdit) endBodyEdit();                                 // close any other open body editor
  if (state.selId !== n.id || state.sel.size !== 1) selectNode(n.id);
  const bodyEl = n.el.querySelector('.body');
  const ta = document.createElement('textarea');
  ta.className = 'body-edit'; ta.spellcheck = false; ta.value = n.body;
  bodyEdit = { id:n.id, orig:n.body, el:bodyEl, ta };
  bodyEditing = true; bodyEditId = n.id;
  n.el.classList.remove('no-body');                            // give the body slot room while editing
  bodyEl.innerHTML = ''; bodyEl.appendChild(ta);
  bodyEl.classList.add('editing');
  // typing: keep the textarea sized to its content and reflow siblings as the card grows/shrinks
  ta.addEventListener('input', () => { autosizeBody(ta); onBodyInput(n); });
  ta.addEventListener('keydown', (e) => onBodyKeydown(e, n));
  ta.addEventListener('blur',    () => { if (bodyEdit && bodyEdit.id === n.id) endBodyEdit(); });
  ta.addEventListener('paste',   onBodyPaste);                 // paste images straight into the note
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());   // place the caret, don't drag the card
  ta.focus();
  autosizeBody(ta);              // size to content first so the card's real height is known…
  applyLayouts(); paintAll();    // …then reflow siblings around it (not just after a newline)
  const pos = atStart ? 0 : ta.value.length;
  ta.setSelectionRange(pos, pos);
}
// Live: reflow as the user types. n.body isn't touched here (layout uses the live DOM height),
// so an in-progress edit can't corrupt anything — the textarea content is preserved by paintNode.
function onBodyInput(n){
  if (!bodyEdit || bodyEdit.id !== n.id) return;
  applyLayouts(); paintAll();
}
function onBodyKeydown(e, n){
  if (!bodyEdit || bodyEdit.id !== n.id) return;
  e.stopPropagation();                                  // keep canvas/card shortcuts out while typing
  if (e.key === 'Escape'){ e.preventDefault(); endBodyEdit({ cancel:true }); }
  else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter'){ e.preventDefault(); endBodyEdit(); }
  else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'e' || e.key === 'E')){ e.preventDefault(); extractToChild(); }
  // plain Enter falls through → the textarea inserts a newline (notes are multi-line)
}
// Commit (or cancel) the body edit. Commit stores the textarea text; cancel leaves n.body untouched
// (its original). Either way we drop the textarea and re-render + reflow from n.body.
function endBodyEdit({ cancel = false } = {}){
  const be = bodyEdit; if (!be) return;
  bodyEdit = null;                                      // null first → the blur handler becomes a no-op
  bodyEditing = false; bodyEditId = null;
  be.ta.blur();                                         // ensure keyboard closes on iOS when ended by keypress
  const n = state.nodes.get(be.id);
  be.el.classList.remove('editing');
  if (n && !cancel && be.ta.value !== be.orig){ n.body = be.ta.value; n.dirty = true; }
  paintAll(); applyLayouts(); paintAll();               // re-render the body and reflow the height change
  if (n && !cancel && be.ta.value !== be.orig) scheduleSave();
}

// Forget a set of node ids: drop them from state, remove their DOM cards, and queue
// their files for deletion on the next save. Callers pass the full subtree(s) to remove.
function deleteNodes(ids){
  for (const id of ids){
    const n = state.nodes.get(id); if (!n) continue;
    state.nodes.delete(id); n.el?.remove();
    if (n.file) state.toDelete.push(n.file);
  }
}
function deleteNode(id) {
  if (state.readOnly) return;
  if (!state.nodes.has(id)) return;
  deleteNodes(subtreeIds(id));
  applyLayouts(); selectNode(null); paintAll();
  scheduleSave();
}
// Delete every selected card and their entire subtrees.
function deleteSelection() {
  if (state.readOnly) return;
  const ids = [...state.sel];
  if (!ids.length) return;
  state.sel.clear(); state.selId = null;
  deleteNodes(new Set(ids.flatMap(id => subtreeIds(id))));   // dedup overlapping subtrees
  applyLayouts(); applySelection(); scheduleSave();
  setStatus(`Deleted ${ids.length} card${ids.length===1?'':'s'}`);
}

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

  const typing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)
    || !!document.activeElement?.isContentEditable;
  // Esc blurs the active field (so Delete works next), or deselects when not typing.
  if (e.key === 'Escape'){
    e.preventDefault();
    if (typing) { document.activeElement?.blur?.(); }
    else if (state.sel.size) selectNode(null);
    return;
  }
  if (typing) return;
  if (e.key === 'r' || e.key === 'R'){ e.preventDefault(); setReadOnly(!state.readOnly); return; }
  if (e.key === '/'){ e.preventDefault(); searchBox.focus(); searchBox.select(); return; }   // find a card
  // Space = hand-tool to pan while held; a quick tap (released without panning) makes a node.
  if (e.key === ' '){ e.preventDefault(); if (!e.repeat){ spaceHeld = true; spaceUsedForPan = false; } return; }
  if (e.key === 'f' || e.key === 'F'){ e.preventDefault(); focusOrFit(); return; }
  if ((e.key === 'd' || e.key === 'D') && state.sel.size){ e.preventDefault(); duplicateSelection(); return; }
  if (e.key === 'F2' && state.selId){ e.preventDefault(); startInlineEdit(state.nodes.get(state.selId)); return; }
  if (e.key === 'Enter' && state.selId){ e.preventDefault(); createSibling(state.selId); return; }
  if (e.key === 'Tab' && state.selId){ e.preventDefault(); addChild(state.selId); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel.size){
    e.preventDefault(); deleteSelection();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key !== ' ') return;
  const wasPan = spaceUsedForPan;
  spaceHeld = false; spaceUsedForPan = false;
  const typing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)
    || !!document.activeElement?.isContentEditable;
  if (!typing && !wasPan && !pan && state.sel.size === 0) createNode();   // tap = new node
});

// ---------- create / duplicate nodes ----------
// Make a new UNCONNECTED node (parent:null) at the viewport centre (or a given spot).
function createNode(opts = {}) {
  if (state.readOnly) return;
  const id = 'n' + (state.idSeq++);
  const c = screenToWorld(window.innerWidth/2, window.innerHeight/2);
  const n = {
    id, file:null,
    x: opts.x ?? (c.x - 100), y: opts.y ?? (c.y - 40),
    parent: opts.parent ?? null, collapsed:false,
    title: opts.title ?? uniqueTitle('New Node'),  // avoid colliding with an existing "New Node"
    color: opts.color ?? '', keepStatus:'',
    tags: opts.tags ? [...opts.tags] : [], body: opts.body ?? '',
    layoutType: opts.layoutType ?? 'none', layoutDir: opts.layoutDir ?? 'right',
    dirty:true, dirtyLayout:true,
  };
  state.nodes.set(id, n);
  applyLayouts(); paintAll(); selectNode(id); startInlineEdit(n, { isNew: opts.isNew ?? true });
  scheduleSave();
  return n;
}
// Pick a title not already in use. "Tether Gun" -> "Tether Gun copy" -> "Tether Gun copy 2"…
// For brand-new nodes, "New Node" -> "New Node 2" -> "New Node 3"…
function uniqueTitle(base, { copy = false } = {}) {
  const taken = new Set([...state.nodes.values()].map(n => n.title.trim().toLowerCase()));
  let cand = copy ? `${base} copy` : base;
  if (!taken.has(cand.toLowerCase())) return cand;
  let i = 2;
  while (taken.has((copy ? `${base} copy ${i}` : `${base} ${i}`).toLowerCase())) i++;
  return copy ? `${base} copy ${i}` : `${base} ${i}`;
}
// Make a connected copy of one node: same content/colour, placed just below the original and
// keeping its parent, so the duplicate stays attached as a sibling. Gets a unique "… copy"
// title so its file is valid. Doesn't touch selection/layout — callers batch those once.
function copyNode(s) {
  const id = 'n' + (state.idSeq++);
  const copy = {
    id, file:null,
    x: s.x, y: s.y + nodeH(s) + 24,   // directly below the original, clear of it
    parent: s.parent, collapsed:false,    // connected to the same parent as the original
    title: uniqueTitle(s.title, { copy: true }),
    color: s.color, keepStatus:'',
    tags: [...s.tags], body: s.body,
    layoutType: s.layoutType || 'none', layoutDir: s.layoutDir || 'right',
    dirty:true, dirtyLayout:true,
  };
  state.nodes.set(id, copy);
  return copy;
}
// Duplicate every selected card (or just the one). Each copy keeps its source's parent, so it
// stays connected. One card → open its rename like a fresh node; many → select the new copies.
function duplicateSelection() {
  if (state.readOnly) return;
  const ids = state.sel.size ? [...state.sel] : (state.selId ? [state.selId] : []);
  const srcs = ids.map(id => state.nodes.get(id)).filter(Boolean);
  if (!srcs.length) return;
  const copies = srcs.map(copyNode);
  // paint first so the new cards get real DOM heights — applyLayouts measures offsetHeight,
  // and a chain/fan of fresh copies would otherwise stack on the 64px fallback (only the first
  // lands right). Then lay out with correct heights and commit.
  paintAll(); applyLayouts(); paintAll();
  if (copies.length === 1){
    selectNode(copies[0].id);
    startInlineEdit(copies[0], { isNew: false });
    setStatus(`Duplicated → “${copies[0].title}”`);
  } else {
    setSelectionSet(copies.map(c => c.id));
    setStatus(`Duplicated ${copies.length} cards`);
  }
  scheduleSave();
  return copies;
}
// Shift+drag clone: drop a copy at `pos` that keeps the source's parent (a sibling),
// while the original is the node being dragged away. Doesn't steal selection/focus.
function leaveClone(s, pos) {
  const id = 'n' + (state.idSeq++);
  const title = uniqueTitle(s.title, { copy: true });
  const copy = {
    id, file:null,
    x: pos.x, y: pos.y,
    parent: s.parent, collapsed:false,
    title, color: s.color, keepStatus:'',
    tags: [...s.tags], body: s.body,
    layoutType: s.layoutType || 'none', layoutDir: s.layoutDir || 'right',
    dirty:true, dirtyLayout:true,
  };
  state.nodes.set(id, copy);
  setStatus(`Cloned → “${title}”`);
  return copy;
}

document.getElementById('fabAdd').onclick = () => createNode();
document.getElementById('fitBtn').onclick = focusOrFit;
document.getElementById('edgeBtn').onclick = cycleEdgeStyle;
document.getElementById('homeBtn').onclick = showStart;   // icon + folder name → home screen

// ---- edit-panel action buttons: on-screen equivalents of the keyboard shortcuts,
// so every editing action is reachable on a touch device with no keyboard ----
document.getElementById('edRename').onclick = () => { if (state.selId) startInlineEdit(state.nodes.get(state.selId)); };
document.getElementById('edDuplicate').onclick = () => duplicateSelection();
document.getElementById('edDelete').onclick = () => { if (state.sel.size) deleteSelection(); };


// keyboard shortcuts: ⌘S force-save  (duplicate = D, new node = Space — see plain-key handler)
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); flushSave(); }
});


boot();   // local-first: open straight into the last map
