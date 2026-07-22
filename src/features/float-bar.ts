// ---------- floating selection bar ----------
// Replaces the old #editor right-hand sidebar: a compact row of icon buttons anchored right
// next to the selected card (Miro/Figma-style), instead of a persistent docked panel. Colour
// and layout each collapse to one trigger button that opens a small popover with the full
// picker (the same #edColors/#edLayoutTypes markup the old sidebar used); checklist/group-bg
// are icon toggles; a trailing kebab button replaces the old always-visible action row via the
// existing generic context menu (openMenu, features/context-menu.ts).
// On narrow/touch widths (NARROW_MQ) styles.css docks the bar to the bottom edge instead —
// this module skips the floating position math there and lets CSS own it.
import { state, stage, setStatus, isImageCard, isAnnotation, isQueryCard, type MindNode, type NodeType, type NodeLayout } from '../core/state.js';
import { NARROW_MQ, ui } from '../core/ui-state.js';
import { record, touch } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { applyLayouts, subtreeBox } from '../view/layout.js';
import { outlineActive } from './outline.js';
import { createProperties, type PropertyControls } from './properties.js';
import { startInlineEdit, startBodyEdit } from './inline-edit.js';
import { duplicateSelection, deleteSelection, deleteNode, deleteSelectionKeepChildren, addChild, createSibling, mkNode, uniqueTitle } from './crud.js';
import { exportSelection, shareSelection, canShareFiles, copySelection, cutSelection } from './clipboard.js';
import { pasteFromClipboard, pickImagesForNode } from './attachments.js';
import { openMenu, copyFilePath, type MenuEntry } from './context-menu.js';
import { childrenOf, isHidden, isLockedEffective, subtreeHasLocked } from '../utils/model.js';
import { frameBox } from '../view/camera.js';
import { paintAll, selectedIds, selectNode, foldNodeOrGroup, setLockedSelection, gridSnap, FRAME_W, FRAME_H, MIN_FRAME_W, MIN_FRAME_H, IMAGE_W, IMAGE_H, QUERY_W, QUERY_H } from '../main.js';

function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }

const bar = byId('floatBar');
const fbColor = byId<HTMLButtonElement>('fbColor');
const fbType = byId<HTMLButtonElement>('fbType');
const fbLayout = byId<HTMLButtonElement>('fbLayout');
const fbChecklist = byId<HTMLInputElement>('fbChecklist');
const fbBg = byId<HTMLInputElement>('fbBg');
// the <label> wrapping each toggle (markup: <label class="fb-toggle"><input id="fb...">...) —
// hidden entirely for an annotation selection, see markChips below.
const fbChecklistLabel = fbChecklist.parentElement!;
const fbBgLabel = fbBg.parentElement!;
const fbMore = byId<HTMLButtonElement>('fbMore');
const colorPop = byId('fbColorPop');
const typePop = byId('fbTypePop');
const layoutPop = byId('fbLayoutPop');
const popConnector = byId('fbPopConnector');
const edColors = byId('edColors');
const edTypes = byId('edTypes');
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
// A node's KIND. Selecting one seeds/tears down its box (see setType) and swaps which layout
// chips the layout popover offers (LAYOUTS_BY_TYPE below).
const TYPE_ICONS: Record<NodeType, string> = {
  card: SVG_OPEN + '<rect x="5" y="6" width="14" height="12" rx="2"/><path d="M8 10h8M8 13.5h5"/></svg>',
  frame: SVG_OPEN + '<rect x="3.5" y="5" width="17" height="14" rx="2"/><rect x="6.5" y="8.5" width="6" height="4.5" rx="1" fill="currentColor" stroke="none"/></svg>',
  image: SVG_OPEN + '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none"/><path d="M4 15.5l5-5 3.5 3.5 3-3 4.5 4.5"/></svg>',
  annotation: SVG_OPEN + '<path d="M4 4l3.5 3.5" stroke-dasharray="2 2"/><rect x="8" y="8" width="12" height="9" rx="2"/><path d="M10.5 12h7"/></svg>',
  query: SVG_OPEN + '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="10" cy="10" r="3"/><path d="M12.3 12.3l3 3"/></svg>',
};
const NODE_TYPES: { key: NodeType; label: string; icon: string }[] = [
  { key:'card',  label:'Card — an ordinary note',                                        icon: TYPE_ICONS.card },
  { key:'frame', label:'Frame — a resizable box; drag cards inside to hold them, out to release', icon: TYPE_ICONS.frame },
  { key:'image', label:'Image — a resizable box showing one image, nothing else (no children)',   icon: TYPE_ICONS.image },
  { key:'annotation', label:'Annotation — a title-less note pinned on top of its parent, ignored by layout', icon: TYPE_ICONS.annotation },
  { key:'query', label:'Query — a resizable box with a search field over a scrollable list of matching cards', icon: TYPE_ICONS.query },
];
// How a node of each type arranges its children. The layout popover shows exactly this type's set
// (image has none — it's a leaf, so its layout chip row is empty and the trigger is hidden).
const LAYOUTS_BY_TYPE: Record<NodeType, { key: NodeLayout; label: string; icon: string }[]> = {
  card: [
    { key:'inherit', label:'Inherit — take the parent’s layout (default)',
      icon: SVG_OPEN + '<rect x="5" y="7" width="14" height="10" rx="2" stroke-dasharray="3 2.5"/></svg>' },
    { key:'free', label:'Free — children stay where you drag them',
      icon: SVG_OPEN + DOT(6,7) + DOT(17,8) + DOT(11,17) + '</svg>' },
    { key:'line', label:'Line — children chained one after another, each on whichever side it sits on',
      icon: SVG_OPEN + DOT(4,12) + '<path d="M6.5 12h3"/>' + DOT(12,12) + '<path d="M14.5 12h3"/>' + DOT(20,12) + '</svg>' },
    { key:'fan', label:'Fan — children spread out, each to whichever side it’s placed on',
      icon: SVG_OPEN + DOT(4,12) + '<path d="M6 12l6-6M6 12h6M6 12l6 6"/>' + DOT(14,6,1.8) + DOT(14,12,1.8) + DOT(14,18,1.8) + '</svg>' },
  ],
  frame: [
    { key:'free', label:'Free — children placed freely inside the box',
      icon: SVG_OPEN + '<rect x="3.5" y="5" width="17" height="14" rx="2"/><rect x="6.5" y="8.5" width="6" height="4.5" rx="1" fill="currentColor" stroke="none"/></svg>' },
    { key:'horizontal', label:'Horizontal — cards flow left to right, wrapping down',
      icon: SVG_OPEN + '<rect x="3.5" y="5" width="17" height="14" rx="2"/><rect x="6.5" y="9.5" width="4.5" height="5" rx="1" fill="currentColor" stroke="none"/><rect x="13" y="9.5" width="4.5" height="5" rx="1" fill="currentColor" stroke="none"/></svg>' },
    { key:'vertical', label:'Vertical — cards flow top to bottom, wrapping right',
      icon: SVG_OPEN + '<rect x="3.5" y="5" width="17" height="14" rx="2"/><rect x="8.5" y="7.5" width="7" height="4" rx="1" fill="currentColor" stroke="none"/><rect x="8.5" y="12.5" width="7" height="4" rx="1" fill="currentColor" stroke="none"/></svg>' },
  ],
  image: [],
  annotation: [],
  query: [],
};
// The default layout for a freshly-set type — omitted from frontmatter (see serializeMd).
const DEFAULT_LAYOUT: Record<NodeType, NodeLayout> = { card: 'inherit', frame: 'free', image: 'free', annotation: 'free', query: 'free' };
// Fit a frame's box snugly around its children: a title strip on top, a margin on the other sides,
// snapped to the grid and clamped to the min size. Children keep their positions (the box moves to
// enclose them). With no children it's left as-is, or given the default size when `orDefault` (used
// when a card first becomes a frame). Shared by the frame chip and the Auto-size action.
const FRAME_FIT_PAD = 16, FRAME_FIT_TITLE = 36;   // side/bottom margin; top strip for the title
function fitFrameToContent(n: MindNode, orDefault = false): void {
  const kids = childrenOf(n.id).filter(k => !isHidden(k) && !isAnnotation(k));   // annotations don't size the frame
  const snapStep = gridSnap();
  const snap = (v: number): number => Math.round(v / snapStep) * snapStep;
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
  const ids = selectedIds().filter(id => state.nodes.get(id)?.type === 'frame' && !isLockedEffective(state.nodes.get(id)!));
  if (!ids.length) return;
  record(ids, () => { for (const id of ids){ const n = state.nodes.get(id); if (n) { fitFrameToContent(n); n.dirty = true; } } });
  applyLayouts(); paintAll(); scheduleSave();
}
// Wrap the selected cards in a fresh frame: the frame lands as a child of the nearest
// NON-selected ancestor of the first selected card (walking up past any selected ancestor —
// grouping a parent together with its own child would otherwise reparent the parent under the
// frame while the frame sits under that same parent, a cycle), sized to enclose the selection's
// current positions (same fit math as fitFrameToContent). Every selected card is reparented
// under the new frame, which ends up selected. Shared by the 'G' shortcut and the context menu.
export function groupSelectionIntoFrame(): void {
  if (state.readOnly) return;
  const ids = selectedIds().filter(id => !isLockedEffective(state.nodes.get(id)!));
  const nodes = ids.map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n);
  if (!nodes.length) { setStatus('Locked — can’t group'); return; }
  const selectedSet = new Set(ids);
  let parentId: string | null = nodes[0].parent;
  while (parentId && selectedSet.has(parentId)) parentId = state.nodes.get(parentId)?.parent ?? null;
  const parent = parentId ? state.nodes.get(parentId) : null;
  if (parent && isLockedEffective(parent)) { setStatus('Locked — can’t group here'); return; }

  let frameId = '';
  record([], () => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const b = subtreeBox(n); if (!isFinite(b.x0)) continue;
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    const snapStep = gridSnap();
  const snap = (v: number): number => Math.round(v / snapStep) * snapStep;
    const fx = isFinite(x0) ? snap(x0 - FRAME_FIT_PAD) : 0;
    const fy = isFinite(y0) ? snap(y0 - FRAME_FIT_TITLE) : 0;
    const fw = isFinite(x1) ? Math.max(MIN_FRAME_W, snap(x1 + FRAME_FIT_PAD - fx)) : FRAME_W;
    const fh = isFinite(y1) ? Math.max(MIN_FRAME_H, snap(y1 + FRAME_FIT_PAD - fy)) : FRAME_H;
    const frame = mkNode({
      x: fx, y: fy, w: fw, h: fh, parent: parentId,
      title: uniqueTitle('Frame'), type: 'frame', layout: 'free',
    });
    frameId = frame.id;
    state.nodes.set(frameId, frame);
    for (const n of nodes) { touch(n.id); n.parent = frameId; n.dirty = true; }
  });
  applyLayouts(); paintAll(); selectNode(frameId); scheduleSave();
  setStatus(`Grouped ${nodes.length} card${nodes.length === 1 ? '' : 's'} into a frame`);
}
(function buildTypeChips(){
  edTypes.innerHTML = NODE_TYPES.map(t =>
    `<div class="layoutchip" data-type="${t.key}" title="${t.label}">${t.icon}</div>`).join('');
  edTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.addEventListener('click', () => { setType(c.dataset.type as NodeType); closePopovers(); }));
})();
// The layout chips are type-dependent, so they're (re)built lazily whenever the selected type
// changes — `builtFor` avoids rebuilding (and re-binding listeners) on every sync.
let builtFor: NodeType | null = null;
function rebuildLayoutChips(type: NodeType): void {
  if (builtFor === type) return;
  builtFor = type;
  edLayoutTypes.innerHTML = LAYOUTS_BY_TYPE[type].map(l =>
    `<div class="layoutchip" data-layout="${l.key}" title="${l.label}">${l.icon}</div>`).join('');
  edLayoutTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.addEventListener('click', () => { setLayout(c.dataset.layout as NodeLayout); closePopovers(); }));
}
// Change the KIND of the selection: seed/reset the box, drop a now-invalid layout, reseed order.
function setType(type: NodeType): void {
  const ids = selectedIds().filter(id => !isLockedEffective(state.nodes.get(id)!)); if (!ids.length) return;
  // image/annotation/query are leaves — refuse to flip a card that already has children into one
  if ((type === 'image' || type === 'annotation' || type === 'query') && ids.some(id => childrenOf(id).length)) {
    setStatus(`A${type === 'image' ? 'n image card' : type === 'query' ? ' query card' : 'n annotation'} can’t have children — move or delete them first`);
    return;
  }
  record(ids, () => {
    for (const id of ids){
      const n = state.nodes.get(id); if (!n || n.type === type) continue;
      if (type === 'frame') fitFrameToContent(n, true);   // give it a box enclosing its children
      if (type === 'image' && (n.w == null || n.h == null)) { n.w = IMAGE_W; n.h = IMAGE_H; }
      if (type === 'query' && (n.w == null || n.h == null)) { n.w = QUERY_W; n.h = QUERY_H; }
      n.type = type;
      // keep the current arrangement if the new type still supports it (e.g. free across card↔frame);
      // otherwise fall back to the type's default (card→inherit, frame→free, image→none).
      if (!LAYOUTS_BY_TYPE[type].some(l => l.key === n.layout)) n.layout = DEFAULT_LAYOUT[type];
      n.kidOrder = undefined;   // reseed order from the children's CURRENT positions under the new type
      n.dirty = true;
    }
  });
  markChips();
  applyLayouts(); paintAll(); scheduleSave();
}
// Change the child-ARRANGEMENT of the selection (within its current type).
function setLayout(layout: NodeLayout): void {
  const ids = selectedIds().filter(id => !isLockedEffective(state.nodes.get(id)!)); if (!ids.length) return;
  record(ids, () => {
    for (const id of ids){
      const n = state.nodes.get(id); if (!n || n.layout === layout) continue;
      // Drop the stored child order: a switch INTO a managed layout (line/fan/flow) must reseed
      // order from the children's CURRENT positions — a free layout never touches kidOrder, so a
      // stale order from an earlier managed pass would otherwise survive.
      n.layout = layout;
      n.kidOrder = undefined;
      n.dirty = true;
    }
  });
  markChips();
  applyLayouts(); paintAll(); scheduleSave();
}
// Reflect the selection's current type + layout in both popovers AND their trigger icons. A single
// type shows its chip active and its layout set; a mixed-type selection leaves both blank. The
// layout picker is rebuilt for the selected type and hidden entirely for leaves (image/annotation).
function markChips(): void {
  const ids = selectedIds();
  const typeSet = new Set(ids.map(id => state.nodes.get(id)?.type ?? 'card'));
  const type = typeSet.size === 1 ? [...typeSet][0] : null;
  edTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.classList.toggle('active', c.dataset.type === type));
  fbType.innerHTML = type ? TYPE_ICONS[type] : TYPE_ICONS.card;

  // checklist / group-background are meaningless on an annotation (a title-less leaf that can
  // never have children — no subtree to check off or tint) — hide both toggles entirely rather
  // than leave a no-op control in the bar.
  const isAnno = type === 'annotation';
  fbChecklistLabel.style.display = isAnno ? 'none' : '';
  fbBgLabel.style.display = isAnno ? 'none' : '';

  const forType: NodeType = type ?? 'card';
  rebuildLayoutChips(forType);
  const hasLayout = LAYOUTS_BY_TYPE[forType].length > 0;
  fbLayout.style.display = hasLayout ? '' : 'none';
  if (!hasLayout) { fbLayout.innerHTML = ''; return; }
  const layoutSet = new Set(ids.map(id => state.nodes.get(id)?.layout));
  const layout = (type && layoutSet.size === 1) ? [...layoutSet][0] : null;
  edLayoutTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.classList.toggle('active', c.dataset.layout === layout));
  const active = edLayoutTypes.querySelector('.layoutchip.active');
  fbLayout.innerHTML = active ? active.innerHTML : LAYOUTS_BY_TYPE[forType][0].icon;
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
  markChips();
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
  typePop.classList.remove('open');
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
fbType.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(typePop, fbType); });
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
  if (activePopover && !colorPop.contains(t) && !typePop.contains(t) && !layoutPop.contains(t)
      && t !== fbColor && t !== fbType && t !== fbLayout) closePopovers();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && activePopover) closePopovers(); }, true);

// ---------- card actions menu: rename / edit note / duplicate / export / delete / … ----------
// Shared by the kebab button here AND the right-click context menu (features/context-menu.ts) —
// ONE list of entries so the two never drift apart. `n` is the menu's TARGET card: the kebab's
// target is always the (sole) selection anchor; the context menu's is whatever was clicked, which
// may or may not be part of the current multi-selection. `sx`/`sy` only matter for "Paste as
// child" (where the pasted card lands) — the kebab has no cursor position, so it passes the
// button's own screen position instead.
export function buildCardMenu(n: MindNode, sx: number, sy: number): MenuEntry[] {
  const multi = state.sel.has(n.id) && state.sel.size > 1;
  const targetIds = multi ? [...state.sel] : [n.id];
  const anyFrame = targetIds.some(id => state.nodes.get(id)?.type === 'frame');
  // group actions (Duplicate/Cut/Copy/Export/Share/Auto-size) act on state.sel via selectedIds();
  // when the target isn't already part of the selection, select it first so they act on IT.
  const selectTargetFirst = () => { if (!multi) selectNode(n.id); };
  const isImage = isImageCard(n);   // a leaf: no title/body UI, no children
  const isAnno = isAnnotation(n);   // a leaf with a body but no title, no children
  const isQuery = isQueryCard(n);   // a leaf with its own search field, no body, but keeps its title
  const isLeaf = isImage || isAnno || isQuery; // none can hold children
  const locked = isLockedEffective(n);                 // n itself: locked, or a locked descendant
  const parentLocked = !!n.parent && isLockedEffective(state.nodes.get(n.parent)!);
  const anyLocked = targetIds.some(id => isLockedEffective(state.nodes.get(id)!));
  const anySubtreeLocked = targetIds.some(id => subtreeHasLocked(id));
  const entries: MenuEntry[] = [];
  if (!state.readOnly){
    if (!multi){
      if (!isImage && !isAnno) entries.push({ label:'Rename', shortcut:'F2', run: () => startInlineEdit(n), disabled: locked });   // query keeps its title
      if (!isImage && !isQuery) entries.push({ label:'Edit note', shortcut:'E', run: () => startBodyEdit(n), disabled: locked });   // annotation keeps its body; query has none
      if (!isImage && !isQuery) entries.push({ label:'Insert image…', run: () => pickImagesForNode(n.id), disabled: locked });
      if (!isLeaf){
        entries.push('sep');
        entries.push({ label:'Add child', shortcut:'Tab', run: () => addChild(n.id), disabled: locked });
        entries.push({ label:'Paste as child', shortcut:'⌘V', run: () => { void pasteFromClipboard(sx, sy, n.id); }, disabled: locked });
      }
      entries.push({ label:'Add sibling', shortcut:'Enter', run: () => createSibling(n.id), disabled: parentLocked });
    }
    entries.push({ label:'Duplicate', shortcut:'D', run: () => { selectTargetFirst(); duplicateSelection(); } });
    entries.push({ label:'Cut', shortcut:'⌘X', run: () => { selectTargetFirst(); void cutSelection(); }, disabled: anySubtreeLocked });
    entries.push({ label:'Group into frame', shortcut:'G', run: () => { selectTargetFirst(); groupSelectionIntoFrame(); }, disabled: anyLocked });
    entries.push('sep');
    entries.push({ label: (multi ? anyLocked : locked) ? 'Unlock' : 'Lock', shortcut:'L',
      run: () => { selectTargetFirst(); setLockedSelection(state.sel, !(multi ? anyLocked : locked)); } });
    entries.push('sep');
  }
  // copy/collapse/fit/export never mutate → allowed in read-only mode too
  entries.push({ label:'Copy', shortcut:'⌘C', run: () => { selectTargetFirst(); void copySelection(); } });
  if (!multi)
    entries.push({ label: n.collapsed ? 'Expand' : 'Collapse', shortcut:'X', run: () => foldNodeOrGroup(n),
      disabled: locked || (!childrenOf(n.id).length && !(n.body && n.body.trim())) });
  entries.push({ label:'Fit view', shortcut:'F', run: () => frameBox(targetIds.map(id => state.nodes.get(id))) });
  entries.push({ label:'Copy file path', run: () => copyFilePath(n), disabled: !n.file });
  if (anyFrame && !state.readOnly)
    entries.push({ label: multi ? 'Auto-size frames' : 'Auto-size frame', shortcut:'⇧A',
      run: () => { selectTargetFirst(); autoSizeSelection(); }, disabled: anyLocked });
  entries.push('sep', { label:'Download selected cards', run: () => { selectTargetFirst(); exportSelection(); } });
  entries.push({ label:'Share…', run: () => { selectTargetFirst(); void shareSelection(); }, disabled: !canShareFiles });
  if (!state.readOnly){
    entries.push('sep', { label: multi ? `Delete ${state.sel.size} cards` : 'Delete', shortcut:'Del',
      danger: true, run: () => multi ? deleteSelection() : deleteNode(n.id), disabled: anySubtreeLocked });
    entries.push({ label: multi ? `Delete ${state.sel.size} cards, keep children` : 'Delete, keep children', shortcut:'⌥Del',
      danger: true, run: () => { selectTargetFirst(); deleteSelectionKeepChildren(); }, disabled: anyLocked });
  }
  return entries;
}
fbMore.addEventListener('click', (e) => {
  e.stopPropagation();
  const id = state.selId; const n = id ? state.nodes.get(id) : undefined;
  if (!n) return;
  const r = fbMore.getBoundingClientRect();
  const entries = buildCardMenu(n, r.left, r.bottom);
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
  return !!(ui.drag || ui.pan || ui.pinch || ui.marquee || ui.inlineEdit || ui.bodyEdit) || wheelBusy;
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
