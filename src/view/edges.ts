// ---------- edge rendering ----------
// Edges are DERIVED from each node's parent (no stored edge list). This module owns the parent→child
// connector geometry for the three edge styles and paints them into the #edges SVG. It reads the
// render core's live card heights (nodeH) and branch colour (effectiveColor) from main.
import { state, edgesSvg, togglesSvg, dragEdgesSvg, type MindNode } from '../core/state.js';
import { isRoot, isHidden } from '../utils/model.js';
import { effectiveLayout, dirSide, dropLanding } from './layout.js';
import { ui, type Pt } from '../core/ui-state.js';
import { NODE_W, nodeH, effectiveColor, SWATCH_BG } from '../main.js';

const EDGE_R = 12;   // corner radius on orthogonal elbows
// Longer parent→child edges read as more "distant" if they're softened — full opacity up close,
// fading toward EDGE_MIN_OPACITY past EDGE_FADE_FAR. Distances are in world/canvas px (zoom-
// independent since both ends live in the same #world coordinate space).
const EDGE_FADE_NEAR = 320;
const EDGE_FADE_FAR = 1400;
const EDGE_MIN_OPACITY = 0.35;
function edgeOpacity(dist: number): number {
  if (dist <= EDGE_FADE_NEAR) return 1;
  if (dist >= EDGE_FADE_FAR) return EDGE_MIN_OPACITY;
  const t = (dist - EDGE_FADE_NEAR) / (EDGE_FADE_FAR - EDGE_FADE_NEAR);
  return 1 - t * (1 - EDGE_MIN_OPACITY);
}

// The branch tint for a node's effective colour — the same --card fill used by the card itself
// (SWATCH_BG), so an edge always reads as "the same colour as the card it connects to". Shared by
// the dragged card's edges, the reparent-preview edge and the landing-ghost border; 'none' falls
// back to --edge (see the inline `tint` lookup in paintEdges below).
export function branchTint(n: MindNode): string { return SWATCH_BG[effectiveColor(n)] ?? SWATCH_BG.grey; }

function nodeCenter(n: MindNode): Pt { return { x: n.x + NODE_W/2, y: n.y + nodeH(n)/2 }; }
function boxCenter(box: { x: number; y: number; h: number }): Pt { return { x: box.x + NODE_W/2, y: box.y + box.h/2 }; }

// polyline → path with rounded corners (quadratic at each interior vertex, clamped to leg length)
function roundedPath(pts: Pt[], r: number): string {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length-1; i++){
    const p = pts[i], prev = pts[i-1], next = pts[i+1];
    const toward = (q: Pt, dist: number): Pt => {
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
// Which border a parent→child edge leaves from. A line/fan parent owns its children's side,
// so every edge leaves from its layoutDir border; a free parent connects each child from the
// nearest dominant-axis border (so a child dragged left connects on the left, etc.).
function edgeSideToCenter(parent: MindNode, cc: Pt): string {
  // Use the EFFECTIVE layout, not the raw field: a node with type `none` that inherits
  // line/fan from an ancestor owns its children's side too, so its edges must leave from
  // the inherited direction's border — otherwise an inherited-fan node draws free-style
  // edges and looks different from an explicit-fan node with the same placement.
  const eff = effectiveLayout(parent);
  if (eff.type === 'line' || eff.type === 'fan') return dirSide(eff.dir);
  const pc = nodeCenter(parent);
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
// Which border a parent→child edge leaves from. A line/fan parent owns its children's side,
// so every edge leaves from its layoutDir border; a free parent connects each child from the
// nearest dominant-axis border (so a child dragged left connects on the left, etc.).
function edgeSide(parent: MindNode, child: MindNode): string { return edgeSideToCenter(parent, nodeCenter(child)); }
// Build an SVG path `d` for a parent→box edge in the current style:
//   straight    — one diagonal segment between the facing borders
//   orthogonal  — right-angle elbow with rounded corners (H & V only)
//   bezier      — smooth curve with tangents along the dominant axis
// Takes a plain box (x/y/h) rather than a MindNode so it can also draw the dashed
// parent→landing-spot preview edge while a card is poised to reparent on drop.
function edgePathBox(parent: MindNode, box: { x: number; y: number; h: number }): string {
  const pc = nodeCenter(parent), cc = boxCenter(box);
  const side = edgeSideToCenter(parent, cc);
  const horizontal = side === 'left' || side === 'right';
  let a: Pt, b: Pt;
  if (side === 'down')      { a = { x:pc.x, y:parent.y + nodeH(parent) }; b = { x:cc.x, y:box.y }; }
  else if (side === 'up')   { a = { x:pc.x, y:parent.y };                 b = { x:cc.x, y:box.y + box.h }; }
  else if (side === 'right'){ a = { x:parent.x + NODE_W, y:pc.y };        b = { x:box.x, y:cc.y }; }
  else                      { a = { x:parent.x, y:pc.y };                 b = { x:box.x + NODE_W, y:cc.y }; }
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
function edgePath(parent: MindNode, child: MindNode): string {
  return edgePathBox(parent, { x: child.x, y: child.y, h: nodeH(child) });
}
// While poised over a valid reparent target, the box the dragged card will land in once
// dropped (see features/drag.ts landing-ghost) plus the new parent it'll connect to —
// or null if there's no active/valid drop target. The landing spot depends on which zone
// of the hovered card is poised (child: nested below, offset right; sibling: aligned below).
function previewReparent(): { parent: MindNode; box: { x: number; y: number; h: number } } | null {
  const drag = ui.drag;
  if (!drag || !drag.dropTarget) return null;
  const tgtNode = state.nodes.get(drag.dropTarget);
  if (!tgtNode) return null;
  const parent = drag.dropMode === 'sibling'
    ? (tgtNode.parent ? state.nodes.get(tgtNode.parent) : null)
    : tgtNode;
  if (!parent) return null;
  const h = nodeH(drag.active);
  const land = dropLanding(drag.active, tgtNode, drag.dropMode);
  return { parent, box: { x: land.x, y: land.y, h } };
}
export function paintEdges(): void {
  // While filtering, hide ALL lines — dimmed cards are semi-transparent, so faint lines would
  // show through them and read as clutter. Cleaner to drop the lines entirely until search ends.
  if (state.searchMatch){ edgesSvg.innerHTML = ''; togglesSvg.innerHTML = ''; dragEdgesSvg.innerHTML = ''; return; }
  // Collect edges first so they can be painted furthest-first: softened (faint) long edges go
  // down before crisp short ones, so a close, opaque connector never gets dulled by a faint one
  // crossing over it.
  const entries: { dist: number; path: string; top: boolean }[] = [];
  // Draw a connector for every parent→child edge where BOTH ends are visible.
  // A collapsed node hides its children, so those edges simply don't appear.
  for (const n of state.nodes.values()) {
    if (isRoot(n)) continue;
    const parent = n.parent ? state.nodes.get(n.parent) : null;
    if (!parent) continue;
    if (isHidden(parent) || isHidden(n)) continue;
    // While Alt-dragging this node we're previewing detach-to-root, so drop its parent
    // edge entirely (no line, not even a dotted one).
    if (ui.drag && ui.drag.alt && !ui.drag.shift && ui.drag.n.id === n.id) continue;
    // Poised over a valid new parent (the dragged subtree is hidden behind the landing
    // ghost): hide every edge whose CHILD end is in that subtree — covers both the root's
    // own parent edge and any internal parent→child edges among its dragged descendants
    // (the subtree is closed under descendants, so checking `n` alone is enough) — so
    // nothing dangles off cards that are no longer visible.
    if (ui.drag && ui.drag.dropTarget && ui.drag.targets.has(n.id)) continue;
    // While Shift-cloning, the dragged copies aren't placed yet — don't draw their parent edges.
    if (ui.drag && ui.drag.cloned && ui.drag.targets.has(n.id)) continue;
    // Rip threshold reached: it's about to detach, so drop its parent edge entirely — same
    // treatment as the Alt-detach preview above, not a dashed line.
    if (ui.drag && ui.drag.rip && ui.drag.active.id === n.id) continue;
    // tint by the child's branch colour; soften by how far the child sits from its parent
    const tint = SWATCH_BG[effectiveColor(n)];
    const dist = Math.hypot(n.x - parent.x, n.y - parent.y);
    const style = `stroke:${tint ?? 'var(--edge)'};opacity:${edgeOpacity(dist).toFixed(2)}`;
    const path = `<path style="${style}" d="${edgePath(parent, n)}"/>`;
    // edges of the dragged subtree ride in the top overlay so they're never hidden behind cards
    entries.push({ dist, path, top: !!(ui.drag && ui.drag.targets.has(n.id)) });
  }
  entries.sort((a, b) => b.dist - a.dist);   // furthest (faintest) first, crispest on top
  let svg = '';    // normal edges, behind the cards
  let top = '';    // drag-time edges (dragged subtree + reparent preview), in the top overlay
  for (const e of entries) { if (e.top) top += e.path; else svg += e.path; }
  // Dashed preview: while poised over a valid reparent target, draw the would-be new
  // parent→landing-spot connection so the result is clear before you let go. Tinted to match
  // the dragged card, and drawn in the top overlay so it sits above every other card/edge.
  const preview = previewReparent();
  if (preview) {
    top += `<path class="ghost-edge" style="stroke:${branchTint(ui.drag!.active)}" stroke-dasharray="6 5" d="${edgePathBox(preview.parent, preview.box)}"/>`;
  }
  edgesSvg.innerHTML = svg;
  dragEdgesSvg.innerHTML = top;
  togglesSvg.innerHTML = '';             // no edge toggles anymore
}
