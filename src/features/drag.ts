// ---------- node dragging & reparent-by-drop ----------
// Per-node pointer gestures: drag moves the whole subtree (or the multi-selection, as one group);
// Shift clones while dragging, Alt detaches to root, dropping onto another card reparents —
// EVERY true root of the drag (see selRoots/trueRoots), not just the card that was pressed, so a
// multi-selected group can be dropped onto a new parent/side together in one gesture. Edge
// auto-pan keeps the dragged subtree glued under the cursor while the view scrolls. All transient
// drag state lives in `ui.drag`. Importing this module registers the global Alt/Shift modifier
// listeners; bindNodeDrag is called by the render core (nodeEl) for each card.
import { state, stage, world, setStatus, type MindNode, type LayoutSide } from '../core/state.js';
import { isHidden, isAncestor } from '../utils/model.js';
import { applyLayouts, reorderDraggedParents, dropLanding, isManagedLayout, insertedKidOrder, sideOf, deriveSide, reorderTarget } from '../view/layout.js';
import { cancelViewAnim, applyView } from '../view/camera.js';
import { scheduleSave } from '../data/persistence.js';
import { ui, type Pt, type Seg, type Drag } from '../core/ui-state.js';
import { paintEdges } from '../view/edges.js';
import { NODE_W, nodeH, paintAll, paintNode, selectNode, setSelectionSet, toggleSel,
         subtreeIds, foldNodeOrGroup } from '../main.js';
import { startInlineEdit, startBodyEdit, endInlineEdit, endBodyEdit } from './inline-edit.js';
import { leaveClone } from './crud.js';
import { touch, commitStep } from './history.js';

// The #editor panel is a fixed element in the shell; cache the handle so the per-frame
// auto-pan loop doesn't re-query it on every rAF tick.
let _editor: HTMLElement | null = null;
function editorEl(): HTMLElement | null { return _editor ??= document.getElementById('editor'); }

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

const RIP_THRESHOLD = 200; // screen-space px dragged from THIS gesture's start before edge hides/detaches on drop

// Recompute whether the dragged card has been pulled past the rip threshold DURING THIS DRAG —
// measured from where the gesture started (drag.start), not from the parent's position. Using the
// parent as the reference meant a child already sitting far from its parent (a common layout,
// e.g. after a previous free-form drag) would read as "ripped" the instant you touched it, with
// no actual pull yet. Must be called before paintEdges() so the hidden-edge rendering reads the
// latest state.
function updateRip(drag: Drag): void {
  if (drag.multi || drag.cloned || !drag.moved) return;
  const act = drag.active;
  let rip = false;
  // A live in-parent reorder preview overrides rip: while the card slides along its sibling
  // band (updateDropTarget ran just before us), releasing means "re-slot", never "detach".
  const reordering = drag.dropMode === 'reorder' && !!drag.dropTarget;
  if (act.parent && !reordering) {
    const origin = drag.start.get(act.id);
    if (origin) {
      const dx = (act.x - origin.x) * state.view.k;
      const dy = (act.y - origin.y) * state.view.k;
      rip = Math.hypot(dx, dy) > RIP_THRESHOLD;
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
    if (m.el) { const orig = drag.origins.get(id); if (orig) m.el.style.transform = `translate(${m.x-orig.x}px,${m.y-orig.y}px)`; }
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
  // Available canvas = the stage minus the toolbar (above it) and the edit panel (to its right).
  // Panning kicks in as the cursor reaches those obstructions, so you can drag onto / past them.
  const r = stage.getBoundingClientRect();
  const ed = editorEl();
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
    applyDragTransform(drag, (drag.cx - drag.sx) / state.view.k, (drag.cy - drag.sy) / state.view.k);
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
    updateRip(drag);
    paintEdges();   // redraw edges every auto-pan frame so they follow the moving nodes
  }
  ui.autoPanRAF = requestAnimationFrame(autoPanStep);
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
    const tgt = e.target as HTMLElement;
    if (tgt.classList.contains('addnote')) return;
    if (tgt.closest('a.lk, input.taskbox')) { e.stopPropagation(); return; }  // let links/checkboxes click, not drag
    // Close an editor open on a DIFFERENT card (tap-outside on touch where blur may not fire)
    if (ui.inlineEdit && ui.inlineEdit.id !== n.id) endInlineEdit();
    if (ui.bodyEdit   && ui.bodyEdit.id   !== n.id) endBodyEdit();
    // while this card's title/body is being edited, let clicks place the caret — don't start a drag
    if ((ui.inlineEdit && ui.inlineEdit.id === n.id) || (ui.bodyEdit && ui.bodyEdit.id === n.id)) { e.stopPropagation(); return; }
    clearTimeout(ui.renameTimer);   // any fresh interaction cancels a pending slow-click rename
    e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch { /* no active pointer (e.g. synthetic) */ }
    // Dragging a card that's part of a multi-selection moves the WHOLE selection at once;
    // otherwise just this card's subtree. `active` is the node dragged/dropped; `targets`
    // are the nodes that follow the cursor (or, after a Shift-clone, just the clone).
    const multi = state.sel.has(n.id) && state.sel.size > 1;
    const rootIds = multi ? [...state.sel] : [n.id];
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
             touch: e.pointerType === 'touch' }; // higher move threshold for finger taps
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
  drag.alt = e.altKey; drag.shift = e.shiftKey;   // Shift = clone (live — release to cancel), Alt = detach
  drag.cx = e.clientX; drag.cy = e.clientY;   // remembered for edge auto-pan and RAF flush
  const dx = (e.clientX - drag.sx)/state.view.k, dy = (e.clientY - drag.sy)/state.view.k;
  if (Math.abs(dx)+Math.abs(dy) > (drag.touch ? 8 : 2)){ drag.moved = true; document.body.classList.add('grabbing'); }
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
      }
      const act = drag.active;
      if (!drag.moved) {
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
        const { cloned, targets, alt, shift, clones, rip, dropMode, dropSide, dropAfter, selRoots } = drag;
        clearDropTarget();
        hideLandingGhost();
        // Null drag NOW so every paintAll/paintEdges in the commit phase sees no active drag
        // and draws all edges. (Previously edges remained hidden because drag was still set
        // when paintAll was called, and nothing repainted after drag = null.)
        ui.drag = null;
        document.body.classList.remove('grabbing');
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
          // snap onto the 20px grid: align the dragged node, shift the rest of its
          // subtree by the same delta so relative layout is preserved.
          const GRID = 20;
          const ddx = Math.round(act.x / GRID) * GRID - act.x;
          const ddy = Math.round(act.y / GRID) * GRID - act.y;
          for (const id of targets.keys()){
            const m = state.nodes.get(id); if (!m) continue;
            m.x += ddx; m.y += ddy; m.dirtyLayout = true;
          }
          if ((alt || rip) && !shift && act.parent) {
            act.parent = null;
            act.side = undefined;   // a root has no side
            setStatus(`"${act.title}" is now a root`);
          } else {
            // No drop target and no detach — a plain reposition. For a MANAGED parent (line/fan)
            // refresh each root's stored side from its new position (same rule as the load
            // backfill) so its edge/bucket still tracks visually. A FREE parent never reflows its
            // children, so the side is purely a stored label — keep whatever it already was
            // rather than relabeling it from wherever the drag happened to leave the card.
            for (const rootId of selRoots){
              const r = state.nodes.get(rootId);
              if (!r?.parent) continue;
              const p = state.nodes.get(r.parent);
              if (p && isManagedLayout(p)) r.side = deriveSide(p, r);
            }
          }
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
    alt:false, shift:false, cloned:false, rip:false, downTarget:null, meta:false, touch:false };
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
  }
  ui.drag = null;
  document.body.classList.remove('grabbing');
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
  for (const [id, m] of state.nodes) {
    if (isHidden(m) || sub.has(id)) continue;
    const h = nodeH(m);
    if (wx >= m.x && wx <= m.x + NODE_W && wy >= m.y && wy <= m.y + h){
      hovered = id;
      const u = (wx - (m.x + NODE_W/2)) / (NODE_W/2);
      const v = (wy - (m.y + h/2)) / (h/2);
      hoveredCenter = Math.max(Math.abs(u), Math.abs(v)) <= CENTER_FRAC;
      hoveredEdge = edgeFromUV(u, v);
      break;
    }
  }
  clearDropTarget();
  const drag = ui.drag;
  let target: string | null = null;
  let mode: 'child' | 'sibling' | 'reorder' = 'child';
  let side: LayoutSide | null = null;
  let after: string | null | undefined = undefined;   // insertion anchor (sibling/reorder)
  let line: Seg | null = null;   // reorder gap indicator
  if (hovered && sub.has(hovered)){
    setStatus(`Can't parent "${dragged.title}" onto its own child/descendant`);
  } else if (hovered) {
    const hoveredNode = state.nodes.get(hovered)!;
    // Centre zone + hovered card has a parent -> sibling drop (adopt hovered's parent, landing
    // on the same side hovered already occupies — copy ITS stored side, not the drop point).
    if (hoveredCenter && hoveredNode.parent) {
      const sibParent = hoveredNode.parent;
      // Valid as long as it wouldn't re-parent onto self or create a cycle
      if (sibParent !== dragged.id && !sub.has(sibParent)) {
        const parentNode = state.nodes.get(sibParent)!;
        target = hovered;
        mode = 'sibling';
        side = sideOf(parentNode, hoveredNode);
        // Anchor by the dragged card's midpoint vs the siblings' boxes: hovering the near half
        // of the card inserts BEFORE it, the far half AFTER — not always-after as before. The
        // gap line previews the slot among the new siblings, same as an in-parent reorder.
        ({ afterId: after, line } = reorderTarget(parentNode, dragged, side));
      }
    }
    // Edge zone (or no valid sibling target) -> child-of-hovered, attaching on whichever side
    // the drop point sits near. Allowed even when hovered is already this node's parent — that
    // re-sides the child instead of being a no-op, since the drop point may be near a
    // different edge than the one it currently occupies.
    if (!target) {
      target = hovered; side = hoveredEdge;
      // Joining a MANAGED branch that already has children on that side: anchor the insertion
      // by the dragged card's position among them (instead of always appending) and preview the
      // slot with the same gap line as a reorder — it's the same "where among the siblings"
      // question, just without leaving the parent first.
      if (isManagedLayout(hoveredNode))
        ({ afterId: after, line } = reorderTarget(hoveredNode, dragged, side));
    }
  } else if (drag && drag.selRoots.length === 1 && !drag.alt && dragged.parent) {
    // No card hovered: if the dragged card is sliding along its OWN parent's line/fan sibling
    // band, preview the in-parent REORDER — an insertion bar marks the sibling gap the card
    // would slot into, so "drop it between two siblings" is no longer guesswork. Single-root
    // drags only (a multi-drag keeps the plain-reposition fallback) and never while Alt
    // (detach) is held. The `near` gate is what keeps rip-detach reachable: close to the band a
    // release means "re-slot"; pulled away from it, today's rip behaviour returns.
    const parent = state.nodes.get(dragged.parent);
    if (parent && isManagedLayout(parent)) {
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
  if (drag) { drag.dropTarget = target; drag.dropMode = mode; drag.dropSide = side; drag.dropAfter = after; drag.dropLine = line; }
  if (changed) for (const id of sub) { const m = state.nodes.get(id); if (m) paintNode(m); }
  if (target && side) {
    const targetNode = state.nodes.get(target)!;
    if (mode !== 'reorder') targetNode.el?.classList.add(mode === 'sibling' ? 'drop-sibling' : 'drop-target');
    // One preview at a time, never both: joining/reordering a managed branch with existing
    // children shows ONLY the insertion bar in the sibling gap (the dragged subtree's edge is
    // dropped by paintEdges via drag.dropTarget, and the dashed would-be-edge preview stands
    // down via drag.dropLine); everything else shows ONLY the landing-ghost card. The dragged
    // cards themselves stay visible under the cursor throughout.
    if (line) {
      // Runs on every pointermove — skip the DOM writes while the segment stays in the same gap
      // (the bar marks the SIBLINGS' gap, which only moves when the anchor flips).
      if (!(prevLine && prevLine.x0 === line.x0 && prevLine.y0 === line.y0 && prevLine.x1 === line.x1 && prevLine.y1 === line.y1))
        showInsertLine(line);
    } else {
      const land = dropLanding(dragged, targetNode, mode, side, after);
      showLandingGhost(land.x, land.y, nodeH(dragged));
    }
  } else {
    hideLandingGhost();
  }
}
function clearDropTarget(): void {
  document.querySelectorAll('.node.drop-target, .node.drop-sibling')
    .forEach(el => el.classList.remove('drop-target', 'drop-sibling'));
}
// Mutates `child`'s parent + the new parent's kidOrder only — no layout/paint/status. Callers
// batch layout/paint once for the whole dragged group (see dragPointerUp) rather than per root.
// `afterId` anchors a sibling/reorder-mode drop: the child slots in right after that sibling in
// the parent's order (`null` = at the front), matching the preview that triggered the mode (see
// dropLanding). Re-setting the SAME parent (a reorder) is fine — only kidOrder changes.
// Returns whether the reparent actually happened, so callers can count/chain successful ones.
function reparentOnly(childId: string, newParentId: string, afterId?: string | null): boolean {
  if (state.readOnly) return false;
  const child = state.nodes.get(childId);
  if (!child || childId === newParentId) return false;
  if (isAncestor(childId, newParentId)) return false; // would create a cycle
  touch(childId, child.parent, newParentId);          // pre-images incl. both parents' kidOrder
  child.parent = newParentId;
  child.dirtyLayout = true;
  const newParent = state.nodes.get(newParentId)!;
  if (isManagedLayout(newParent))
    newParent.kidOrder = insertedKidOrder(newParent, childId, afterId);
  return true;
}
