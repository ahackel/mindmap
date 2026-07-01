// ---------- node dragging & reparent-by-drop ----------
// Per-node pointer gestures: drag moves the whole subtree (or the multi-selection); Shift clones
// while dragging, Alt detaches to root, dropping onto another card reparents. Edge auto-pan keeps
// the dragged subtree glued under the cursor while the view scrolls. All transient drag state lives
// in `ui.drag`. Importing this module registers the global Alt/Shift modifier listeners; bindNodeDrag
// is called by the render core (nodeEl) for each card.
import { state, stage, world, setStatus, type MindNode } from '../core/state.js';
import { isHidden, isAncestor } from '../utils/model.js';
import { applyLayouts, reorderDraggedParents, dropLanding, effectiveLayout, insertedKidOrder } from '../view/layout.js';
import { cancelViewAnim, applyView } from '../view/camera.js';
import { scheduleSave } from '../data/persistence.js';
import { ui, type Pt, type Drag } from '../core/ui-state.js';
import { paintEdges, branchTint } from '../view/edges.js';
import { NODE_W, nodeH, paintAll, paintNode, selectNode, setSelectionSet, toggleSel,
         subtreeIds, foldNodeOrGroup } from '../main.js';
import { startInlineEdit, startBodyEdit, endInlineEdit, endBodyEdit } from './inline-edit.js';
import { leaveClone } from './crud.js';

// The #editor panel is a fixed element in the shell; cache the handle so the per-frame
// auto-pan loop doesn't re-query it on every rAF tick.
let _editor: HTMLElement | null = null;
function editorEl(): HTMLElement | null { return _editor ??= document.getElementById('editor'); }

// Lazily-created phantom card that previews where the dragged card will actually LAND once
// dropped (not where the cursor currently is) while poised over a valid reparent target. The
// whole dragged subtree (the card + every descendant coming along with it) is hidden for the
// duration (see showLandingGhost/hideLandingGhost) so only the landing preview is visible —
// avoids overlapping copies of the same cards on screen.
let _landingGhost: HTMLElement | null = null;
function landingGhostEl(): HTMLElement {
  if (_landingGhost) return _landingGhost;
  const el = document.createElement('div');
  el.className = 'node reparent-ghost landing-ghost';
  el.style.display = 'none';
  world.appendChild(el);
  return _landingGhost = el;
}
function setSubtreeVisibility(ids: Iterable<string>, visible: boolean): void {
  for (const id of ids) {
    const el = state.nodes.get(id)?.el;
    if (el) el.style.visibility = visible ? '' : 'hidden';
  }
}
function showLandingGhost(x: number, y: number, h: number, draggedIds: Iterable<string>, color: string): void {
  const el = landingGhostEl();
  el.style.left = x + 'px'; el.style.top = y + 'px';
  el.style.width = NODE_W + 'px'; el.style.height = h + 'px';
  // .node has a 64px min-height (for bodied cards); without this the ghost for a shorter
  // title-only card would get clamped taller than the real card it's previewing.
  el.style.minHeight = h + 'px';
  el.style.borderColor = color;   // match the dragged card's branch colour
  el.style.display = '';
  setSubtreeVisibility(draggedIds, false);
}
function hideLandingGhost(draggedIds?: Iterable<string> | null): void {
  if (_landingGhost) _landingGhost.style.display = 'none';
  if (draggedIds) setSubtreeVisibility(draggedIds, true);
}

const RIP_THRESHOLD = 400; // screen-space px before edge snaps and drag detaches on drop

// Recompute whether the dragged card has been pulled past the rip threshold from its parent.
// Must be called before paintEdges() so the dashed-edge rendering reads the latest state.
function updateRip(drag: Drag): void {
  if (drag.multi || drag.cloned || !drag.moved) return;
  const act = drag.active;
  if (!act.parent) { drag.rip = false; return; }
  const parent = state.nodes.get(act.parent);
  if (!parent) { drag.rip = false; return; }
  const dx = (act.x + NODE_W/2 - parent.x - NODE_W/2) * state.view.k;
  const dy = (act.y - parent.y) * state.view.k;
  drag.rip = Math.hypot(dx, dy) > RIP_THRESHOLD;
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
  if (drag.moved && !drag.multi) {
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
    if (!drag.multi) {
      updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
    }
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
    const ids = [...new Set(rootIds.flatMap(id => subtreeIds(id)))];
    const start = new Map(ids.map(id => {
      const m = state.nodes.get(id)!; return [id, { x:m.x, y:m.y }] as [string, Pt];
    }));
    // targets gets its OWN {x,y} objects (not new Map(start), which shares the value refs) so the
    // edge auto-pan can shift the dragged anchors without also moving the pinned `start` positions.
    const targets = new Map([...start].map(([id, s]) => [id, { x:s.x, y:s.y }] as [string, Pt]));
    // origins = the left/top CSS values frozen at drag start; transforms are relative to these
    const origins = new Map(ids.map(id => { const m2 = state.nodes.get(id)!; return [id, { x:m2.x, y:m2.y }] as [string, Pt]; }));
    ui.drag = { n, active:n, multi, sx:e.clientX, sy:e.clientY, cx:e.clientX, cy:e.clientY, start, targets, origins,
             moved:false, dropTarget:null as string | null, dropMode:'child', alt:e.altKey, shift:e.shiftKey, cloned:false, rip:false,
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
      // Clear compositor transforms so paintAll()/paintNode() can commit final left/top cleanly,
      // and undo any landing-ghost visibility hide left over from updateDropTarget.
      for (const id of new Set([...drag.targets.keys(), ...drag.start.keys()])){
        const m2 = state.nodes.get(id);
        if (m2?.el){ m2.el.style.transform = ''; m2.el.style.willChange = ''; m2.el.style.visibility = ''; m2.el.classList.remove('dragging'); }
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
        // dropped onto a node? re-parent. Alt+drop on empty canvas? detach to root.
        // Otherwise it's just a move.
        const tgt = drag.dropTarget;
        const { cloned, targets, alt, shift, clones, rip, dropMode } = drag;
        clearDropTarget();
        hideLandingGhost(targets.keys());
        // Null drag NOW so every paintAll/paintEdges in the commit phase sees no active drag
        // and draws all edges. (Previously edges remained hidden because drag was still set
        // when paintAll was called, and nothing repainted after drag = null.)
        ui.drag = null;
        document.body.classList.remove('grabbing');
        const tgtNode = tgt ? state.nodes.get(tgt)! : null;
        const effectiveParent = tgtNode
          ? (dropMode === 'sibling' ? tgtNode.parent! : tgt!)
          : null;
        if (effectiveParent && tgtNode && effectiveParent !== act.parent) {
          // land exactly where the drop preview showed (see view/layout.ts dropLanding), and
          // shift the rest of the dragged subtree by the same delta so its relative formation
          // is preserved (a clone keeps where you dropped it, since that's a fresh placement).
          if (!cloned){
            const land = dropLanding(act, tgtNode, dropMode);
            const startAct = targets.get(act.id)!;
            const ddx = land.x - startAct.x, ddy = land.y - startAct.y;
            for (const [id, s] of targets){
              const m = state.nodes.get(id); if (m){ m.x = s.x + ddx; m.y = s.y + ddy; m.dirtyLayout = true; }
            }
          }
          reparent(act.id, effectiveParent, dropMode === 'sibling' ? tgtNode.id : undefined);
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
            setStatus(`"${act.title}" is now a root`);
          }
        }
        // Paint first so freshly-created clone cards have real DOM heights before applyLayouts
        // measures them — otherwise a chain/fan of clones lays out on the 64px height fallback
        // (only the first lands right). Mirrors the duplicate path: paint -> layout -> paint.
        paintAll();
        reorderDraggedParents(targets.keys());   // a drag is the ONLY thing that reorders siblings
        applyLayouts(); paintAll();   // re-snap any dragged child back into its parent's layout
        // select the new clone(s) you just dragged out
        if (cloned){ if (clones && clones.length > 1) setSelectionSet(clones.map(c => c.id)); else selectNode(act.id); }
        scheduleSave();
        return;   // drag/grabbing already cleared above
      }
    }
    ui.drag = null;
    document.body.classList.remove('grabbing');
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
    start, targets, origins, moved:true, dropTarget:null, dropMode:'child',
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
  hideLandingGhost(drag.targets.keys());
  for (const id of new Set([...drag.targets.keys(), ...drag.start.keys()])){
    const m = state.nodes.get(id);
    if (m?.el){ m.el.style.transform = ''; m.el.style.willChange = ''; m.el.style.visibility = ''; m.el.classList.remove('dragging'); }
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
      // revert their compositor transforms and undo any landing-ghost visibility hide —
      // `drag.active` is about to switch to the clone, so the original must stay visible
      if (m?.el) { m.el.style.transform = ''; m.el.style.visibility = ''; }
    }
    // clone each dragged root (just the card, not its subtree) at its own start spot
    const rootIds = drag.multi ? [...state.sel] : [drag.n.id];
    const clones = rootIds.map(id => leaveClone(state.nodes.get(id)!, drag!.start.get(id)!));
    drag.clones = clones;
    drag.active = clones[0];                        // representative (drives single-card reparent)
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
  if (drag.moved && !drag.multi) updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
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
const SIBLING_ZONE = 0.3; // bottom fraction of a card that triggers sibling-insert mode

function updateDropTarget(dragged: MindNode, e: { clientX: number; clientY: number }): void {
  const sub = new Set(subtreeIds(dragged.id)); // dragged card + all its descendants
  // Geometric hit test in world space — no layout read, no elementsFromPoint.
  // stage is position:fixed; inset:0 so its origin is always (0,0).
  const wx = (e.clientX - state.view.x) / state.view.k;
  const wy = (e.clientY - state.view.y) / state.view.k;
  let hovered: string | null = null;
  let hoveredBottomZone = false;
  for (const [id, m] of state.nodes) {
    if (isHidden(m) || sub.has(id)) continue;
    const h = nodeH(m);
    if (wx >= m.x && wx <= m.x + NODE_W && wy >= m.y && wy <= m.y + h){
      hovered = id;
      hoveredBottomZone = wy >= m.y + h * (1 - SIBLING_ZONE);
      break;
    }
  }
  clearDropTarget();
  let target: string | null = null;
  let mode: 'child' | 'sibling' = 'child';
  if (hovered && sub.has(hovered)){
    setStatus(`Can't parent "${dragged.title}" onto its own child/descendant`);
  } else if (hovered) {
    const hoveredNode = state.nodes.get(hovered)!;
    // Bottom zone + hovered card has a parent -> sibling drop (adopt hovered's parent)
    if (hoveredBottomZone && hoveredNode.parent) {
      const sibParent = hoveredNode.parent;
      // Valid as long as it wouldn't re-parent onto self or create a cycle
      if (sibParent !== dragged.id && !sub.has(sibParent)) {
        target = hovered;
        mode = 'sibling';
      }
    }
    // Top/center zone -> child drop (existing behaviour), but skip if already this node's parent
    if (!target) {
      if (hovered === dragged.parent) {
        const p = state.nodes.get(hovered);
        setStatus(`"${dragged.title}" is already a child of "${p ? p.title : 'that card'}"`);
      } else {
        target = hovered;
        mode = 'child';
      }
    }
  }
  if (ui.drag) { ui.drag.dropTarget = target; ui.drag.dropMode = mode; }
  if (target) {
    const targetNode = state.nodes.get(target)!;
    targetNode.el?.classList.add(mode === 'sibling' ? 'drop-sibling' : 'drop-target');
    // poised over a valid target -> preview the LANDING spot (where it'll actually be once
    // dropped, depending on which zone is hovered), hiding the real dragged card so only
    // the landing preview shows.
    const land = dropLanding(dragged, targetNode, mode);
    showLandingGhost(land.x, land.y, nodeH(dragged), sub, branchTint(dragged));
  } else {
    hideLandingGhost(sub);
  }
}
function clearDropTarget(): void {
  document.querySelectorAll('.node.drop-target, .node.drop-sibling')
    .forEach(el => el.classList.remove('drop-target', 'drop-sibling'));
}
// `afterId` anchors a sibling-mode drop: the child slots in right after that sibling in the new
// parent's order, matching the bottom-zone hover that triggered sibling mode (see dropLanding).
function reparent(childId: string, newParentId: string, afterId?: string): void {
  if (state.readOnly) return;
  const child = state.nodes.get(childId);
  if (!child || childId === newParentId) return;
  if (isAncestor(childId, newParentId)) return; // would create a cycle
  child.parent = newParentId;
  child.dirtyLayout = true;
  const newParent = state.nodes.get(newParentId)!;
  const eff = effectiveLayout(newParent);
  if (eff.type === 'line' || eff.type === 'fan' || eff.type === 'two-sided')
    newParent.kidOrder = insertedKidOrder(newParent, childId, afterId);
  applyLayouts(); paintAll();
  setStatus(`Re-parented "${child.title}" -> "${newParent.title}"`);
}
