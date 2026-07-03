// ---------- pan / zoom / marquee-select gestures ----------
// The unified Pointer-Events gesture layer on #stage (the empty canvas): one finger / mouse drag
// rubber-band selects, two fingers pinch-zoom + pan, Space / middle-button hand-pans, and wheel +
// Safari gesture events zoom/pan. Node drag/reparent lives in features/drag.ts; this only handles
// the canvas background. Importing this module registers its listeners (run for side effects).
import { state, stage } from '../core/state.js';
import { isHidden } from '../utils/model.js';
import { applyView, cancelViewAnim, screenToWorld, zoomAt } from '../view/camera.js';
import { ui, gPointers, type Pt, type GestureEvt } from '../core/ui-state.js';
import { NODE_W, nodeH, selectNode, setSelectionSet } from '../main.js';
import { endInlineEdit, endBodyEdit } from './inline-edit.js';
import { sketchDown, sketchMove, sketchUp, sketchCancel } from './sketch.js';

const marqueeEl = document.createElement('div');
marqueeEl.id = 'marquee'; stage.appendChild(marqueeEl);

// ---- touch gestures: track each finger that lands on the empty canvas. One finger marquee-selects
// (same as mouse), two fingers pinch-zoom + pan. (Mouse keeps Space-to-pan / marquee-select behaviour.)
const gDist = (a: Pt, b: Pt) => Math.hypot(a.x-b.x, a.y-b.y);
function startPinch(): void {
  const [a,b] = [...gPointers.values()];
  ui.pinch = { dist: gDist(a,b), cx:(a.x+b.x)/2, cy:(a.y+b.y)/2 };
}

// Empty-canvas drag = rubber-band SELECT (mouse and single-finger touch). Hold Space / middle-button to PAN.
stage.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest('.node')) return;            // node drags capture their own pointer
  if (e.button === 2) return;         // right-click = context menu only: no marquee, keep editors/selection
  cancelViewAnim();
  // Tapping the canvas background closes any open in-place text editor (important on touch)
  if (ui.inlineEdit) { endInlineEdit(); return; }
  if (ui.bodyEdit)   { endBodyEdit();   return; }

  if (e.pointerType !== 'mouse'){                   // touch / pen
    gPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if (gPointers.size === 1){                      // one finger → sketch (in sketch mode) / marquee select
      if (ui.sketchOn && !state.readOnly){          // draw; two fingers still pinch-zoom (see below)
        stage.setPointerCapture(e.pointerId);
        sketchDown(e.clientX, e.clientY);
        return;
      }
      ui.marquee = { sx:e.clientX, sy:e.clientY, add:false, base:new Set(state.sel), moved:false };
      drawMarquee(e.clientX, e.clientY);
      marqueeEl.style.display = 'block';
      stage.setPointerCapture(e.pointerId);         // keep events on stage even when finger slides onto a node
    } else if (gPointers.size === 2){               // second finger → pinch-zoom + two-finger pan
      if (ui.sketchDraw) sketchCancel();            // abandon the one-finger stroke; this is a pinch now
      ui.marquee = null; marqueeEl.style.display = 'none';
      startPinch();
    }
    return;
  }

  // Sketch mode (mouse): a left-drag draws / erases instead of marquee-selecting.
  if (ui.sketchOn && !state.readOnly && e.button === 0){
    stage.setPointerCapture(e.pointerId);
    sketchDown(e.clientX, e.clientY);
    return;
  }

  if (ui.spaceHeld || e.button === 1){                 // hand-pan
    if (ui.spaceHeld) ui.spaceUsedForPan = true;
    ui.pan = { sx:e.clientX, sy:e.clientY, ox:state.view.x, oy:state.view.y };
    stage.classList.add('panning');
    return;
  }
  // start a marquee. ⌘/Ctrl keeps the existing selection and adds to it.
  ui.marquee = { sx:e.clientX, sy:e.clientY, add:e.metaKey||e.ctrlKey, base:new Set(state.sel), moved:false };
  drawMarquee(e.clientX, e.clientY);
  marqueeEl.style.display = 'block';
});
window.addEventListener('pointermove', (e) => {
  if (ui.sketchDraw){ if (gPointers.has(e.pointerId)) gPointers.set(e.pointerId, { x:e.clientX, y:e.clientY }); sketchMove(e.clientX, e.clientY); return; }
  if (gPointers.has(e.pointerId)){
    gPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    const pinch = ui.pinch;
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
  if (ui.pan){
    state.view.x = ui.pan.ox + (e.clientX - ui.pan.sx);
    state.view.y = ui.pan.oy + (e.clientY - ui.pan.sy);
    applyView(); return;
  }
  const marquee = ui.marquee;
  if (marquee){
    if (Math.abs(e.clientX-marquee.sx) + Math.abs(e.clientY-marquee.sy) > 3) marquee.moved = true;
    drawMarquee(e.clientX, e.clientY);
    if (marquee.moved) selectWithinMarquee(e.clientX, e.clientY);
  }
});
function endGesturePointer(e: PointerEvent): boolean {
  if (!gPointers.has(e.pointerId)) return false;
  gPointers.delete(e.pointerId);
  if (gPointers.size < 2) ui.pinch = null;
  if (gPointers.size === 0){
    ui.pan = null; stage.classList.remove('panning');
    // End marquee exactly like the mouse path does
    if (ui.marquee){
      marqueeEl.style.display = 'none';
      if (!ui.marquee.moved && !ui.marquee.add) selectNode(null);   // tap on empty = deselect
      ui.marquee = null;
    }
  }
  // gPointers.size === 1: one finger remains after pinch — don't start a new marquee mid-gesture
  return true;
}
window.addEventListener('pointerup', (e) => {
  if (ui.sketchDraw){ gPointers.delete(e.pointerId); if (gPointers.size < 2) ui.pinch = null; sketchUp(); return; }
  if (endGesturePointer(e)) return;
  if (ui.pan){ ui.pan = null; stage.classList.remove('panning'); return; }
  if (ui.marquee){
    marqueeEl.style.display = 'none';
    if (!ui.marquee.moved && !ui.marquee.add) selectNode(null);   // plain click on empty = deselect
    ui.marquee = null;
  }
});
window.addEventListener('pointercancel', (e) => {
  if (ui.sketchDraw){ gPointers.delete(e.pointerId); sketchCancel(); return; }
  endGesturePointer(e);
});
function drawMarquee(cx: number, cy: number): void {
  const marquee = ui.marquee;
  if (!marquee) return;
  const r = stage.getBoundingClientRect();
  marqueeEl.style.left   = (Math.min(marquee.sx, cx) - r.left) + 'px';
  marqueeEl.style.top    = (Math.min(marquee.sy, cy) - r.top)  + 'px';
  marqueeEl.style.width  = Math.abs(cx - marquee.sx) + 'px';
  marqueeEl.style.height = Math.abs(cy - marquee.sy) + 'px';
}
function selectWithinMarquee(cx: number, cy: number): void {
  const marquee = ui.marquee;
  if (!marquee) return;
  const a = screenToWorld(Math.min(marquee.sx, cx), Math.min(marquee.sy, cy));
  const b = screenToWorld(Math.max(marquee.sx, cx), Math.max(marquee.sy, cy));
  const hits: string[] = [];
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
stage.addEventListener('gesturestart', (ev) => {
  const e = ev as GestureEvt;
  e.preventDefault();
  if (gPointers.size) return;   // touchscreen pinch is handled via pointer events instead
  ui.gestureStartK = state.view.k;
  const r = stage.getBoundingClientRect();
  ui.gestureMid = { x: e.clientX - r.left, y: e.clientY - r.top };
});
stage.addEventListener('gesturechange', (ev) => {
  const e = ev as GestureEvt;
  e.preventDefault();
  if (gPointers.size) return;   // …so we don't double-apply zoom on iPad
  const k0 = state.view.k;
  const target = Math.min(2.5, Math.max(0.2, ui.gestureStartK * e.scale));
  zoomAt(ui.gestureMid.x, ui.gestureMid.y, target / k0);
});
stage.addEventListener('gestureend', (e) => e.preventDefault());
