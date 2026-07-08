// ---------- floating selection bar ----------
// Replaces the old #editor right-hand sidebar: a compact row of icon buttons anchored right
// next to the selected card (Miro/Figma-style), instead of a persistent docked panel. Colour
// and layout each collapse to one trigger button that opens a small popover with the full
// picker (the same #edColors/#edLayoutTypes markup the old sidebar used); checklist/group-bg
// are icon toggles; a trailing kebab button replaces the old always-visible action row via the
// existing generic context menu (openMenu, features/context-menu.ts).
// On narrow/touch widths (NARROW_MQ) styles.css docks the bar to the bottom edge instead —
// this module skips the floating position math there and lets CSS own it.
import { state, stage, type MindNode, type LayoutType, type FrameArrange } from '../core/state.js';
import { NARROW_MQ, ui } from '../core/ui-state.js';
import { record } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { applyLayouts, subtreeBox } from '../view/layout.js';
import { outlineActive } from './outline.js';
import { createProperties, type PropertyControls } from './properties.js';
import { startInlineEdit, startBodyEdit } from './inline-edit.js';
import { duplicateSelection, deleteSelection } from './crud.js';
import { exportSelection } from './clipboard.js';
import { openMenu, type MenuEntry } from './context-menu.js';
import { childrenOf, isHidden } from '../utils/model.js';
import { paintAll, selectedIds, GRID_SNAP, FRAME_W, FRAME_H, MIN_FRAME_W, MIN_FRAME_H } from '../main.js';

function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }

const bar = byId('floatBar');
const fbColor = byId<HTMLButtonElement>('fbColor');
const fbLayout = byId<HTMLButtonElement>('fbLayout');
const fbChecklist = byId<HTMLInputElement>('fbChecklist');
const fbBg = byId<HTMLInputElement>('fbBg');
const fbMore = byId<HTMLButtonElement>('fbMore');
const colorPop = byId('fbColorPop');
const layoutPop = byId('fbLayoutPop');
const popConnector = byId('fbPopConnector');
const edColors = byId('edColors');
const edLayoutTypes = byId('edLayoutTypes');

// colour / checklist / group-bg share the SAME control wiring the sidebar (and the outline's
// branch-editor sheet) used — see features/properties.ts. Tags are omitted: no room in the bar.
// Deferred to first use (like branch-editor.ts's own instance): createProperties() eagerly builds
// the swatch row from main.js's PALETTE/SWATCH_BG, which aren't initialized yet while this module
// is still being imported at main.ts's top — see the main↔features import cycle note in CLAUDE.md.
let _props: PropertyControls | null = null;
function props(): PropertyControls {
  return _props ??= createProperties({ colors: edColors, checklist: fbChecklist, bg: fbBg }, selectedIds);
}

// ---------- layout picker ----------
// Moved here from main.ts now that the layout chips live in this bar's popover rather than the
// old sidebar; still purely canvas geometry, just owned by the editor surface instead of the
// render core.
const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const DOT = (cx: number, cy: number, r = 2.2) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;
const LAYOUT_TYPES: { key: LayoutType; label: string; icon: string }[] = [
  { key:'none', label:'None — inherit layout from the parent (default)',
    icon: SVG_OPEN + '<rect x="5" y="7" width="14" height="10" rx="2" stroke-dasharray="3 2.5"/></svg>' },
  { key:'free', label:'Free — children stay where you drag them',
    icon: SVG_OPEN + DOT(6,7) + DOT(17,8) + DOT(11,17) + '</svg>' },
  { key:'line', label:'Line — children chained one after another, each on whichever side it sits on',
    icon: SVG_OPEN + DOT(4,12) + '<path d="M6.5 12h3"/>' + DOT(12,12) + '<path d="M14.5 12h3"/>' + DOT(20,12) + '</svg>' },
  { key:'fan', label:'Fan — children spread out, each to whichever side it’s placed on',
    icon: SVG_OPEN + DOT(4,12) + '<path d="M6 12l6-6M6 12h6M6 12l6 6"/>' + DOT(14,6,1.8) + DOT(14,12,1.8) + DOT(14,18,1.8) + '</svg>' },
  { key:'frame', label:'Frame — a resizable box; drag cards inside to hold them, out to release',
    icon: SVG_OPEN + '<rect x="3.5" y="5" width="17" height="14" rx="2"/><rect x="6.5" y="8.5" width="6" height="4.5" rx="1" fill="currentColor" stroke="none"/></svg>' },
];
// How a FRAME arranges its children — a second chip row shown only when the selection is a frame.
const ARRANGE_TYPES: { key: FrameArrange; label: string; icon: string }[] = [
  { key:'free', label:'Free — arrange cards inside the frame yourself',
    icon: SVG_OPEN + DOT(7,8) + DOT(16,9) + DOT(10,16) + '</svg>' },
  { key:'flow-h', label:'Flow → — fill rows left to right, wrap down',
    icon: SVG_OPEN + '<rect x="4" y="5" width="6" height="5" rx="1"/><rect x="13" y="5" width="7" height="5" rx="1"/><rect x="4" y="14" width="7" height="5" rx="1"/><path d="M20.5 7.5h.01" stroke-dasharray="0.1 3"/></svg>' },
  { key:'flow-v', label:'Flow ↓ — fill columns top to bottom, wrap right',
    icon: SVG_OPEN + '<rect x="5" y="4" width="5" height="6" rx="1"/><rect x="5" y="13" width="5" height="7" rx="1"/><rect x="14" y="4" width="5" height="7" rx="1"/></svg>' },
];
// Fit a frame's box snugly around its children: a title strip on top, a margin on the other sides,
// snapped to the grid and clamped to the min size. Children keep their positions (the box moves to
// enclose them). With no children it's left as-is, or given the default size when `orDefault` (used
// when a card first becomes a frame). Shared by the frame chip and the Auto-size action.
const FRAME_FIT_PAD = 16, FRAME_FIT_TITLE = 36;   // side/bottom margin; top strip for the title
function fitFrameToContent(n: MindNode, orDefault = false): void {
  const kids = childrenOf(n.id).filter(k => !isHidden(k));
  const snap = (v: number): number => Math.round(v / GRID_SNAP) * GRID_SNAP;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of kids) {
    const b = subtreeBox(k); if (!isFinite(b.x0)) continue;
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  if (!isFinite(x0)) { if (orDefault) { n.w = FRAME_W; n.h = FRAME_H; } return; }
  n.x = snap(x0 - FRAME_FIT_PAD);
  n.y = snap(y0 - FRAME_FIT_TITLE);
  n.w = Math.max(MIN_FRAME_W, snap(x1 + FRAME_FIT_PAD - n.x));
  n.h = Math.max(MIN_FRAME_H, snap(y1 + FRAME_FIT_PAD - n.y));
}
// Auto-size every selected frame to fit its content (shortcut / context menu).
export function autoSizeSelection(): void {
  const ids = selectedIds().filter(id => state.nodes.get(id)?.layoutType === 'frame');
  if (!ids.length) return;
  record(ids, () => { for (const id of ids){ const n = state.nodes.get(id); if (n) { fitFrameToContent(n); n.dirty = true; } } });
  applyLayouts(); paintAll(); scheduleSave();
}
// The frame-arrange chips live in a second row of the same popover, shown only for a frame selection.
const edArrangeTypes = document.createElement('div');
edArrangeTypes.className = 'layoutchips arrangechips';
layoutPop.appendChild(edArrangeTypes);
(function buildLayoutChips(){
  edLayoutTypes.innerHTML = LAYOUT_TYPES.map(t =>
    `<div class="layoutchip" data-type="${t.key}" title="${t.label}">${t.icon}</div>`).join('');
  edLayoutTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.addEventListener('click', () => { setLayout(c.dataset.type as LayoutType); closePopovers(); }));
  edArrangeTypes.innerHTML = ARRANGE_TYPES.map(t =>
    `<div class="layoutchip" data-arrange="${t.key}" title="${t.label}">${t.icon}</div>`).join('');
  edArrangeTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.addEventListener('click', () => { setArrange(c.dataset.arrange as FrameArrange); closePopovers(); }));
})();
function setLayout(type: LayoutType): void {
  const ids = selectedIds(); if (!ids.length) return;
  record(ids, () => {
    for (const id of ids){
      const n = state.nodes.get(id); if (!n) continue;
      if (type === 'frame' && n.layoutType !== 'frame') fitFrameToContent(n, true);   // give it a box (before the flip)
      n.layoutType = type;
      n.dirty = true;
    }
  });
  markLayoutChips();
  applyLayouts(); paintAll(); scheduleSave();
}
function setArrange(a: FrameArrange): void {
  const ids = selectedIds().filter(id => state.nodes.get(id)?.layoutType === 'frame');
  if (!ids.length) return;
  record(ids, () => {
    for (const id of ids){ const n = state.nodes.get(id); if (!n) continue; n.arrange = a; n.dirty = true; }
  });
  markLayoutChips();
  applyLayouts(); paintAll(); scheduleSave();
}
// reflect the selection's current layout in the popover chips AND the trigger button's icon
// (mixed selection → no chip active, trigger falls back to the "none" icon). The arrange row is
// shown only when the whole selection is a frame, mirroring its current arrange mode.
function markLayoutChips(): void {
  const ids = selectedIds();
  const types = new Set(ids.map(id => state.nodes.get(id)?.layoutType || 'none'));
  const t = types.size === 1 ? [...types][0] : null;
  edLayoutTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.classList.toggle('active', c.dataset.type === t));
  const active = edLayoutTypes.querySelector('.layoutchip.active');
  fbLayout.innerHTML = active ? active.innerHTML : LAYOUT_TYPES[0].icon;
  const frameSel = t === 'frame';
  edArrangeTypes.style.display = frameSel ? '' : 'none';
  if (frameSel){
    const arrs = new Set(ids.map(id => state.nodes.get(id)?.arrange || 'free'));
    const a = arrs.size === 1 ? [...arrs][0] : null;
    edArrangeTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
      c.classList.toggle('active', c.dataset.arrange === a));
  }
}

// ---------- colour trigger ----------
// The trigger button reuses the SAME .swatch/.inherit/.nofill CSS look as the popover's chips
// (see index.html: fbColor starts with class "fb-swatch swatch inherit") — just mirror whichever
// swatch is currently active.
function markColorTrigger(): void {
  const active = edColors.querySelector<HTMLElement>('.swatch.active');
  fbColor.classList.remove('inherit', 'nofill');
  fbColor.style.removeProperty('--sw');
  if (!active || active.classList.contains('inherit')) fbColor.classList.add('inherit');
  else if (active.classList.contains('nofill')) fbColor.classList.add('nofill');
  else fbColor.style.setProperty('--sw', active.style.getPropertyValue('--sw'));
}

function syncControls(): void {
  props().sync();
  markLayoutChips();
  markColorTrigger();
}

// ---------- popovers (colour / layout) ----------
// 12px — the same margin every corner/toolbar button keeps from the browser window edge
// (#toolbar's top:12px, .floating-btn's 12px offsets, …), so the popover sits the same
// "distance away" from the bar as the bar's own chrome sits from the window.
const POP_GAP = 12;
let activePopover: { pop: HTMLElement; anchor: HTMLElement } | null = null;
function positionPopover(pop: HTMLElement, anchor: HTMLElement): void {
  const ar = anchor.getBoundingClientRect();
  // vertical offset comes from the BAR's own rect, not the individual trigger's — fbColor's
  // swatch button is a smaller box than the other (--bar-btn sized) triggers, so anchoring to
  // its own rect would hang the colour popover a few px lower than the layout one. The bar's
  // height is shared by both triggers, so this keeps them flush regardless of that difference.
  const br = bar.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = ar.left + ar.width / 2 - pw / 2;
  let top = br.top - ph - POP_GAP;
  const above = top >= 4;
  if (!above) top = br.bottom + POP_GAP;
  left = Math.min(Math.max(left, 4), window.innerWidth - pw - 4);
  top = Math.min(Math.max(top, 4), window.innerHeight - ph - 4);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  // the connector stem bridges the gap, centred on the ANCHOR (not the popover, which may have
  // been clamped sideways near a screen edge) so it always starts right at the trigger button.
  popConnector.style.left = `${ar.left + ar.width / 2 - 1}px`;
  popConnector.style.top = `${above ? top + ph : br.bottom}px`;
  popConnector.style.height = `${POP_GAP}px`;
  popConnector.classList.add('open');
}
function closePopovers(): void {
  colorPop.classList.remove('open');
  layoutPop.classList.remove('open');
  popConnector.classList.remove('open');
  activePopover = null;
}
function togglePopover(pop: HTMLElement, anchor: HTMLElement): void {
  const willOpen = activePopover?.pop !== pop;
  closePopovers();
  if (willOpen){ pop.classList.add('open'); activePopover = { pop, anchor }; positionPopover(pop, anchor); }
}
fbColor.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(colorPop, fbColor); });
fbLayout.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(layoutPop, fbLayout); });
// a colour pick updates the trigger's own swatch look and closes the popover (the layout popover
// already closes itself in setLayout above). Runs after properties.ts's own listener has already
// set the new .active swatch (bubble phase fires the target's listener before this ancestor one).
colorPop.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.swatch')) return;
  markColorTrigger();
  closePopovers();
});
document.addEventListener('pointerdown', (e) => {
  const t = e.target as Node;
  if (activePopover && !colorPop.contains(t) && !layoutPop.contains(t) && t !== fbColor && t !== fbLayout) closePopovers();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && activePopover) closePopovers(); }, true);

// ---------- kebab menu: rename / edit note / duplicate / export / delete ----------
function buildEntries(): MenuEntry[] {
  const id = state.selId; if (!id) return [];
  const n = state.nodes.get(id); if (!n) return [];
  const multi = state.sel.size > 1;
  const anyFrame = [...state.sel].some(fid => state.nodes.get(fid)?.layoutType === 'frame');
  const entries: MenuEntry[] = [];
  if (!state.readOnly){
    entries.push({ label:'Rename', shortcut:'F2', run: () => startInlineEdit(n) });
    if (!multi) entries.push({ label:'Edit note', shortcut:'E', run: () => startBodyEdit(n) });
    entries.push('sep', { label:'Duplicate', shortcut:'D', run: () => duplicateSelection() });
    if (anyFrame) entries.push({ label: multi ? 'Auto-size frames' : 'Auto-size frame', shortcut:'A', run: () => autoSizeSelection() });
  }
  entries.push({ label:'Export', run: () => exportSelection() });   // mutates nothing → allowed read-only too
  if (!state.readOnly)
    entries.push('sep', { label: multi ? `Delete ${state.sel.size} cards` : 'Delete', shortcut:'Del',
      danger: true, run: () => deleteSelection() });
  return entries;
}
fbMore.addEventListener('click', (e) => {
  e.stopPropagation();
  const entries = buildEntries(); if (!entries.length) return;
  const r = fbMore.getBoundingClientRect();
  openMenu(entries, r.left, r.bottom + 4);
});

// ---------- anchoring: float the bar right above/below the selected card ----------
const GAP = 10;
function anchorEl(): HTMLElement | null | undefined {
  const n: MindNode | undefined = state.selId ? state.nodes.get(state.selId) : undefined;
  return n?.el;
}
function positionBar(): void {
  if (NARROW_MQ.matches){ bar.style.left = ''; bar.style.top = ''; return; }   // CSS docks it to the bottom
  const el = anchorEl(); if (!el) return;
  const r = el.getBoundingClientRect();
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let left = r.left + r.width / 2 - bw / 2;
  let top = r.top - bh - GAP;
  if (top < 4) top = r.bottom + GAP;   // not enough room above → flip below the card
  left = Math.min(Math.max(left, 4), window.innerWidth - bw - 4);
  top = Math.min(Math.max(top, 4), window.innerHeight - bh - 4);
  bar.style.left = `${left}px`;
  bar.style.top = `${top}px`;
  if (activePopover) positionPopover(activePopover.pop, activePopover.anchor);
}
// ---------- hide during drag / pan / zoom ----------
// The bar gets in the way while the card underneath (or the whole canvas) is moving, so it hides
// for the duration of any interaction and reappears once the pointer lifts. Node drag / canvas
// pan / pinch / marquee all flow through the shared `ui` holder (core/ui-state.ts) and clear on
// pointerup, so polling them from the follow loop below covers all of those with no extra hooks
// into drag.ts/gestures.ts. Wheel-driven pan/zoom has no pointer at all — those set `wheelBusy`
// directly and clear it after a short idle debounce instead.
let wheelBusy = false;
let wheelIdleTimer: number | null = null;
function markWheelBusy(): void {
  wheelBusy = true;
  if (wheelIdleTimer != null) clearTimeout(wheelIdleTimer);
  wheelIdleTimer = window.setTimeout(() => { wheelBusy = false; wheelIdleTimer = null; }, 150);
}
stage.addEventListener('wheel', markWheelBusy, { passive: true });
stage.addEventListener('gesturestart', () => { wheelBusy = true; });
stage.addEventListener('gestureend', () => { wheelBusy = false; });
function isInteracting(): boolean {
  return !!(ui.drag || ui.pan || ui.pinch || ui.marquee) || wheelBusy;
}
// Tracks the anchor card across camera pan/zoom and node drag without threading a hook through
// drag.ts/camera.ts — cheap (one rect read + one style write per frame) and only runs while open.
let raf: number | null = null;
function followLoop(): void {
  positionBar();   // also repositions the active popover, if any (keeps it glued to its trigger)
  const interacting = isInteracting();
  bar.classList.toggle('hide-interact', interacting);
  // an open colour/layout popover would otherwise sit at a stale position mid-pan/drag/zoom —
  // hide it right along with the bar it hangs off, same rule, same class.
  if (activePopover){
    activePopover.pop.classList.toggle('hide-interact', interacting);
    popConnector.classList.toggle('hide-interact', interacting);
  }
  raf = bar.classList.contains('open') ? requestAnimationFrame(followLoop) : null;
}
window.addEventListener('resize', () => { closePopovers(); positionBar(); });

// ---------- visibility ----------
// Outline mode only hides the bar on a narrow/phone screen, where the outliner replaces the
// canvas entirely (no card left to anchor to). On a wide screen the outliner is a drawer over a
// still-visible canvas, so a selected card can keep its bar.
//
// Showing the bar is debounced a touch (SHOW_DELAY) — hiding is not. A double-click both selects
// (click 1) AND folds the card (the dblclick itself, which doesn't touch selection) in quick
// succession; without the delay the bar would flash on right on click 1 only to have nothing
// change it back off, which reads as a flicker since it appears for a beat and then the fold
// yanks the layout under it. Any hide/re-show request within the delay window (including a
// genuine selection change) just reschedules or cancels this timer, so only the settled state
// after a short pause ever actually shows the bar — repositioning/control updates on an ALREADY
// open bar stay instant, so switching the selected card never feels laggy.
let showTimer: number | null = null;
const SHOW_DELAY = 180;
export function syncFloatBar(): void {
  closePopovers();
  const visible = state.sel.size > 0 && !state.readOnly && !(outlineActive() && NARROW_MQ.matches);
  if (showTimer != null) { clearTimeout(showTimer); showTimer = null; }
  if (!visible) {
    bar.classList.remove('open');
    if (raf != null) { cancelAnimationFrame(raf); raf = null; }
    return;
  }
  if (bar.classList.contains('open')) {   // already showing — update in place, no delay needed
    syncControls();
    positionBar();
    if (raf == null) followLoop();
    return;
  }
  showTimer = window.setTimeout(() => {
    showTimer = null;
    // the selection this was scheduled for may already be gone by the time the delay elapses
    if (!(state.sel.size > 0 && !state.readOnly && !(outlineActive() && NARROW_MQ.matches))) return;
    bar.classList.add('open');
    syncControls();
    positionBar();
    if (raf == null) followLoop();
  }, SHOW_DELAY);
}
// Crossing the narrow breakpoint (resize/rotate) can flip the outline+selection combo above
// without any selection change of its own, so re-run the visibility check directly.
NARROW_MQ.addEventListener('change', syncFloatBar);
