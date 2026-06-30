// ---------- node dragging & reparent-by-drop ----------
// Per-node pointer gestures: drag moves the whole subtree (or the multi-selection); Shift clones
// while dragging, Alt detaches to root, dropping onto another card reparents. Edge auto-pan keeps
// the dragged subtree glued under the cursor while the view scrolls. All transient drag state lives
// in `ui.drag`. Importing this module registers the global Alt/Shift modifier listeners; bindNodeDrag
// is called by the render core (nodeEl) for each card.
import { state, stage, setStatus, type MindNode } from '../core/state.js';
import { isHidden, isAncestor } from '../utils/model.js';
import { applyLayouts, reorderDraggedParents } from '../view/layout.js';
import { cancelViewAnim, applyView } from '../view/camera.js';
import { scheduleSave } from '../data/persistence.js';
import { ui, type Pt, type Drag } from '../core/ui-state.js';
import { paintEdges } from '../view/edges.js';
import { NODE_W, nodeH, paintAll, paintNode, selectNode, setSelectionSet, toggleSel,
         subtreeIds, foldNodeOrGroup } from '../main.js';
import { startInlineEdit, startBodyEdit, endInlineEdit, endBodyEdit } from './inline-edit.js';
import { leaveClone } from './crud.js';

// The #editor panel is a fixed element in the shell; cache the handle so the per-frame
// auto-pan loop doesn't re-query it on every rAF tick.
let _editor: HTMLElement | null = null;
function editorEl(): HTMLElement | null { return _editor ??= document.getElementById('editor'); }

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
    el.setPointerCapture(e.pointerId);
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
    for (const id of ids) { const m2 = state.nodes.get(id); if (m2?.el) m2.el.style.willChange = 'transform'; }
  });
  el.addEventListener('pointermove', (e) => {
    const drag = ui.drag;
    if (!drag || drag.n !== n) return;
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
  });
  el.addEventListener('pointerup', () => {
    stopAutoPan();
    if (ui.dragRAF){ cancelAnimationFrame(ui.dragRAF); ui.dragRAF = null; }
    const drag = ui.drag;
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
        act.el?.classList.remove('reparent-ghost');
        // Null drag NOW so every paintAll/paintEdges in the commit phase sees no active drag
        // and draws all edges. (Previously edges remained hidden because drag was still set
        // when paintAll was called, and nothing repainted after drag = null.)
        ui.drag = null;
        document.body.classList.remove('grabbing');
        const effectiveParent = tgt
          ? (dropMode === 'sibling' ? state.nodes.get(tgt)!.parent! : tgt)
          : null;
        if (effectiveParent && effectiveParent !== act.parent) {
          // reparent in place: the card keeps its ORIGINAL position, only its parent changes
          // (a clone keeps where you dropped it, since that's a fresh card you're placing).
          if (!cloned){
            for (const [id, s] of targets){
              const m = state.nodes.get(id); if (m){ m.x = s.x; m.y = s.y; m.dirtyLayout = true; }
            }
          }
          reparent(act.id, effectiveParent);
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
  });
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
      if (m?.el) m.el.style.transform = '';        // revert their compositor transforms
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
    const tEl = state.nodes.get(target)?.el;
    if (tEl) tEl.classList.add(mode === 'sibling' ? 'drop-sibling' : 'drop-target');
  }
  // poised over a valid target -> ghost the dragged card so the card underneath stays visible
  if (dragged.el) dragged.el.classList.toggle('reparent-ghost', !!target);
}
function clearDropTarget(): void {
  document.querySelectorAll('.node.drop-target, .node.drop-sibling')
    .forEach(el => el.classList.remove('drop-target', 'drop-sibling'));
}
function reparent(childId: string, newParentId: string): void {
  if (state.readOnly) return;
  const child = state.nodes.get(childId);
  if (!child || childId === newParentId) return;
  if (isAncestor(childId, newParentId)) return; // would create a cycle
  child.parent = newParentId;
  child.dirtyLayout = true;
  applyLayouts(); paintAll();
  setStatus(`Re-parented "${child.title}" -> "${state.nodes.get(newParentId)?.title}"`);
}
