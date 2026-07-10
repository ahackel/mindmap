// ---------- edge rendering ----------
// Edges are DERIVED from each node's parent (no stored edge list). This module owns the parent→child
// connector geometry for the three edge styles and paints them into the #edges SVG. It reads the
// render core's live card heights (nodeH) and branch colour (effectiveColor) from main.
import { state, backgroundsSvg, edgesSvg, togglesSvg, dragEdgesSvg, dragLayerEdges, isAnnotation, type MindNode, type LayoutSide } from '../core/state.js';
import { isRoot, isHidden } from '../utils/model.js';
import { dropLanding, sideOf, subtreeBox, isFrame, hostFrame, frameInterior } from './layout.js';
import { ui, type Pt } from '../core/ui-state.js';
import { NODE_W, nodeW, nodeH, effectiveColor, SWATCH_BG } from '../main.js';

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

function nodeCenter(n: MindNode): Pt { return { x: n.x + nodeW(n)/2, y: n.y + nodeH(n)/2 }; }
function boxCenter(box: { x: number; y: number; h: number; w?: number }): Pt { return { x: box.x + (box.w ?? NODE_W)/2, y: box.y + box.h/2 }; }
// The point on `node`'s OWN border where every child edge on `side` converges — shared by every
// child on that side (a fan bundles them from one spot), and by the socket disk drawn there.
function anchorPoint(node: MindNode, side: LayoutSide): Pt {
  const pc = nodeCenter(node);
  if (side === 'down')  return { x: pc.x, y: node.y + nodeH(node) };
  if (side === 'up')    return { x: pc.x, y: node.y };
  if (side === 'right') return { x: node.x + nodeW(node), y: pc.y };
  return { x: node.x, y: pc.y };   // left
}
const DOT_R = 5;   // radius of the socket disk marking where a side's child edges converge

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
// Build an SVG path `d` for a parent→box edge in the current style:
//   straight    — one diagonal segment between the facing borders
//   orthogonal  — right-angle elbow with rounded corners (H & V only)
//   bezier      — smooth curve with tangents along the dominant axis
// Takes a plain box (x/y/h) rather than a MindNode so it can also draw the dashed
// parent→landing-spot preview edge while a card is poised to reparent on drop — `side` is
// the STORED side for a real child (sideOf) or the drop's resolved side for the preview
// (ui.drag.dropSide), never recomputed from the box position here.
// Path `d` between two points in the current edge style. `horizontal` picks the dominant axis
// (elbow orientation / bezier tangents). Shared by parent→child edges (edgePathBox) and the grid
// container's single parent→frame connector.
function connect(a: Pt, b: Pt, horizontal: boolean): string {
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
function edgePathBox(parent: MindNode, box: { x: number; y: number; h: number; w?: number }, side: LayoutSide): string {
  const cc = boxCenter(box);
  const horizontal = side === 'left' || side === 'right';
  const a = anchorPoint(parent, side);
  let b: Pt;
  if (side === 'down')      b = { x:cc.x, y:box.y };
  else if (side === 'up')   b = { x:cc.x, y:box.y + box.h };
  else if (side === 'right')b = { x:box.x, y:cc.y };
  else                      b = { x:box.x + (box.w ?? NODE_W), y:cc.y };
  return connect(a, b, horizontal);
}
function edgePath(parent: MindNode, child: MindNode): string {
  return edgePathBox(parent, { x: child.x, y: child.y, h: nodeH(child) }, sideOf(parent, child));
}
// While poised over a valid reparent target, the box the dragged card will land in once
// dropped (see features/drag.ts landing-ghost) plus the new parent it'll connect to and the
// side it'll land on — or null if there's no active/valid drop target. The landing spot depends
// on which zone of the hovered card is poised (child: nested below, offset right; sibling:
// aligned below).
function previewReparent(): { parent: MindNode; box: { x: number; y: number; h: number }; side: LayoutSide } | null {
  const drag = ui.drag;
  if (!drag || !drag.dropTarget || !drag.dropSide) return null;
  // annotations preview as just a dashed outline on the candidate parent (drag.ts) — no would-be edge
  if (isAnnotation(drag.active)) return null;
  // Whenever the insertion bar is the preview (in-parent reorder — which always resolves a gap
  // segment — or a reparent joining a managed branch's existing children), the dragged card is
  // hidden and the bar alone marks the slot — a dashed edge into empty space would dangle, so
  // it stands down too.
  if (drag.dropLine) return null;
  const tgtNode = state.nodes.get(drag.dropTarget);
  if (!tgtNode) return null;
  const parent = drag.dropMode === 'sibling'
    ? (tgtNode.parent ? state.nodes.get(tgtNode.parent) : null)
    : tgtNode;
  if (!parent) return null;
  // Dropping into a frame previews as the frame's own outline highlight (.drop-target), not a
  // dashed edge into a landing spot — the card lands wherever released, so an edge would mislead.
  if (isFrame(parent)) return null;
  const h = nodeH(drag.active);
  const land = dropLanding(drag.active, tgtNode, drag.dropMode, drag.dropSide, drag.dropAfter);
  return { parent, box: { x: land.x, y: land.y, h }, side: drag.dropSide };
}
const BG_PAD = 20;      // margin around the enclosed cards — hugs the bounds, kept a multiple of 20
const BG_R = 16;         // corner radius — card radius (8) + a step, still not pill-shaped
const BG_ALPHA = 0.16;  // fill opacity — translucent, reads as a tint rather than a card
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = m.slice(1).map(h => parseInt(h, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}
// Frame content is DOM-clipped (main.ts .frame-content), but edges/backgrounds live in their own
// global, unclipped SVGs — a connector or group-background rect involving a card hosted inside a
// frame needs its own clip-path to the SAME bounds, or it can poke past the frame's border even
// though the card itself can't. `frameClipId` names the <clipPath>; `frameClipDefs` renders one per
// frame actually referenced, sized via the shared `frameInterior` (layout.ts) so this stays
// pixel-identical to main.ts's DOM wrapper by construction.
function frameClipId(f: MindNode): string { return `frame-clip-${f.id}`; }
function frameClipDefs(hosts: Set<string>): string {
  if (!hosts.size) return '';
  let defs = '';
  for (const id of hosts) {
    const f = state.nodes.get(id); if (!f) continue;
    const { x, y, w, h } = frameInterior(f);
    defs += `<clipPath id="${frameClipId(f)}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath>`;
  }
  return `<defs>${defs}</defs>`;
}
// A node's own "group background" (mm_bg) encloses it + all its VISIBLE descendants — drawn
// behind everything else (see #backgrounds z-index in styles.css). Nested enclosures (a
// descendant also has its background on) are fine: painted largest-first so a parent's bigger
// rect sits behind, and each smaller descendant rect layers on top of it.
function paintBackgrounds(): void {
  if (state.searchMatch) { backgroundsSvg.innerHTML = ''; return; }
  const rects: { area: number; markup: string }[] = [];
  const hosts = new Set<string>();
  for (const n of state.nodes.values()) {
    if (!n.bg || isHidden(n)) continue;
    const box = subtreeBox(n);
    if (!isFinite(box.x0)) continue;
    const x = box.x0 - BG_PAD, y = box.y0 - BG_PAD;
    const w = (box.x1 - box.x0) + BG_PAD * 2, h = (box.y1 - box.y0) + BG_PAD * 2;
    const fill = hexToRgba(SWATCH_BG[effectiveColor(n)] ?? SWATCH_BG.grey, BG_ALPHA);
    const host = hostFrame(n);
    const clip = host ? ` clip-path="url(#${frameClipId(host)})"` : '';
    if (host) hosts.add(host.id);
    rects.push({
      area: w * h,
      markup: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${BG_R}" fill="${fill}"${clip}/>`,
    });
  }
  rects.sort((a, b) => b.area - a.area);   // biggest enclosure first (behind), smaller ones on top
  backgroundsSvg.innerHTML = frameClipDefs(hosts) + rects.map(r => r.markup).join('');
}
export function paintEdges(): void {
  paintBackgrounds();
  // While filtering, hide ALL lines — dimmed cards are semi-transparent, so faint lines would
  // show through them and read as clutter. Cleaner to drop the lines entirely until search ends.
  if (state.searchMatch){ edgesSvg.innerHTML = ''; togglesSvg.innerHTML = ''; dragEdgesSvg.innerHTML = ''; dragLayerEdges.innerHTML = ''; return; }
  // Collect edges first so they can be painted furthest-first: softened (faint) long edges go
  // down before crisp short ones, so a close, opaque connector never gets dulled by a faint one
  // crossing over it.
  const entries: { dist: number; path: string }[] = [];
  // Every parent's occupied sides — a socket disk marks each one, at the point its children's
  // edges converge (see anchorPoint), tinted to match the PARENT card (its own socket).
  const occupiedSides = new Map<string, Set<LayoutSide>>();
  const hosts = new Set<string>();   // frames referenced by a clip-path below — see frameClipDefs
  let annos = '';   // annotation connectors: always dotted, tinted by the annotation's own colour,
                    // NEVER clipped, drawn on top (dragEdgesSvg) — see the isAnnotation branch below
  let dragged = '';   // connectors of the currently-dragged items — routed to #dragLayer's own SVG so
                      // they dim as part of the same opacity group as the dragged cards (no shine-through)
  const inDragGroup = (id: string): boolean => !!(ui.drag && ui.drag.moved && ui.drag.targets.has(id));
  // Draw a connector for every parent→child edge where BOTH ends are visible.
  // A collapsed node hides its children, so those edges simply don't appear.
  for (const n of state.nodes.values()) {
    if (isRoot(n)) continue;
    const parent = n.parent ? state.nodes.get(n.parent) : null;
    if (!parent) continue;
    if (isHidden(parent) || isHidden(n)) continue;
    // Drag suppressions — apply to EVERY connector incl. annotations, so a card/annotation that's
    // Alt-detaching, poised over a NEW parent, cloned, or ripped past threshold drops its OLD
    // connector entirely (the preview/border shows the pending result instead). Checked before the
    // annotation branch so a ripped annotation hides its edge exactly like a card.
    if (ui.drag && ui.drag.alt && !ui.drag.shift && ui.drag.n.id === n.id) continue;
    if (ui.drag && ui.drag.dropTarget && ui.drag.targets.has(n.id) && !ui.drag.targets.has(parent.id)) continue;
    if (ui.drag && ui.drag.cloned && ui.drag.targets.has(n.id)) continue;
    if (ui.drag && ui.drag.rip && ui.drag.active.id === n.id) continue;
    // An annotation is pinned on top of its parent: draw a dotted connector tinted by the
    // annotation's OWN colour, with a matching anchor dot on the parent — unclipped, drawn even
    // when the parent is a frame (which otherwise draws no edges). When the annotation is being
    // dragged it joins the drag opacity group; otherwise it rides the top overlay (dragEdgesSvg).
    if (isAnnotation(n)) {
      const tint = SWATCH_BG[effectiveColor(n)] ?? 'var(--edge)';
      // straight line from the annotation's CENTRE to the CLOSEST point on the parent's bounds
      // (clamp the centre into the parent rect), with the anchor dot at that closest point.
      const ax = n.x + nodeW(n)/2, ay = n.y + nodeH(n)/2;
      const bx = Math.max(parent.x, Math.min(ax, parent.x + nodeW(parent)));
      const by = Math.max(parent.y, Math.min(ay, parent.y + nodeH(parent)));
      const els = `<path class="anno-edge" style="stroke:${tint}" stroke-dasharray="2 6" d="M ${ax} ${ay} L ${bx} ${by}"/>`
        + `<circle class="edge-dot" cx="${bx}" cy="${by}" r="${DOT_R}" fill="${tint}"/>`;
      if (inDragGroup(n.id)) dragged += els; else annos += els;
      continue;
    }
    // A frame IS the container (its own box holds the children), so it draws no child edges.
    if (isFrame(parent)) continue;
    // tint by the child's branch colour; soften by how far the child sits from its parent
    const tint = SWATCH_BG[effectiveColor(n)];
    const dist = Math.hypot(n.x - parent.x, n.y - parent.y);
    const style = `stroke:${tint ?? 'var(--edge)'};opacity:${edgeOpacity(dist).toFixed(2)}`;
    const side = sideOf(parent, n);
    // Both ends share the same host frame whenever this edge is drawn at all (parent's never a
    // frame here — see the isFrame(parent) skip above — so walking from either end lands on the
    // same nearest enclosing frame, if any).
    const d = edgePathBox(parent, { x:n.x, y:n.y, h:nodeH(n), w:nodeW(n) }, side);
    if (inDragGroup(n.id)) {
      // a dragged item's connector joins its opacity group (unclipped — the dragged cards lift out
      // of any frame clip while dragging, so their edges must too)
      dragged += `<path style="${style}" d="${d}"/>`;
    } else {
      const host = hostFrame(n);
      const clip = host ? ` clip-path="url(#${frameClipId(host)})"` : '';
      if (host) hosts.add(host.id);
      entries.push({ dist, path: `<path style="${style}"${clip} d="${d}"/>` });
    }
    let sides = occupiedSides.get(parent.id); if (!sides) occupiedSides.set(parent.id, sides = new Set());
    sides.add(side);
  }
  entries.sort((a, b) => b.dist - a.dist);   // furthest (faintest) first, crispest on top
  let svg = entries.map(e => e.path).join('');   // all connectors, behind the cards
  let top = '';    // reparent-preview overlay (dashed would-be edge + anchor dot)
  for (const [pid, sides] of occupiedSides) {
    const p = state.nodes.get(pid); if (!p) continue;
    const tint = branchTint(p);
    // A dragged parent's socket dot joins the drag opacity group (unclipped); otherwise it sits on
    // the parent's own border and clips right alongside its edges.
    const grouped = inDragGroup(pid);
    const host = grouped ? null : hostFrame(p);
    const clip = host ? ` clip-path="url(#${frameClipId(host)})"` : '';
    if (host) hosts.add(host.id);
    for (const side of sides) {
      const pt = anchorPoint(p, side);
      const dot = `<circle class="edge-dot"${clip} cx="${pt.x}" cy="${pt.y}" r="${DOT_R}" fill="${tint}"/>`;
      if (grouped) dragged += dot; else svg += dot;
    }
  }
  // Dashed preview: while poised over a valid reparent target, draw the would-be new
  // parent→landing-spot connection so the result is clear before you let go — white, like the
  // anchor dot it leads to, not tinted to the dragged card, and drawn in the top overlay so it
  // sits above every other card/edge.
  const preview = previewReparent();
  const topHosts = new Set<string>();
  if (preview) {
    const host = hostFrame(preview.parent);
    const clip = host ? ` clip-path="url(#${frameClipId(host)})"` : '';
    if (host) topHosts.add(host.id);
    top += `<path class="ghost-edge" style="stroke:white"${clip} stroke-dasharray="6 5" d="${edgePathBox(preview.parent, preview.box, preview.side)}"/>`;
    const pt = anchorPoint(preview.parent, preview.side);
    top += `<circle class="edge-dot edge-dot-preview"${clip} cx="${pt.x}" cy="${pt.y}" r="${DOT_R + 1}" fill="white"/>`;
  }
  edgesSvg.innerHTML = frameClipDefs(hosts) + svg;
  // annotation connectors ride the same above-cards layer as the drag preview (unclipped) so they
  // sit over normal cards/frames but under the annotation card itself (z-index:7 vs dragEdges' 4).
  dragEdgesSvg.innerHTML = frameClipDefs(topHosts) + annos + top;
  // the dragged items' connectors live inside #dragLayer so they share the cards' opacity group
  dragLayerEdges.innerHTML = dragged;
  togglesSvg.innerHTML = '';             // no edge toggles anymore
}
