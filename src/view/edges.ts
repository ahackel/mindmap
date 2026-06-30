// ---------- edge rendering ----------
// Edges are DERIVED from each node's parent (no stored edge list). This module owns the parent→child
// connector geometry for the three edge styles and paints them into the #edges SVG. It reads the
// render core's live card heights (nodeH) and branch colour (effectiveColor) from main.
import { state, edgesSvg, togglesSvg, type MindNode } from '../core/state.js';
import { isRoot, isHidden } from '../utils/model.js';
import { effectiveLayout, dirSide } from './layout.js';
import { ui, type Pt } from '../core/ui-state.js';
import { NODE_W, nodeH, effectiveColor } from '../main.js';

// Bright per-branch line colours (match the .c-*-cardline borders); 'none' falls back to --edge.
const EDGE_TINT: Record<string, string> = { slate:'#7088e0', red:'#f25c72', amber:'#f2ab44', green:'#3fcf81',
  teal:'#33c5d8', blue:'#5fa3f5', violet:'#9d70f0', pink:'#f262ad', grey:'#4a5a6e' };
const EDGE_R = 12;   // corner radius on orthogonal elbows

function nodeCenter(n: MindNode): Pt { return { x: n.x + NODE_W/2, y: n.y + nodeH(n)/2 }; }

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
function edgeSide(parent: MindNode, child: MindNode): string {
  // Use the EFFECTIVE layout, not the raw field: a node with type `none` that inherits
  // line/fan from an ancestor owns its children's side too, so its edges must leave from
  // the inherited direction's border — otherwise an inherited-fan node draws free-style
  // edges and looks different from an explicit-fan node with the same placement.
  const eff = effectiveLayout(parent);
  if (eff.type === 'line' || eff.type === 'fan') return dirSide(eff.dir);
  const pc = nodeCenter(parent), cc = nodeCenter(child);
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
// Build an SVG path `d` for a parent→child edge in the current style:
//   straight    — one diagonal segment between the facing borders
//   orthogonal  — right-angle elbow with rounded corners (H & V only)
//   bezier      — smooth curve with tangents along the dominant axis
function edgePath(parent: MindNode, child: MindNode): string {
  const pc = nodeCenter(parent), cc = nodeCenter(child);
  const side = edgeSide(parent, child);
  const horizontal = side === 'left' || side === 'right';
  let a: Pt, b: Pt;
  if (side === 'down')      { a = { x:pc.x, y:parent.y + nodeH(parent) }; b = { x:cc.x, y:child.y }; }
  else if (side === 'up')   { a = { x:pc.x, y:parent.y };                 b = { x:cc.x, y:child.y + nodeH(child) }; }
  else if (side === 'right'){ a = { x:parent.x + NODE_W, y:pc.y };        b = { x:child.x, y:cc.y }; }
  else                      { a = { x:parent.x, y:pc.y };                 b = { x:child.x + NODE_W, y:cc.y }; }
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
export function paintEdges(): void {
  // While filtering, hide ALL lines — dimmed cards are semi-transparent, so faint lines would
  // show through them and read as clutter. Cleaner to drop the lines entirely until search ends.
  if (state.searchMatch){ edgesSvg.innerHTML = ''; togglesSvg.innerHTML = ''; return; }
  let svg = '';
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
    // Poised over a valid new parent (the card is shown as a dotted ghost): hide its old
    // parent edge too, so the line doesn't dangle from a card that's about to move.
    if (ui.drag && ui.drag.dropTarget && ui.drag.active.id === n.id) continue;
    // While Shift-cloning, the dragged copies aren't placed yet — don't draw their parent edges.
    if (ui.drag && ui.drag.cloned && ui.drag.targets.has(n.id)) continue;
    // Rip threshold reached: draw the edge dashed as a "about to snap" signal.
    const ripping = !!(ui.drag && ui.drag.rip && ui.drag.active.id === n.id);
    // tint by the child's branch colour
    const tint = EDGE_TINT[effectiveColor(n)];
    const style = tint ? ` style="stroke:${tint}"` : '';
    const dash = ripping ? ' stroke-dasharray="6 5" opacity="0.5"' : '';
    svg += `<path${style}${dash} d="${edgePath(parent, n)}"/>`;
  }
  edgesSvg.innerHTML = svg;
  togglesSvg.innerHTML = '';             // no edge toggles anymore
}
