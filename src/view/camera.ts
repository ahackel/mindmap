// ---------- view camera: pan / zoom / fit / frame ----------
// Pure camera math over state.view (the {x,y,k} pan+zoom). No painting — callers repaint
// if needed. NODE_W/nodeH come from main.js (render) for measuring; isHidden from model.
import { state, world, stage, type MindNode } from '../core/state.js';
import { isHidden } from '../utils/model.js';
import { NODE_W, nodeH } from '../main.js';

export function applyView(): void {
  world.style.transform = `translate(${state.view.x}px,${state.view.y}px) scale(${state.view.k})`;
}
// Smoothly glide the view to (tx,ty) instead of snapping. Any direct pan/zoom cancels it
// (cancelViewAnim) so the animation never fights the user's own input.
let viewAnim: number | null = null;
export function cancelViewAnim(): void { if (viewAnim){ cancelAnimationFrame(viewAnim); viewAnim = null; } }
function animateViewTo(tx: number, ty: number, tk: number = state.view.k, dur = 420): void {
  cancelViewAnim();
  const sx = state.view.x, sy = state.view.y, sk = state.view.k;
  if (Math.abs(tx-sx) < 1 && Math.abs(ty-sy) < 1 && Math.abs(tk-sk) < .001){
    state.view.x = tx; state.view.y = ty; state.view.k = tk; applyView(); return;
  }
  const t0 = performance.now();
  const ease = (t: number) => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;   // easeInOutCubic
  function step(now: number){
    const p = Math.min(1, (now - t0)/dur), e = ease(p);
    state.view.x = sx + (tx-sx)*e;
    state.view.y = sy + (ty-sy)*e;
    // zoom is perceptually multiplicative, so interpolate k geometrically — with the eased
    // parameter this gives a smooth ease-in/ease-out zoom rather than a linear ramp.
    state.view.k = sk * Math.pow(tk/sk, e);
    applyView();
    viewAnim = p < 1 ? requestAnimationFrame(step) : null;
  }
  viewAnim = requestAnimationFrame(step);
}

export function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  const r = stage.getBoundingClientRect();
  return { x:(sx - r.left - state.view.x)/state.view.k, y:(sy - r.top - state.view.y)/state.view.k };
}

// zoom toward a screen point (mx,my are relative to the stage) by a multiplier
export function zoomAt(mx: number, my: number, factor: number): void {
  cancelViewAnim();
  const k0 = state.view.k;
  const k1 = Math.min(2.5, Math.max(0.2, k0 * factor));
  state.view.x = mx - (mx - state.view.x) * (k1 / k0);
  state.view.y = my - (my - state.view.y) * (k1 / k0);
  state.view.k = k1;
  applyView();
}

// World-space bounding box of every sketch stroke (padded by half each stroke's width), or null
// when the ink layer is empty. Folded into fit()/frameBox so framing never crops a drawing.
export function strokesBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (const s of state.strokes) {
    const hw = s.width / 2;
    for (const [x, y] of s.pts) {
      any = true;
      minX = Math.min(minX, x - hw); minY = Math.min(minY, y - hw);
      maxX = Math.max(maxX, x + hw); maxY = Math.max(maxY, y + hw);
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

export function fit(): void {
  const ns = [...state.nodes.values()].filter(n => !isHidden(n));
  const sb = strokesBounds();
  if (!ns.length && !sb) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of ns) {
    minX = Math.min(minX, n.x);          minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + nodeH(n));
  }
  if (sb) { minX = Math.min(minX, sb.minX); minY = Math.min(minY, sb.minY); maxX = Math.max(maxX, sb.maxX); maxY = Math.max(maxY, sb.maxY); }
  const r = stage.getBoundingClientRect();
  const k = Math.min(1.4, Math.min(r.width/(maxX-minX+120), r.height/(maxY-minY+120)));
  state.view.k = k;
  state.view.x = (r.width - (maxX-minX)*k)/2 - minX*k;
  state.view.y = (r.height - (maxY-minY)*k)/2 - minY*k;
  applyView();
}

// Zoom + glide so a set of nodes fits, honouring the space the editor sidebar takes from the
// right. Zoom is clamped so we never blow things up huge. Shared by focus-selected and fit-all.
const FOCUS_MIN_K = 0.2, FOCUS_MAX_K = 1.0, FOCUS_PAD = 80;
export function frameBox(nodes: ReadonlyArray<MindNode | undefined>, includeStrokes = false): void {
  const group = nodes.filter((n): n is MindNode => !!n && !isHidden(n));
  const sb = includeStrokes ? strokesBounds() : null;
  if (!group.length && !sb) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of group){
    minX = Math.min(minX, n.x);            minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);   maxY = Math.max(maxY, n.y + nodeH(n));
  }
  if (sb) { minX = Math.min(minX, sb.minX); minY = Math.min(minY, sb.minY); maxX = Math.max(maxX, sb.maxX); maxY = Math.max(maxY, sb.maxY); }
  const bw = maxX - minX, bh = maxY - minY, cx = (minX+maxX)/2, cy = (minY+maxY)/2;
  // available canvas = stage minus the sidebar (when open). The sidebar sits on the RIGHT,
  // so the usable region spans x:[0, availW] and we centre the box within it.
  const r = stage.getBoundingClientRect();
  const ed = document.getElementById('editor') as HTMLElement;
  const availW = r.width - (ed.classList.contains('open') ? ed.offsetWidth : 0);
  const availH = r.height;
  const k = Math.max(FOCUS_MIN_K, Math.min(FOCUS_MAX_K,
    Math.min((availW - 2*FOCUS_PAD) / bw, (availH - 2*FOCUS_PAD) / bh)));
  animateViewTo(availW/2 - cx*k, availH/2 - cy*k, k);   // glide + zoom, never jump
}
