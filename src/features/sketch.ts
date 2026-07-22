// ---------- freehand sketch layer ----------
// Draw ink directly on the canvas, independent of the node model. Strokes are world-space
// polylines rendered into the #sketch SVG (which lives inside #world, so ink pans/zooms with the
// map) and persisted as one JSON data file — see data/persistence.ts (loadSketch/scheduleSaveSketch).
// The pointer plumbing is shared with the canvas gesture layer: features/gestures.ts routes a
// single-pointer press to the draw/erase functions below when `ui.sketchOn` is set, so pinch-zoom
// and two-finger pan keep working even mid-sketch.
import { state, sketchSvg, setStatus, type Stroke } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { screenToWorld } from '../view/camera.js';
import { scheduleSaveSketch } from '../data/persistence.js';
import { touchStrokes, commitStep } from './history.js';
import { selectNode } from '../main.js';
import { setTagPanelOpen } from './tags.js';   // two-way cycle w/ tags.ts, evaluated only in setSketchMode below

const SVGNS = 'http://www.w3.org/2000/svg';

// ---- persisted pen settings ----
const TOOL_KEY = 'mindmap.sketchTool', COLOR_KEY = 'mindmap.sketchColor', WIDTH_KEY = 'mindmap.sketchWidth';
const COLORS = ['#e0564a', '#f0a020', '#3bb273', '#357eea', '#9b5de5', '#8a99ad', '#f4f4f5', '#11151c'];
const WIDTHS = [2, 4, 8];
let tool: 'pen' | 'eraser' = 'pen';
let color: string = COLORS[0];
let width: number = WIDTHS[1];

// Only append points once the pointer has travelled this far (world units²), so a path stays
// compact instead of logging every sub-pixel jitter. Erase hit-radius is kept constant on screen.
const MIN_DIST2 = 4;
const ERASE_PX = 8;

// ---- active gesture (module-local; ui.sketchDraw is the flag gestures.ts reads) ----
let cur: Stroke | null = null;          // stroke being drawn (pen); cur.pts collects raw points, simplified once on up
let curEl: SVGPathElement | null = null;
let erasedAny = false;                  // an erase gesture removed at least one stroke → save on up
let idSeq = 0;
function newId(): string { return 'k' + Date.now().toString(36) + (idSeq++).toString(36); }

// Simplify epsilon (world units): drop points that stray less than this from the line between
// their neighbours, so a hand-drawn stroke stores a handful of points instead of hundreds.
const SIMPLIFY_EPS = 1.2;

// A turn sharper than this (degrees; 0 = straight, 90 = right angle) is kept as a hard corner
// rather than rounded — so a hand-drawn rectangle keeps square corners while curves stay smooth.
const SHARP_DEG = 55;
// Turn angle at vertex b between a→b and b→c (0 = straight on, 180 = doubles back).
function turnDeg(a: [number, number], b: [number, number], c: [number, number]): number {
  const v1x = b[0] - a[0], v1y = b[1] - a[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
  const l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
  return Math.acos(cos) * 180 / Math.PI;
}
// ---- rendering ----
// Draw the polyline as a smooth curve — a quadratic through each vertex ending at the next
// segment's midpoint (the classic midpoint-smoothing trick) — EXCEPT at sharp vertices, which are
// drawn as hard corners (a straight line to the point). 1–2 points fall back to a plain line.
function strokeD(pts: [number, number][]): string {
  const n = pts.length;
  if (!n) return '';
  if (n < 3) return 'M ' + pts.map(p => `${p[0]} ${p[1]}`).join(' L ');
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < n - 1; i++) {
    if (turnDeg(pts[i - 1], pts[i], pts[i + 1]) > SHARP_DEG) {
      d += ` L ${pts[i][0]} ${pts[i][1]}`;   // sharp corner: reach the vertex exactly, no rounding
    } else {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ` Q ${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
    }
  }
  return d + ` L ${pts[n - 1][0]} ${pts[n - 1][1]}`;
}
// Ramer–Douglas–Peucker: recursively keep only the points that carry the stroke's shape.
function simplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length <= 2) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i][0], pts[i][1], a[0], a[1], b[0], b[1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  const left = simplify(pts.slice(0, idx + 1), eps);
  const right = simplify(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}
function pathFor(s: Stroke): SVGPathElement {
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', strokeD(s.pts));
  p.setAttribute('stroke', s.color);
  p.setAttribute('stroke-width', String(s.width));
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  return p;
}
// Full repaint of the ink layer from state.strokes. Cheap (one <path> per stroke) and called on
// load, on erase, and after a stroke commits; live pen drawing mutates a single path in place.
export function paintStrokes(): void {
  sketchSvg.textContent = '';
  for (const s of state.strokes) sketchSvg.appendChild(pathFor(s));
}

// ---- geometry: distance from a point to a stroke's polyline, for whole-stroke erase ----
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function strokeHit(s: Stroke, px: number, py: number, tol: number): boolean {
  const p = s.pts;
  if (p.length === 1) return Math.hypot(px - p[0][0], py - p[0][1]) <= tol;
  for (let i = 0; i < p.length - 1; i++)
    if (distToSeg(px, py, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]) <= tol) return true;
  return false;
}
function eraseAt(wx: number, wy: number): void {
  const r = ERASE_PX / state.view.k;            // constant hit radius in SCREEN px, regardless of zoom
  let changed = false;
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    if (strokeHit(state.strokes[i], wx, wy, r + state.strokes[i].width / 2)) { state.strokes.splice(i, 1); changed = true; }
  }
  if (changed) { erasedAny = true; paintStrokes(); }
}

// ---- draw gestures (called by features/gestures.ts) ----
export function sketchDown(cx: number, cy: number): void {
  const w = screenToWorld(cx, cy);
  if (tool === 'eraser') {
    ui.sketchDraw = { tool: 'eraser' };
    erasedAny = false;
    touchStrokes();               // snapshot the ink layer before this erase gesture removes anything
    eraseAt(w.x, w.y);
  } else {
    cur = { id: newId(), color, width, pts: [[round(w.x), round(w.y)]] };
    curEl = pathFor(cur);
    sketchSvg.appendChild(curEl);
    ui.sketchDraw = { tool: 'pen' };
  }
}
export function sketchMove(cx: number, cy: number): void {
  if (!ui.sketchDraw) return;
  const w = screenToWorld(cx, cy);
  if (ui.sketchDraw.tool === 'eraser') { eraseAt(w.x, w.y); return; }
  if (!cur || !curEl) return;
  const last = cur.pts[cur.pts.length - 1];
  const dx = w.x - last[0], dy = w.y - last[1];
  if (dx * dx + dy * dy < MIN_DIST2) return;
  cur.pts.push([round(w.x), round(w.y)]);   // collect raw points; simplified once on up
  curEl.setAttribute('d', strokeD(cur.pts));
}
export function sketchUp(): void {
  const d = ui.sketchDraw; ui.sketchDraw = null;
  if (!d) return;
  if (d.tool === 'pen') {
    if (cur) cur.pts = simplify(cur.pts, SIMPLIFY_EPS);   // reduce to a handful of points now the stroke is complete
    if (cur && cur.pts.length >= 2) { curEl!.setAttribute('d', strokeD(cur.pts)); touchStrokes(); state.strokes.push(cur); commitStep(); scheduleSaveSketch(); }
    else if (curEl) curEl.remove();   // a mere tap / too-short stroke → discard, nothing committed
    cur = null; curEl = null;
  } else {
    commitStep();                     // close the erase step (no-op if nothing was removed)
    if (erasedAny) { scheduleSaveSketch(); erasedAny = false; }
  }
}
// A second finger landed (pinch) or the gesture was cancelled: abandon the in-progress stroke.
export function sketchCancel(): void {
  if (!ui.sketchDraw) return;
  if (ui.sketchDraw.tool === 'pen') { if (curEl) curEl.remove(); }   // pen never mutated strokes yet — just drop it
  else { commitStep(); if (erasedAny) scheduleSaveSketch(); }        // eraser already removed strokes live — keep it undoable
  cur = null; curEl = null; erasedAny = false; ui.sketchDraw = null;
}
const round = (v: number): number => Math.round(v * 10) / 10;

// ---- toolbar wiring ----
function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
export function setSketchMode(on: boolean): void {
  ui.sketchOn = on;
  if (!on) sketchCancel();
  else { selectNode(null); if (ui.tagPanelOn) setTagPanelOpen(false); }   // cards are locked in sketch mode — clear any selection, and the tag panel can't be open at the same time
  document.body.classList.toggle('sketching', on);     // opens #sketchPanel, locks .node pointer-events (styles.css)
  byId('sketchBtn').classList.toggle('active', on);
  setStatus(on ? 'Sketch mode — draw on the canvas' : 'Sketch mode off');
}
export function toggleSketchMode(): void { setSketchMode(!ui.sketchOn); }

function markTool(): void {
  byId('sketchPen').classList.toggle('active', tool === 'pen');
  byId('sketchEraser').classList.toggle('active', tool === 'eraser');
}
function setTool(t: 'pen' | 'eraser'): void { tool = t; try { localStorage.setItem(TOOL_KEY, t); } catch {} markTool(); }

function buildControls(): void {
  const colorsEl = byId('sketchColors'); colorsEl.classList.add('colors');
  colorsEl.innerHTML = COLORS.map(c => `<button class="dot" data-color="${c}" title="${c}" style="--sw:${c}"></button>`).join('');
  colorsEl.querySelectorAll<HTMLElement>('.dot').forEach(dot =>
    dot.addEventListener('click', () => { color = dot.dataset.color!; try { localStorage.setItem(COLOR_KEY, color); } catch {} setTool('pen'); markColor(); }));

  const widthsEl = byId('sketchWidths'); widthsEl.classList.add('widths');
  widthsEl.innerHTML = WIDTHS.map(w => `<button class="dot" data-w="${w}" title="${w}px" style="--d:${Math.min(14, w + 3)}px"></button>`).join('');
  widthsEl.querySelectorAll<HTMLElement>('.dot').forEach(dot =>
    dot.addEventListener('click', () => { width = +dot.dataset.w!; try { localStorage.setItem(WIDTH_KEY, String(width)); } catch {} setTool('pen'); markWidth(); }));
}
function markColor(): void { byId('sketchColors').querySelectorAll<HTMLElement>('.dot').forEach(d => d.classList.toggle('active', d.dataset.color === color)); }
function markWidth(): void { byId('sketchWidths').querySelectorAll<HTMLElement>('.dot').forEach(d => d.classList.toggle('active', +d.dataset.w! === width)); }

function init(): void {
  try {
    const t = localStorage.getItem(TOOL_KEY); if (t === 'pen' || t === 'eraser') tool = t;
    const c = localStorage.getItem(COLOR_KEY); if (c) color = c;
    const w = localStorage.getItem(WIDTH_KEY); if (w && WIDTHS.includes(+w)) width = +w;
  } catch {}
  buildControls();
  markTool(); markColor(); markWidth();
  byId('sketchBtn').addEventListener('click', toggleSketchMode);
  byId('sketchPen').addEventListener('click', () => setTool('pen'));
  byId('sketchEraser').addEventListener('click', () => setTool('eraser'));
}
init();
