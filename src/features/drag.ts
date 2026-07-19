// ---------- node dragging & reparent-by-drop ----------
// Per-node pointer gestures: drag moves the whole subtree (or the multi-selection, as one group);
// Shift clones while dragging, Alt detaches to root, dropping onto another card reparents —
// EVERY true root of the drag (see selRoots/trueRoots), not just the card that was pressed, so a
// multi-selected group can be dropped onto a new parent/side together in one gesture. Edge
// auto-pan keeps the dragged subtree glued under the cursor while the view scrolls. All transient
// drag state lives in `ui.drag`. Importing this module registers the global Alt/Shift modifier
// listeners; bindNodeDrag is called by the render core (nodeEl) for each card.
import { state, stage, world, setStatus, isLeafType, isAnnotation, isImageCard, type MindNode, type LayoutSide } from '../core/state.js';
import { isHidden, isAncestor, hasLockedAncestor, isLockedEffective } from '../utils/model.js';
import { applyLayouts, reorderDraggedParents, dropLanding, isManagedLayout, frameFlow, flowReorderTarget, isFrame, centreInFrame, insertedKidOrder, sideOf, deriveSide, reorderTarget, ancestorDepth } from '../view/layout.js';
import { cancelViewAnim, applyView } from '../view/camera.js';
import { scheduleSave } from '../data/persistence.js';
import { ui, NARROW_MQ, type Pt, type Seg, type Drag } from '../core/ui-state.js';
import { paintEdges } from '../view/edges.js';
import { outlineActive } from './outline.js';
import { beginMarqueeFromNode } from './gestures.js';
import { NODE_W, nodeW, nodeH, gridSnap, paintAll, paintNode, selectNode, setSelectionSet, toggleSel,
         subtreeIds, foldNodeOrGroup } from '../main.js';
import { startInlineEdit, startBodyEdit, endInlineEdit, endBodyEdit } from './inline-edit.js';
import { leaveClone, foldImageCardsIntoBody } from './crud.js';
import { startImageExtractDrag } from './image-extract.js';
import { touch, commitStep } from './history.js';

// The #outline drawer overlays the canvas from the right on wide screens; cache it too so
// auto-pan can treat it as a right obstruction (see autoPanStep).
let _outline: HTMLElement | null = null;
function outlineEl(): HTMLElement | null { return _outline ??= document.getElementById('outline'); }

// Lazily-created phantom card that previews where the dragged card will actually LAND once
// dropped (not where the cursor currently is) while poised over a valid reparent target. The
// dragged cards stay visible and keep following the cursor; the ghost is an additional preview.
let _landingGhost: HTMLElement | null = null;
function landingGhostEl(): HTMLElement {
  if (_landingGhost) return _landingGhost;
  const el = document.createElement('div');
  el.className = 'node reparent-ghost landing-ghost';
  el.style.display = 'none';
  world.appendChild(el);
  return _landingGhost = el;
}
function showLandingGhost(x: number, y: number, h: number): void {
  const el = landingGhostEl();
  el.style.left = x + 'px'; el.style.top = y + 'px';
  el.style.width = NODE_W + 'px'; el.style.height = h + 'px';
  // .node has a 64px min-height (for bodied cards); without this the ghost for a shorter
  // title-only card would get clamped taller than the real card it's previewing.
  el.style.minHeight = h + 'px';
  el.style.borderColor = 'white';   // matches the highlighted anchor dot/ghost edge
  el.style.display = '';
  if (_insertLine) _insertLine.style.display = 'none';   // ghost and reorder bar never coexist
}
function hideLandingGhost(): void {
  if (_landingGhost) _landingGhost.style.display = 'none';
  if (_insertLine) _insertLine.style.display = 'none';
}
// Lazily-created insertion indicator for an in-parent REORDER: a thin bar in the CURRENT gap
// between the two siblings the dragged card would slot between (horizontal for a vertical
// stack, vertical for a horizontal spread) — shows the order slot relative to the siblings as
// they stand, rather than a ghost card at the post-drop position. The dragged card itself keeps
// following the cursor. Hidden by hideLandingGhost alongside the reparent ghost.
let _insertLine: HTMLElement | null = null;
const INSERT_LINE_W = 3;   // bar thickness (world px) — reads like the ghost's 2px dashed border
function showInsertLine(seg: Seg): void {
  if (_landingGhost) _landingGhost.style.display = 'none';   // bar and ghost never coexist
  const el = _insertLine ??= (() => {
    const d = document.createElement('div');
    d.className = 'insert-line';
    world.appendChild(d);
    return d;
  })();
  const horiz = seg.y0 === seg.y1;
  el.style.left = (seg.x0 - (horiz ? 0 : INSERT_LINE_W / 2)) + 'px';
  el.style.top = (seg.y0 - (horiz ? INSERT_LINE_W / 2 : 0)) + 'px';
  el.style.width = (horiz ? seg.x1 - seg.x0 : INSERT_LINE_W) + 'px';
  el.style.height = (horiz ? INSERT_LINE_W : seg.y1 - seg.y0) + 'px';
  // white + dashed, matching the reparent ghost's border (2px dashed white, dash ~6/5) — a div
  // can't dash a background, so fake it with a repeating gradient along the bar's long axis
  el.style.background = `repeating-linear-gradient(${horiz ? 90 : 180}deg, white 0 6px, transparent 6px 11px)`;
  el.style.display = '';
}

// True roots of a drag-selection set: a member whose own parent is ALSO in the set rides along
// with it (it's already carried as part of that ancestor's subtree), so only the outermost
// members get individually re-parented on drop. Shared by drag-start and the clone-revert path
// (which needs to recompute the ORIGINAL roots after handing selRoots off to the clones).
function trueRoots(ids: string[]): string[] {
  const idSet = new Set(ids);
  return ids.filter(id => { const p = state.nodes.get(id)?.parent; return !p || !idSet.has(p); });
}
// The inline body image under a screen point (body images are pointer-events:none, so a geometric
// hit-test is needed) — used to start an image-extract drag from an Alt-press.
function bodyImageAt(el: HTMLElement, x: number, y: number): HTMLImageElement | null {
  for (const img of el.querySelectorAll<HTMLImageElement>('.body img.md-img')){
    const r = img.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return img;
  }
  return null;
}

const RIP_THRESHOLD = 200; // screen-space px — the base rip distance (see distanceRip)

// A distance-based rip: a child detaches once its centre is pulled clear of the parent's own
// footprint by a margin. Measured centre-to-centre, then the parent's bounding DIAGONAL is
// subtracted (so a child merely sitting beside a large parent — e.g. a big frame — never reads as
// ripped) and the leftover must exceed HALF the base threshold. Zoom-scaled so it's a screen-space
// feel. Returns false for a root (nothing to rip from).
function distanceRip(node: MindNode): boolean {
  const p = node.parent ? state.nodes.get(node.parent) : null;
  if (!p) return false;
  const dist = Math.hypot((node.x + nodeW(node)/2) - (p.x + nodeW(p)/2),
                          (node.y + nodeH(node)/2) - (p.y + nodeH(p)/2));
  const diag = Math.hypot(nodeW(p), nodeH(p));
  return (dist - diag) * state.view.k > RIP_THRESHOLD / 2;
}

// Is a screen point outside the browser window? True once a drag has left for another app.
const outsideWindow = (x: number, y: number): boolean =>
  x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;

// Recompute whether the dragged card is currently ripped off its parent (distanceRip: pulled clear
// of the parent's footprint by half the base threshold — see that helper). Must be called before
// paintEdges() so the hidden-edge rendering reads the latest state.
function updateRip(drag: Drag): void {
  // Runs for a multi-selection too (all roots move by the same delta, so the anchor's rip state is
  // the whole group's) — dragPointerUp detaches every dragged root that this gesture pulls off.
  if (drag.cloned || !drag.moved) return;
  const act = drag.active;
  let rip = false;
  // A live in-parent reorder preview overrides rip: while the card slides along its sibling
  // band (updateDropTarget ran just before us), releasing means "re-slot", never "detach".
  const reordering = drag.dropMode === 'reorder' && !!drag.dropTarget;
  // A direct child of a frame is NEVER ripped off by distance: its cards live in the frame's own
  // coordinate space and are meant to be freely repositioned inside the box. It counts as "ripping"
  // (about to detach) only once its centre leaves the frame's bounds — the SAME outOfFrame trigger
  // dragPointerUp commits on. Sharing drag.rip means effectiveColor previews the detach colour the
  // instant it crosses out, exactly as a distance-rip does for a non-frame child.
  const parent = act.parent ? state.nodes.get(act.parent) : null;
  // An annotation is never "in" a frame for rip purposes — it renders on top, not inside the box —
  // so it detaches ONLY by being dragged past the rip threshold, never by leaving a frame's bounds.
  const inFrame = !!(parent && isFrame(parent)) && !isAnnotation(act);
  if (act.parent && !reordering) {
    if (inFrame) {
      rip = !centreInFrame(act, parent!);
    } else {
      rip = distanceRip(act);   // pulled clear of the parent's footprint by half the base threshold
    }
  }
  if (rip === drag.rip) return;
  drag.rip = rip;
  // Ripping past threshold previews the same "about to become a root" outcome as Alt-detach (see
  // effectiveColor) — repaint the dragged subtree so an inheriting card's colour updates the
  // instant it crosses the threshold, not just once the drop actually commits.
  for (const id of subtreeIds(act.id)) { const m = state.nodes.get(id); if (m) paintNode(m); }
}

// Move every dragged card to start + (dx,dy) in world space, mirroring it with a compositor-only
// transform (left/top stay frozen at the card's origin). Shared by the pointermove, auto-pan, and
// modifier-follow paths — all three apply the same offset to drag.targets.
function applyDragTransform(drag: Drag, dx: number, dy: number): void {
  for (const [id, s] of drag.targets){
    const m = state.nodes.get(id); if (!m) continue;
    m.x = s.x + dx; m.y = s.y + dy; m.dirtyLayout = true;
    if (m.el) {
      const orig = drag.origins.get(id);
      if (orig) {
        // A node hosted inside a frame that's ALSO part of this drag is already carried visually
        // by that frame's frameContentEl transform below (its left/top sit inside that container,
        // which itself is about to move) — giving it its own transform too would add the same
        // shift twice. Only "roots" of the dragged subtree(s) — no host, or a host that isn't
        // moving in this same gesture — need an explicit transform of their own.
        const carried = m.hostFrameId != null && drag.targets.has(m.hostFrameId);
        const t = carried ? '' : `translate(${m.x-orig.x}px,${m.y-orig.y}px)`;
        m.el.style.transform = t;
        // An expanded frame's overflow:hidden content wrapper (frameContentEl) is a second,
        // separately-positioned element (left/top only re-synced by a full paintNode) — mirror
        // the same compositor transform onto it (only when this frame itself is a root — a
        // carried frame's wrapper is already moving with its own host's transform) so the clip
        // window slides with the frame instead of staying stranded at its pre-drag position.
        if (m.frameContentEl) m.frameContentEl.style.transform = t;
      }
    }
  }
}

// While a node is dragged to the screen edge, pan the view so you can drop onto cards that are
// currently off-screen. The view pans toward the edge the cursor sits in, and the dragged subtree
// is shifted in world-space by the inverse so it stays glued under the (stationary) cursor.
// Drain the deferred drag paint: update drop-target highlight and redraw edges every frame.
function flushDragPaint(): void {
  ui.dragRAF = null;
  const drag = ui.drag;
  if (!drag) return;
  if (drag.moved) {
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
  }
  updateRip(drag);
  paintEdges();   // n.x/y is current, so edges track the dragged nodes correctly
  if (drag.moved && !ui.autoPanRAF) ui.autoPanRAF = requestAnimationFrame(autoPanStep);
}
function stopAutoPan(): void { if (ui.autoPanRAF){ cancelAnimationFrame(ui.autoPanRAF); ui.autoPanRAF = null; } }
function autoPanStep(): void {
  ui.autoPanRAF = null;
  const drag = ui.drag;
  if (!drag || !drag.moved || state.readOnly) return;
  // Available canvas = the stage minus the toolbar (above it) and, on wide screens, the outline
  // drawer when it's open (the floating edit bar overlays the card itself rather than docking to
  // a screen edge, so it's not an obstruction here). Panning kicks in as the cursor reaches that
  // obstruction, so you can drag onto / past it — and so it doesn't start abruptly only once
  // the cursor slips BEHIND the outline drawer to the true window edge.
  const r = stage.getBoundingClientRect();
  let right = r.right;
  // The outline drawer is a right obstruction only while OPEN on a wide screen (narrow hides
  // #stage, and a parked drawer's transform leaves it off-screen only once its slide settles —
  // so gate on the class, not the live geometry).
  const ol = outlineEl();
  if (ol && outlineActive() && !NARROW_MQ.matches)
    right = Math.min(right, ol.getBoundingClientRect().left);
  const M = 56, MAX = 16;   // edge band (px) and max pan speed (px/frame)
  let vx = 0, vy = 0;
  const x = drag.cx, y = drag.cy;
  // Pan only while the pointer is still INSIDE the browser window: once it crosses out
  // (e.g. a drag heading for another app), scrolling on would carry the map away under it.
  if (!outsideWindow(x, y)){
    if (x < r.left + M)     vx =  Math.min(1, (r.left + M - x) / M);
    else if (x > right - M) vx = -Math.min(1, (x - (right - M)) / M);
    if (y < r.top + M)        vy =  Math.min(1, (r.top + M - y) / M);
    else if (y > r.bottom - M) vy = -Math.min(1, (y - (r.bottom - M)) / M);
  }
  if (vx || vy){
    cancelViewAnim();
    vx *= MAX; vy *= MAX;
    state.view.x += vx; state.view.y += vy; applyView();
    // shift the dragged subtree's anchors opposite the pan so the cursor-to-card offset never
    // changes (only `targets` — `start` keeps its own positions for clone/reset).
    const wdx = -vx / state.view.k, wdy = -vy / state.view.k;
    for (const s of drag.targets.values()){ s.x += wdx; s.y += wdy; }
    applyDragTransform(drag, (drag.cx - drag.sx) / state.view.k, (drag.cy - drag.sy) / state.view.k);
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
    updateRip(drag);
    paintEdges();   // redraw edges every auto-pan frame so they follow the moving nodes
  }
  ui.autoPanRAF = requestAnimationFrame(autoPanStep);
}
// The INNERMOST (deepest-nested) expanded frame whose box contains the given screen point, or null.
// Nested frames overlap and stack by DOM order, so a press can't rely on the browser picking the
// innermost — this resolves it geometrically. Collapsed frames (rendered as cards) don't count.
function innermostFrameAt(clientX: number, clientY: number): MindNode | null {
  const wx = (clientX - state.view.x) / state.view.k, wy = (clientY - state.view.y) / state.view.k;
  let best: MindNode | null = null, bestDepth = -1;
  for (const m of state.nodes.values()) {
    if (!isFrame(m) || isHidden(m)) continue;
    if (wx < m.x || wx > m.x + nodeW(m) || wy < m.y || wy > m.y + nodeH(m)) continue;
    const depth = ancestorDepth(m);
    if (depth > bestDepth) { bestDepth = depth; best = m; }
  }
  return best;
}
export function bindNodeDrag(n: MindNode): void {
  const el = n.el!;
  // Double-tap on touch -> collapse/expand (mirrors dblclick on desktop; also prevents iOS double-tap zoom)
  let lastTouchTap = 0, lastTouchTapTarget: EventTarget | null = null;
  el.addEventListener('touchstart', (e) => {
    // While editing this card, let the browser handle double-tap normally (word selection)
    if ((ui.inlineEdit && ui.inlineEdit.id === n.id) || (ui.bodyEdit && ui.bodyEdit.id === n.id)) { lastTouchTap = 0; return; }
    const now = performance.now();
    if (e.touches.length === 1 && now - lastTouchTap < 300) {
      e.preventDefault(); // stop double-tap zoom and synthetic dblclick
      clearTimeout(ui.renameTimer);
      foldNodeOrGroup(n);   // mirror the dblclick handler: fold/unfold the card or group
      lastTouchTap = 0;
      return;
    }
    lastTouchTap = now;
    lastTouchTapTarget = e.target;
  }, { passive: false });
  el.addEventListener('pointerdown', (e) => {
    if (e.button === 2) { e.stopPropagation(); return; }   // right-click = context menu only: no drag/select/rename
    // A descendant of a locked card can't be selected or dragged at all — only the locked card
    // itself (checked further below) remains reachable this way.
    if (hasLockedAncestor(n)) { e.stopPropagation(); return; }
    const tgt = e.target as HTMLElement;
    if (tgt.classList.contains('addnote')) return;
    if (tgt.closest('input.taskbox') && isLockedEffective(n)) { e.stopPropagation(); e.preventDefault(); return; }  // locked: no task toggling
    if (tgt.closest('a.lk, input.taskbox, .img-zoom')) { e.stopPropagation(); return; }  // let links/checkboxes/zoom click, not drag
    // Alt-press over an inline body image (on a plain card) rips THAT image out — extraction rides
    // its own preview (features/image-extract.ts), not the card drag. Image-only cards drag whole.
    if (e.altKey && e.button === 0 && !state.readOnly && !isImageCard(n) && !isFrame(n) && !isLockedEffective(n)) {
      const img = bodyImageAt(el, e.clientX, e.clientY);
      if (img && img.dataset.path) {
        e.stopPropagation();
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        startImageExtractDrag(n, img, e.clientX, e.clientY);
        return;
      }
    }
    // Nested frames overlap and stack by DOM order (not nesting), so the frame that received this
    // press may be an OUTER one. Prefer the INNERMOST frame under the pointer: hand the gesture off
    // to it by re-firing the press on its element (its own handler then finds itself innermost and
    // proceeds). Only when the pressed node is an (expanded) frame — a card on top, or a collapsed
    // frame (which is just a card), is always taken as-is.
    if (isFrame(n)) {
      const inner = innermostFrameAt(e.clientX, e.clientY);
      if (inner && inner !== n && inner.el) {
        e.stopPropagation();
        inner.el.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
          button: e.button, buttons: e.buttons, pointerId: e.pointerId, pointerType: e.pointerType,
          isPrimary: e.isPrimary, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey }));
        return;
      }
    }
    // Close an editor open on a DIFFERENT card (tap-outside on touch where blur may not fire)
    if (ui.inlineEdit && ui.inlineEdit.id !== n.id) endInlineEdit();
    if (ui.bodyEdit   && ui.bodyEdit.id   !== n.id) endBodyEdit();
    // while this card's title/body is being edited, let clicks place the caret — don't start a drag
    if ((ui.inlineEdit && ui.inlineEdit.id === n.id) || (ui.bodyEdit && ui.bodyEdit.id === n.id)) { e.stopPropagation(); return; }
    clearTimeout(ui.renameTimer);   // any fresh interaction cancels a pending slow-click rename
    // A drag on an UNSELECTED (expanded) frame rubber-band-selects the cards INSIDE it rather than
    // moving the frame — you move the frame only once it's selected. A no-move click selects the
    // frame (endMarquee). ⌘/Ctrl-click still falls through to the normal add-to-selection toggle.
    if (isFrame(n) && !n.collapsed && !state.sel.has(n.id) && e.button === 0 && !e.metaKey && !e.ctrlKey) {
      e.stopPropagation();
      beginMarqueeFromNode(e, n.id);
      return;
    }
    e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch { /* no active pointer (e.g. synthetic) */ }
    // Dragging a card that's part of a multi-selection moves the WHOLE selection at once;
    // otherwise just this card's subtree. `active` is the node dragged/dropped; `targets`
    // are the nodes that follow the cursor (or, after a Shift-clone, just the clone).
    const multi = state.sel.has(n.id) && state.sel.size > 1;
    // A locked member of a multi-selection stays put — only its unlocked companions get dragged
    // (pressing directly ON a locked card is handled separately in dragPointerMove, which pins the
    // whole gesture since `n` itself owns it).
    const rootIds = (multi ? [...state.sel] : [n.id])
      .filter(id => id === n.id || !isLockedEffective(state.nodes.get(id)!));
    const selRoots = trueRoots(rootIds);
    const ids = [...new Set(rootIds.flatMap(id => subtreeIds(id)))];
    const start = new Map(ids.map(id => {
      const m = state.nodes.get(id)!; return [id, { x:m.x, y:m.y }] as [string, Pt];
    }));
    // targets gets its OWN {x,y} objects (not new Map(start), which shares the value refs) so the
    // edge auto-pan can shift the dragged anchors without also moving the pinned `start` positions.
    const targets = new Map([...start].map(([id, s]) => [id, { x:s.x, y:s.y }] as [string, Pt]));
    // Positions mutate live during the drag, so the undo pre-images must be captured NOW;
    // dragPointerUp commits the step (a no-move click nets out and is discarded).
    touch(...ids);
    // origins = the left/top CSS values frozen at drag start; transforms are relative to these
    const origins = new Map(ids.map(id => { const m2 = state.nodes.get(id)!; return [id, { x:m2.x, y:m2.y }] as [string, Pt]; }));
    ui.drag = { n, active:n, multi, sx:e.clientX, sy:e.clientY, cx:e.clientX, cy:e.clientY, start, targets, origins, selRoots,
             moved:false, dropTarget:null as string | null, dropMode:'child', dropSide:null, dropAfter:undefined, dropLine:null, alt:e.altKey, shift:e.shiftKey, cloned:false, rip:false,
             downTarget:e.target,              // where the press landed -> slow-click edits title or body
             meta: e.metaKey || e.ctrlKey,     // ⌘/Ctrl-click toggles this card in the selection
             touch: e.pointerType === 'touch',  // higher move threshold for finger taps
             imageMerge: null };
    for (const id of ids) { const m2 = state.nodes.get(id); if (m2?.el){ m2.el.style.willChange = 'transform'; m2.el.classList.add('dragging'); } }
    // Continue/commit this drag on `window`, not `el` — pointer capture (above) is still requested
    // best-effort so the dragged card's own hover/other handlers stay quiet, but capture can be
    // lost across a mid-drag re-render (paintAll/layout-snap/landing-ghost swap all run while
    // dragging). A lost capture hands pointerup to whatever's actually under the cursor instead —
    // e.g. the reparent target — whose own pointerdown-scoped listener has nothing to do with THIS
    // gesture, so the event used to vanish, leaving the landing ghost stuck on screen and the real
    // (Shift-cloned or reparented) card invisible forever. `pointercancel` (tab switch, interrupted
    // touch) commits in place too, for the same reliability reason. Listeners are added/removed per
    // gesture (not left permanently on window) so they can't double-fire alongside the ghost-card
    // flow's own window listeners in main.ts, which drives its drag through the same dragPointerMove
    // /dragPointerUp via feedDragMove/commitDrag.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    // Guard on `ui.drag.n === n` (not just truthiness): there's a single shared `ui.drag` slot, so
    // if a second card's pointerdown ever hijacks it before this gesture's up/cancel arrives (e.g.
    // true two-finger touch on two different cards at once), this stale pair must still remove
    // itself without touching the OTHER drag that's now live.
    function onMove(ev: PointerEvent): void { if (ui.drag && ui.drag.n === n) dragPointerMove(ev); }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (ui.drag && ui.drag.n === n) dragPointerUp();
    }
  });
}
// Body of a drag pointermove, operating on the live ui.drag (the node that owns the gesture is
// whatever drag.n is). Shared by the per-card handler and the ghost-card "drag a new note" flow.
function dragPointerMove(e: { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean }): void {
  const drag = ui.drag;
  if (!drag) return;
  if (state.readOnly) return;        // no moving/reparenting in read-only (click & dbl-click still work)
  // Pressing directly on a locked card: never treat it as a drag (click/slow-click select/rename
  // still resolve normally on release since drag.moved stays false) — no move, no reparent.
  if (isLockedEffective(drag.n)) return;
  drag.alt = e.altKey; drag.shift = e.shiftKey;   // Shift = clone (live — release to cancel), Alt = detach
  drag.cx = e.clientX; drag.cy = e.clientY;   // remembered for edge auto-pan and RAF flush
  const dx = (e.clientX - drag.sx)/state.view.k, dy = (e.clientY - drag.sy)/state.view.k;
  const wasMoved = drag.moved;
  if (Math.abs(dx)+Math.abs(dy) > (drag.touch ? 8 : 2)){ drag.moved = true; document.body.classList.add('grabbing'); }
  // The instant a drag begins, repaint the dragged cards so any frame child lifts OUT of its
  // frame's overflow:hidden wrapper into #world (see paintNode) — otherwise it stays clipped to
  // the frame bounds until the next drop-target change, masking it while it's dragged out.
  if (drag.moved && !wasMoved)
    for (const id of drag.targets.keys()) { const m = state.nodes.get(id); if (m) paintNode(m); }
  applyDragClone();   // Shift held -> leave a clone & drag the copy; Shift released -> undo it
  // Update world-space positions immediately (cheap) — visual render is deferred to rAF so that
  // multiple pointermove events arriving within one display frame collapse into a single paint.
  // (applyDragClone may have swapped drag.targets/origins for the clones — re-read via ui.drag.)
  applyDragTransform(ui.drag!, dx, dy);
  if (!ui.dragRAF) ui.dragRAF = requestAnimationFrame(flushDragPaint);
}
// Body of a drag pointerup: commit the move/reparent (or handle a plain click). Operates on the
// live ui.drag. Shared by the per-card handler and the ghost-card flow.
function dragPointerUp(): void {
    stopAutoPan();
    if (ui.dragRAF){ cancelAnimationFrame(ui.dragRAF); ui.dragRAF = null; }
    const drag = ui.drag;
    if (drag) {
      const n = drag.n;
      // Clear compositor transforms so paintAll()/paintNode() can commit final left/top cleanly.
      for (const id of new Set([...drag.targets.keys(), ...drag.start.keys()])){
        const m2 = state.nodes.get(id);
        if (m2?.el){ m2.el.style.transform = ''; m2.el.style.willChange = ''; m2.el.classList.remove('dragging'); }
        if (m2?.frameContentEl) m2.frameContentEl.style.transform = '';
      }
      const act = drag.active;
      // Released OUTSIDE the browser window → cancel the whole gesture, OS-style snap-back.
      // Committing here would strand the card far off-canvas (and rip-detach it), which reads
      // as "my card got deleted". Everything returns to where the drag started.
      if (drag.moved && outsideWindow(drag.cx, drag.cy)){
        cancelDragRestore();
        setStatus('Drag cancelled — released outside the window');
        return;
      }
      if (!drag.moved) {
        // A plain click (no move) = select/rename, not a drag. Clear ui.drag BEFORE selecting:
        // selectNode/toggleSel repaint via paintAll, and paintNode re-adds the `.dragging` class
        // (opacity .75) for any node still in ui.drag.targets — leaving the selected card
        // semi-transparent. Nulling here means the repaint sees no active drag.
        ui.drag = null;
        if (drag.meta) toggleSel(n.id);                 // ⌘/Ctrl-click: add/remove from selection
        else if (state.selId !== n.id || state.sel.size !== 1) {
          // clicking one card of a multi-selection reduces to it — but remember the group so a
          // double-click can fold them all (see the dblclick handler).
          if (state.sel.has(n.id) && state.sel.size > 1)
            ui.pendingGroupFold = { ids:new Set(state.sel), node:n.id, t:performance.now() };
          selectNode(n.id);
        }
        else if (!state.readOnly) {
          // a second (slow) click on the already-sole-selected card = edit in place, Finder-style.
          // Click the title -> rename; click anywhere else on the card -> edit the note.
          // Delay it so a double-click (which fires dblclick first) can cancel it and fold instead.
          clearTimeout(ui.renameTimer);
          const dt = drag.downTarget as HTMLElement | null;
          const onTitle = !!(dt && dt.closest && dt.closest('.title'));
          ui.renameTimer = setTimeout(() => onTitle ? startInlineEdit(n) : startBodyEdit(n), 260);
        }
      } else {
        // dropped onto a node? re-parent (the whole multi-selection, if that's what's dragging).
        // Alt+drop on empty canvas? detach to root. Otherwise it's just a move.
        const tgt = drag.dropTarget;
        const { cloned, targets, alt, shift, clones, dropMode, dropSide, dropAfter, selRoots, imageMerge } = drag;
        clearDropTarget();
        hideLandingGhost();
        // Null drag NOW so every paintAll/paintEdges in the commit phase sees no active drag
        // and draws all edges. (Previously edges remained hidden because drag was still set
        // when paintAll was called, and nothing repainted after drag = null.)
        ui.drag = null;
        document.body.classList.remove('grabbing');
        // Alt-drop image CARD(s) onto a plain card (imageMerge, resolved by updateDropTarget): fold
        // the image(s) into that card's body as inline markdown and delete the image card(s), rather
        // than reparenting. The decision was made during the drag (same as dropSide) so preview and
        // commit can't disagree — this supersedes any reparent/detach below.
        const mergeNode = imageMerge ? state.nodes.get(imageMerge) : null;
        if (mergeNode) {
          const folded = foldImageCardsIntoBody(mergeNode.id, selRoots);
          if (folded){
            setStatus(folded > 1 ? `Merged ${folded} images into "${mergeNode.title}"` : `Merged image into "${mergeNode.title}"`);
            paintAll(); applyLayouts(); paintAll();
            selectNode(mergeNode.id);
            scheduleSave(); commitStep();
            return;
          }
        }
        const tgtNode = tgt ? state.nodes.get(tgt)! : null;
        const effectiveParent = tgtNode
          ? (dropMode === 'sibling' ? tgtNode.parent! : tgt!)
          : null;
        if (effectiveParent && tgtNode && dropSide) {
          // land exactly where the drop preview showed (see view/layout.ts dropLanding), and
          // shift the rest of the dragged subtree(s) by the same delta so their relative
          // formation is preserved (a clone keeps where you dropped it, since that's a fresh
          // placement). `act` anchors the snap even for a multi-drag — everyone else keeps
          // their offset from it.
          if (!cloned){
            const land = dropLanding(act, tgtNode, dropMode, dropSide, dropAfter);
            const startAct = targets.get(act.id)!;
            const ddx = land.x - startAct.x, ddy = land.y - startAct.y;
            for (const [id, s] of targets){
              const m = state.nodes.get(id); if (m){ m.x = s.x + ddx; m.y = s.y + ddy; m.dirtyLayout = true; }
            }
          }
          // Re-parent every ROOT of the drag, chaining each one in right after the last so the
          // group lands as one contiguous, ordered block — sibling mode anchors on the drop
          // target, child mode appends onto the new parent. `act` goes first (it's the one the
          // landing snap above was computed for) when it's actually one of the roots. EVERY
          // root gets the SAME resolved side — a multi-drop moves the whole group to one side,
          // not each member wherever its own offset happens to derive to.
          const roots = selRoots.includes(act.id) ? [act.id, ...selRoots.filter(id => id !== act.id)] : selRoots;
          // Anchor the first insertion where the preview showed it: the resolved dropAfter
          // (careful — `null` means "front", it must NOT fall back). Sibling mode without an
          // anchor falls back to "after the hovered card"; child mode without one (free-layout
          // governor) appends.
          let afterId: string | null | undefined =
            dropMode === 'sibling' && dropAfter === undefined ? tgtNode.id : dropAfter;
          let moved = 0;
          for (const rootId of roots){
            if (reparentOnly(rootId, effectiveParent, afterId)){
              afterId = rootId; moved++;
              state.nodes.get(rootId)!.side = dropSide;
            }
          }
          const parentTitle = state.nodes.get(effectiveParent)?.title ?? 'that card';
          setStatus(dropMode === 'reorder'
            ? `Reordered "${act.title}"`
            : moved > 1
              ? `Re-parented ${moved} cards -> "${parentTitle}"`
              : `Re-parented "${act.title}" -> "${parentTitle}"`);
        } else {
          // snap onto the grid: align the dragged node, shift the rest of its subtree by the same
          // delta so relative layout is preserved. A card inside a frame snaps RELATIVE to the
          // frame's origin (its children live in the frame's coordinate space); anyone else snaps
          // to the world grid.
          const fp = act.parent ? state.nodes.get(act.parent) : null;
          const inFrame = !!(fp && isFrame(fp));
          const ax = inFrame ? fp!.x : 0, ay = inFrame ? fp!.y : 0;
          const g = gridSnap();
          const ddx = (Math.round((act.x - ax) / g) * g + ax) - act.x;
          const ddy = (Math.round((act.y - ay) / g) * g + ay) - act.y;
          for (const id of targets.keys()){
            const m = state.nodes.get(id); if (!m) continue;
            m.x += ddx; m.y += ddy; m.dirtyLayout = true;
          }
          // Resolve each dragged ROOT this gesture pulls off its parent — a whole multi-selection
          // detaches together, not just the anchor. A root inside a frame detaches ONLY by leaving
          // that frame's box (its centre outside the rectangle) — never by distance or Alt while
          // still inside it. Any other root detaches on Alt or once its own distanceRip fires (per
          // root, since each measures against its own parent — matches the updateRip preview).
          let detached = 0, leftFrame = 0;
          for (const rootId of selRoots){
            const r = state.nodes.get(rootId);
            if (!r?.parent) continue;
            const rp = state.nodes.get(r.parent);
            const rInFrame = !!(rp && isFrame(rp)) && !isAnnotation(r);   // annotations detach by rip only
            const rOut = rInFrame && !centreInFrame(r, rp!);
            if (!shift && (rInFrame ? rOut : (alt || distanceRip(r)))){
              r.parent = null; r.side = undefined;   // a root has no side / frame host
              detached++; if (rOut) leftFrame++;
            } else if (rp && isManagedLayout(rp)){
              // A root NOT detached is a plain reposition. For a MANAGED parent (line/fan) refresh its
              // stored side from the new position (same rule as the load backfill) so its edge/bucket
              // still tracks visually; a FREE parent never reflows, so its side is just a label — keep it.
              r.side = deriveSide(rp, r);
            }
          }
          if (detached) setStatus(
            detached > 1 ? `Detached ${detached} cards`
              : leftFrame ? `"${act.title}" left the frame`
              : `"${act.title}" is now a root`);
          // Refresh sibling order from the dropped positions (the ONLY position-based reorder).
          // The drop-target branch above skips this: there the previewed kidOrder was just set
          // explicitly via insertedKidOrder, and re-sorting from positions is exactly the
          // preview/commit disagreement being eliminated.
          for (const id of targets.keys()) touch(state.nodes.get(id)?.parent);   // kidOrder pre-images
          reorderDraggedParents(targets.keys());
        }
        // Paint first so freshly-created clone cards have real DOM heights before applyLayouts
        // measures them — otherwise a chain/fan of clones lays out on the 64px height fallback
        // (only the first lands right). Mirrors the duplicate path: paint -> layout -> paint.
        paintAll();
        applyLayouts(); paintAll();   // re-snap any dragged child back into its parent's layout
        // select the new clone(s) you just dragged out
        if (cloned){ if (clones && clones.length > 1) setSelectionSet(clones.map(c => c.id)); else selectNode(act.id); }
        scheduleSave();
        commitStep();   // the whole gesture (move/reparent/clone) = ONE undo step
        return;   // drag/grabbing already cleared above
      }
    }
    ui.drag = null;
    document.body.classList.remove('grabbing');
    commitStep();   // plain click / unmoved drag: nothing changed → step is discarded
}
// Begin a programmatic drag of an already-created node from a screen point, as if the user had
// pressed down on it there. Used by the ghost-card "drag a new note" flow so a freshly-made card
// rides the cursor through the exact same move/reparent/landing-ghost machinery as an existing
// card. `moved` starts true so even a release without motion commits the placement.
export function startNodeDrag(n: MindNode, clientX: number, clientY: number): void {
  const start = new Map<string, Pt>([[n.id, { x:n.x, y:n.y }]]);
  const targets = new Map<string, Pt>([[n.id, { x:n.x, y:n.y }]]);
  const origins = new Map<string, Pt>([[n.id, { x:n.x, y:n.y }]]);
  ui.drag = { n, active:n, multi:false, sx:clientX, sy:clientY, cx:clientX, cy:clientY,
    start, targets, origins, selRoots:[n.id], moved:true, dropTarget:null, dropMode:'child', dropSide:null, dropAfter:undefined, dropLine:null,
    alt:false, shift:false, cloned:false, rip:false, downTarget:null, meta:false, touch:false, imageMerge:null };
  if (n.el){ n.el.style.willChange = 'transform'; n.el.classList.add('dragging'); }
  document.body.classList.add('grabbing');
}
// Forward a move/up from an external (ghost-card) drag into the shared drag machinery.
export function feedDragMove(clientX: number, clientY: number): void {
  dragPointerMove({ clientX, clientY, altKey:false, shiftKey:false });
}
export function commitDrag(): void { dragPointerUp(); }
// Abort the live drag with no commit: clear the landing-ghost preview, drop highlight, and any
// compositor transforms, then forget the gesture. The caller is responsible for the dragged node.
export function abortDrag(): void {
  stopAutoPan();
  if (ui.dragRAF){ cancelAnimationFrame(ui.dragRAF); ui.dragRAF = null; }
  const drag = ui.drag;
  if (!drag) return;
  clearDropTarget();
  hideLandingGhost();
  for (const id of new Set([...drag.targets.keys(), ...drag.start.keys()])){
    const m = state.nodes.get(id);
    if (m?.el){ m.el.style.transform = ''; m.el.style.willChange = ''; m.el.classList.remove('dragging'); }
    if (m?.frameContentEl) m.frameContentEl.style.transform = '';
  }
  ui.drag = null;
  document.body.classList.remove('grabbing');
}
// Cancel the live drag AND put everything back where the gesture started, OS-style snap-back:
// Shift-clones are removed (they never existed), every dragged card returns to its start
// position, and the pending undo step nets out. Shared by the released-outside-the-window
// cancel and the ⌥-drag file-export takeover (clipboard.ts).
export function cancelDragRestore(): void {
  const drag = ui.drag;
  if (!drag) return;
  for (const clone of (drag.cloned && drag.clones) || []){
    state.nodes.delete(clone.id); clone.el?.remove();
  }
  for (const [id, s] of drag.start){
    const m = state.nodes.get(id); if (m){ m.x = s.x; m.y = s.y; m.dirtyLayout = true; }
  }
  abortDrag();
  applyLayouts(); paintAll();   // no new cards to measure — one layout + paint suffices
  commitStep();   // nothing changed → the pending step nets out and is discarded
}
// Bring the Shift-clone state in line with the live `drag.shift` flag. Shift down (and moved past
// the threshold) leaves a clone of each dragged card at its start spot and drags the COPIES away;
// Shift released before drop deletes the clones and reverts to plain-moving the originals.
function applyDragClone(): void {
  const drag = ui.drag;
  if (!drag || !drag.moved) return;
  if (drag.shift && !drag.cloned){
    drag.cloned = true;
    for (const [id, s] of drag.start){             // pin the original subtree(s) back to start
      const m = state.nodes.get(id); if (m){ m.x = s.x; m.y = s.y; m.dirtyLayout = false; }
      // revert their compositor transforms — `drag.active` is about to switch to the clone
      if (m?.el) { m.el.style.transform = ''; }
      if (m?.frameContentEl) { m.frameContentEl.style.transform = ''; }
    }
    // clone each dragged ROOT (just the card, not its subtree) at its own start spot
    const rootIds = drag.selRoots;
    const clones = rootIds.map(id => leaveClone(state.nodes.get(id)!, drag!.start.get(id)!));
    drag.clones = clones;
    drag.active = clones[0];                        // representative (drives the landing snap)
    drag.selRoots = clones.map(c => c.id);           // reparent the clones on drop, not the originals
    drag.targets = new Map(rootIds.map((id, i) => { const sp = drag!.start.get(id)!; return [clones[i].id, { x:sp.x, y:sp.y }] as [string, Pt]; }));
    drag.origins = new Map([...drag.targets].map(([id, s]) => [id, { x:s.x, y:s.y }] as [string, Pt]));
    paintAll();                                    // render + bind the new clone nodes
  } else if (!drag.shift && drag.cloned){
    for (const clone of (drag.clones || [])){
      if (clone.el){ clone.el.style.transform = ''; clone.el.style.willChange = ''; }
      if (clone.frameContentEl){ clone.frameContentEl.style.transform = ''; }
      state.nodes.delete(clone.id); clone.el?.remove();   // drop the clones we made
    }
    drag.clones = null;
    drag.cloned = false;
    drag.active = drag.n;                           // back to dragging the original
    drag.selRoots = trueRoots(drag.multi ? [...state.sel] : [drag.n.id]);   // clones are gone — back to the originals' roots
    drag.targets = new Map([...drag.start].map(([id, s]) => [id, { x:s.x, y:s.y }] as [string, Pt]));
    drag.origins = new Map([...drag.start]);         // restore origins for the original subtree
    setStatus(`Duplication cancelled — moving "${drag.n.title}"`);
    paintAll();
  }
}
// Snap the dragged subtree (and drop-target / edges) to the current cursor without a pointer move —
// used when a modifier toggles mid-drag, so the result is reflected instantly while the mouse is still.
function dragFollow(): void {
  const drag = ui.drag;
  if (!drag) return;
  applyDragTransform(drag, (drag.cx - drag.sx)/state.view.k, (drag.cy - drag.sy)/state.view.k);
  if (drag.moved) updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
  paintEdges();   // modifier changed mid-drag — always repaint (infrequent)
}
// Update the detach preview the instant Alt is pressed/released mid-drag, even if the pointer
// isn't moving: repaint the dragged subtree (its colour previews the detached result) and the edges.
function paintDetachPreview(): void {
  if (ui.drag) for (const id of subtreeIds(ui.drag.active.id)){ const m = state.nodes.get(id); if (m) paintNode(m); }
  paintEdges();
}
window.addEventListener('keydown', (e) => {
  const drag = ui.drag;
  if (!drag) return;
  if (e.key === 'Alt'){ drag.alt = true;  paintDetachPreview(); }
  if (e.key === 'Shift'){ drag.shift = true;  applyDragClone(); dragFollow(); }
});
window.addEventListener('keyup',   (e) => {
  const drag = ui.drag;
  if (!drag) return;
  if (e.key === 'Alt'){ drag.alt = false; paintDetachPreview(); }
  if (e.key === 'Shift'){ drag.shift = false; applyDragClone(); dragFollow(); }
});

// ---------- reconnect (re-parent by drag-and-drop) ----------
// Half-width/half-height fraction (normalized, so a wide short card doesn't skew toward
// "always horizontal") that counts as "dropped near the centre" -> sibling-insert mode.
// Outside that square it's a child-of-this-side drop, attaching on whichever edge the drop
// point is closest to (edgeFromUV below); the resolved side is stored on ui.drag.dropSide and
// used for both the ghost preview and the commit, so they can never disagree.
const CENTER_FRAC = 0.45;

// Dominant axis + sign of a box-relative offset -> which edge it's closest to.
function edgeFromUV(u: number, v: number): LayoutSide {
  return Math.abs(u) >= Math.abs(v) ? (u >= 0 ? 'right' : 'left') : (v >= 0 ? 'down' : 'up');
}

function updateDropTarget(dragged: MindNode, e: { clientX: number; clientY: number }): void {
  // Everything currently being dragged — dragged's own subtree for a single drag, or the whole
  // multi-selection's subtrees. Never a valid drop target (self, sibling-in-tow, or descendant).
  const sub = new Set(ui.drag ? ui.drag.targets.keys() : subtreeIds(dragged.id));
  // Geometric hit test in world space — no layout read, no elementsFromPoint.
  // stage is position:fixed; inset:0 so its origin is always (0,0).
  const wx = (e.clientX - state.view.x) / state.view.k;
  const wy = (e.clientY - state.view.y) / state.view.k;
  let hovered: string | null = null;
  let hoveredCenter = false;
  let hoveredEdge: LayoutSide = 'right';
  // Plain CARDS win over frames: a frame's box encloses its children, so first-hit iteration order
  // would let the container shadow the card actually under the cursor (making reparent-onto-a-card
  // inside a frame unreachable). Among frames, the INNERMOST (deepest-nested) wins, so nested
  // frames stay reachable too — same rule as the pointerdown retarget (innermostFrameAt).
  let cardHit: MindNode | null = null;
  let frameHit: MindNode | null = null, frameHitDepth = -1;
  for (const [id, m] of state.nodes) {
    if (isHidden(m) || sub.has(id)) continue;
    const w = nodeW(m), h = nodeH(m);
    if (!(wx >= m.x && wx <= m.x + w && wy >= m.y && wy <= m.y + h)) continue;
    if (isFrame(m)) {
      const d = ancestorDepth(m);
      if (d > frameHitDepth) { frameHitDepth = d; frameHit = m; }
    } else if (!cardHit) { cardHit = m; }
  }
  const hitNode = cardHit ?? frameHit;
  if (hitNode) {
    hovered = hitNode.id;
    const w = nodeW(hitNode), h = nodeH(hitNode);
    const u = (wx - (hitNode.x + w/2)) / (w/2);
    const v = (wy - (hitNode.y + h/2)) / (h/2);
    hoveredCenter = Math.max(Math.abs(u), Math.abs(v)) <= CENTER_FRAC;
    hoveredEdge = edgeFromUV(u, v);
  }
  clearDropTarget();
  const drag = ui.drag;
  // Alt-dragging image CARD(s): the drop only ever FOLDS the image(s) into a plain body card — no
  // reparent, sibling, or reorder is possible (see request). Handled as its own branch below.
  const imgDrag = !!drag && !!drag.alt && drag.selRoots.length > 0 && drag.selRoots.every(id => isImageCard(state.nodes.get(id)));
  let target: string | null = null;
  let mode: 'child' | 'sibling' | 'reorder' = 'child';
  let side: LayoutSide | null = null;
  let after: string | null | undefined = undefined;   // insertion anchor (sibling/reorder)
  let line: Seg | null = null;   // reorder gap indicator
  let mergeTarget: string | null = null;   // image-fold target card (imgDrag over a plain card)
  if (hovered && sub.has(hovered)){
    setStatus(`Can't parent "${dragged.title}" onto its own child/descendant`);
  } else if (imgDrag) {
    // Only a hovered plain body card is a valid fold target (not another image, a frame, or an
    // annotation). No target/side/line set → the normal ghost/bar/edge previews all stand down.
    if (hovered) {
      const hn = state.nodes.get(hovered)!;
      if (!isImageCard(hn) && !isFrame(hn) && !isAnnotation(hn) && !isLockedEffective(hn)) mergeTarget = hovered;
    }
  } else if (isAnnotation(dragged)) {
    // An annotation can't be reordered and never adopts siblings — dragging one only ever RE-PARENTS
    // it, to any non-annotation node (cards, frames, AND images). No sibling/reorder preview; the
    // candidate parent is just highlighted (dashed ghost outline) in the preview section below.
    if (hovered) {
      const hn = state.nodes.get(hovered)!;
      if (!isAnnotation(hn)) { target = hovered; mode = 'child'; side = hoveredEdge || 'down'; }
    }
  } else if (hovered && isLockedEffective(state.nodes.get(hovered)!)) {
    // A locked card (or a locked descendant) is never a valid drop target — no child, sibling, or
    // reorder preview. `target` stays null, so the commit falls through to a plain reposition
    // (dragPointerUp's grid-snap branch) rather than reparenting onto/near it.
    setStatus('Locked — can’t drop there');
  } else if (hovered) {
    const hoveredNode = state.nodes.get(hovered)!;
    const pf = hoveredNode.parent ? state.nodes.get(hoveredNode.parent) : null;
    if (frameFlow(hoveredNode)) {
      // The FLOW frame's own (empty) area → insert into the flow at the slot under the cursor,
      // previewed with an insertion bar (like line layout). Covers dropping an external card in
      // AND reordering a card already inside.
      target = hovered; mode = 'child'; side = 'down';
      ({ afterId: after, line } = flowReorderTarget(hoveredNode, dragged));
    } else if (isFrame(hoveredNode)) {
      // FREE frame: adopt the card wherever it's released inside the box (dropLanding's frame branch).
      target = hovered; mode = 'child'; side = 'down';
    } else if (pf && frameFlow(pf)) {
      // A card inside a FLOW frame. Dead-CENTRE nests the dragged card as a CHILD of it (a grand-
      // child of the frame), exactly like dropping onto any other card — this is what makes a frame
      // child reparentable at all. EVERYWHERE ELSE on the card (and the gaps) inserts into the flow
      // next to it, previewed with the bar: flow children are a flat flowed list and the physical
      // gap between them is much narrower than a card's edge zone, so the surrounding-the-centre
      // area must stay flow-insert or the bar would be nearly unreachable during a reorder.
      if (hoveredCenter) {
        target = hovered; mode = 'child'; side = hoveredEdge;
      } else {
        target = pf.id; mode = 'child'; side = 'down';
        ({ afterId: after, line } = flowReorderTarget(pf, dragged));
      }
    } else {
      // Centre zone + hovered card has a parent -> sibling drop (adopt hovered's parent, landing
      // on the same side hovered already occupies — copy ITS stored side, not the drop point).
      if (hoveredCenter && hoveredNode.parent) {
        const sibParent = hoveredNode.parent;
        if (sibParent !== dragged.id && !sub.has(sibParent)) {
          const parentNode = state.nodes.get(sibParent)!;
          target = hovered; mode = 'sibling'; side = sideOf(parentNode, hoveredNode);
          // hovering the near half inserts BEFORE the card, the far half AFTER; the gap line previews
          // the slot among the new siblings. (Not reached for flow frames — handled above.)
          ({ afterId: after, line } = reorderTarget(parentNode, dragged, side));
        }
      }
      // Edge zone (or no valid sibling target) -> child-of-hovered, attaching on whichever side
      // the drop point sits near. Image/annotation are leaves — they never adopt children, so
      // they're not valid child-drop targets (sibling-mode above still is).
      if (!target && !isLeafType(hoveredNode)) {
        target = hovered; side = hoveredEdge;
        if (isManagedLayout(hoveredNode) && !frameFlow(hoveredNode))
          ({ afterId: after, line } = reorderTarget(hoveredNode, dragged, side));
      }
    }
  } else if (drag && drag.selRoots.length === 1 && !drag.alt && dragged.parent) {
    // No card hovered: if the dragged card is sliding along its OWN parent's line/fan sibling
    // band, preview the in-parent REORDER — an insertion bar marks the sibling gap the card
    // would slot into, so "drop it between two siblings" is no longer guesswork. Single-root
    // drags only (a multi-drag keeps the plain-reposition fallback) and never while Alt
    // (detach) is held. The `near` gate is what keeps rip-detach reachable: close to the band a
    // release means "re-slot"; pulled away from it, today's rip behaviour returns.
    const parent = state.nodes.get(dragged.parent);
    // A flow frame is box-flowed (no side-based in-parent reorder bar). Sliding its child just
    // repositions it; the release reseeds the flow order from the dropped positions.
    if (parent && isManagedLayout(parent) && !frameFlow(parent)) {
      let rt = reorderTarget(parent, dragged);
      // Far along a wide fan, deriveSide flips to the (usually empty) perpendicular bucket and
      // the first/last slots become unreachable — retry with the card's STORED side so sliding
      // to the ends of its own band keeps previewing, while genuine cross-side moves (which
      // pass the near gate on the derived side's band) still work.
      if (!rt.near && dragged.side && dragged.side !== rt.side)
        rt = reorderTarget(parent, dragged, dragged.side);
      if (rt.near) {
        target = parent.id; mode = 'reorder'; side = rt.side; after = rt.afterId; line = rt.line;
      }
    }
  }
  // An inheriting card's colour depends on its parent chain (effectiveColor), and while poised
  // over a valid target that chain is about to change — repaint the dragged subtree so an
  // inheriting card previews the NEW parent's colour live, instead of only updating on drop.
  // A REORDER never changes the parent chain, so for colour purposes it counts as no target.
  const colorKey = (t: string | null, m: string): string => (!t || m === 'reorder') ? '' : m + ':' + t;
  const changed = !!drag && colorKey(drag.dropTarget, drag.dropMode) !== colorKey(target, mode);
  const prevLine = drag?.dropLine ?? null;
  if (drag) { drag.dropTarget = target; drag.dropMode = mode; drag.dropSide = side; drag.dropAfter = after; drag.dropLine = line; drag.imageMerge = mergeTarget; }
  if (changed) for (const id of sub) { const m = state.nodes.get(id); if (m) paintNode(m); }
  if (mergeTarget) {
    // Alt-dragging image card(s) over a plain card: a dashed outline on the target is the whole
    // affordance — no landing ghost, insertion bar, or reparent edge (target/side stayed null).
    state.nodes.get(mergeTarget)!.el?.classList.add('drop-merge');
    hideLandingGhost();
  } else if (target && side && isAnnotation(dragged)) {
    // Annotation reparent: only a dashed ghost-colour outline on the candidate parent — no landing
    // ghost, no insertion bar, no reparent edge (see edges.ts previewReparent).
    state.nodes.get(target)!.el?.classList.add('anno-drop-target');
    hideLandingGhost();
  } else if (target && side) {
    const targetNode = state.nodes.get(target)!;
    // Highlight the target — EXCEPT a flow frame, which shows the insertion bar (below) instead of
    // the frame-outline highlight (like line-layout reorder).
    if (mode !== 'reorder' && !frameFlow(targetNode)) targetNode.el?.classList.add(mode === 'sibling' ? 'drop-sibling' : 'drop-target');
    // One preview at a time, never both: joining/reordering a managed branch with existing
    // children shows ONLY the insertion bar in the sibling gap (the dragged subtree's edge is
    // dropped by paintEdges via drag.dropTarget, and the dashed would-be-edge preview stands
    // down via drag.dropLine); everything else shows ONLY the landing-ghost card. The dragged
    // cards themselves stay visible under the cursor throughout.
    if (line) {
      // Runs on every pointermove — skip the DOM writes while the segment stays in the same gap
      // (the bar marks the SIBLINGS' gap, which only moves when the anchor flips). But NOT while
      // the bar is hidden: alternating with the landing ghost (edge↔centre zones) hides it, and
      // an unchanged segment must still bring it back.
      const barShowing = _insertLine && _insertLine.style.display !== 'none';
      if (!(barShowing && prevLine && prevLine.x0 === line.x0 && prevLine.y0 === line.y0 && prevLine.x1 === line.x1 && prevLine.y1 === line.y1))
        showInsertLine(line);
    } else if (isFrame(targetNode)) {
      // Frame drop-in lands the card exactly where it's released, so it's already under the cursor —
      // no ghost needed; the frame's own .drop-target highlight is the affordance.
      hideLandingGhost();
    } else {
      const land = dropLanding(dragged, targetNode, mode, side, after);
      showLandingGhost(land.x, land.y, nodeH(dragged));
    }
  } else {
    hideLandingGhost();
  }
}
function clearDropTarget(): void {
  document.querySelectorAll('.node.drop-target, .node.drop-sibling, .node.anno-drop-target, .node.drop-merge')
    .forEach(el => el.classList.remove('drop-target', 'drop-sibling', 'anno-drop-target', 'drop-merge'));
}
// Mutates `child`'s parent + the new parent's kidOrder only — no layout/paint/status. Callers
// batch layout/paint once for the whole dragged group (see dragPointerUp) rather than per root.
// `afterId` anchors a sibling/reorder-mode drop: the child slots in right after that sibling in
// the parent's order (`null` = at the front), matching the preview that triggered the mode (see
// dropLanding). Re-setting the SAME parent (a reorder) is fine — only kidOrder changes.
// Returns whether the reparent actually happened, so callers can count/chain successful ones.
// Exported: the outline's "Move to…" picker reuses it (features/outline.ts).
export function reparentOnly(childId: string, newParentId: string, afterId?: string | null): boolean {
  if (state.readOnly) return false;
  const child = state.nodes.get(childId);
  const newParent = state.nodes.get(newParentId);
  if (!child || !newParent || childId === newParentId) return false;
  if (isLockedEffective(child) || isLockedEffective(newParent)) return false;   // locked: no move in or out
  if (isAncestor(childId, newParentId)) return false; // would create a cycle
  touch(childId, child.parent, newParentId);          // pre-images incl. both parents' kidOrder
  child.parent = newParentId;
  child.dirtyLayout = true;
  if (isManagedLayout(newParent))
    newParent.kidOrder = insertedKidOrder(newParent, childId, afterId);
  return true;
}
