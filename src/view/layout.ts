// ---------- node layout: radial seeding + per-node free/line/fan/two-sided ----------
// Computes node x/y. radialLayout seeds a fresh map; applyLayouts re-flows every node per
// its own layoutType/layoutDir after any change. The node itself stays put — only its
// children (and their subtrees) move. layoutH/NODE_W/subtreeIds come from main (render +
// tree helpers) — a runtime-only cycle.
import { state, type MindNode } from '../core/state.js';
import { childrenOf, isHidden, isRoot } from '../utils/model.js';
import { subtreeIds, layoutH, nodeH, NODE_W } from '../main.js';

const LANDING_GAP = 40;   // gap below/beside the hovered card a drag-reparented child/sibling snaps to
// Where `dragged` will land if dropped onto `target` in the given mode — CHILD (top zone of the
// card) or SIBLING (bottom zone, adopts target's parent). Shared by the drop-target ghost preview
// (features/drag.ts) and the actual reparent commit, so what you see while dragging is exactly
// where the card ends up.
//
// The governing layout is TARGET's own (child mode) or TARGET's PARENT's (sibling mode) — note
// both cases resolve to the same node `dragged` would actually be re-parented onto. SIBLING mode
// also anchors the insertion: the dragged card slots in right after `target` in the governor's
// child order (not at the end), so dropping on the lower part of a middle card inserts it there,
// matching the bottom-zone hover that triggered sibling mode in the first place.
//
// For a managed layout (line/fan/two-sided) the only way to know the EXACT final spot is to run
// the real layout: applying it would also reflow target's other children (a fan re-centers, a
// chain re-packs), so a simple "just outside target's border" estimate drifts once there's more
// than one sibling. So we temporarily re-parent `dragged` onto the governor at the anchored
// order position, run the same layoutSubtree() the commit path uses, read off where it placed
// `dragged`, then revert every position/order/parent change — a dry run, no visible side effect.
// A free/unset governing layout never reflows on drop, so the cheap geometric estimate is exact
// there and a simulation would be wasted work.
export function dropLanding(dragged: MindNode, target: MindNode, mode: 'child' | 'sibling'): { x: number; y: number } {
  const governor = mode === 'child' ? target : (target.parent ? state.nodes.get(target.parent) : null) ?? target;
  const eff = effectiveLayout(governor);
  if (eff.type !== 'line' && eff.type !== 'fan' && eff.type !== 'two-sided') {
    const y = target.y + nodeH(target) + LANDING_GAP;
    return mode === 'child' ? { x: target.x + LANDING_GAP, y } : { x: target.x, y };
  }
  return simulateLanding(dragged, governor, mode === 'sibling' ? target.id : undefined);
}

// The order `governor`'s children would have if `draggedId` were inserted right after `afterId`
// (or appended at the end if `afterId` is omitted/not a current child) — everyone else keeps
// their existing relative order. Shared by the ghost-preview dry run and the real reparent commit
// so both agree on where a sibling-mode drop slots in.
export function insertedKidOrder(governor: MindNode, draggedId: string, afterId?: string): string[] {
  const kids = childrenOf(governor.id).filter(k => !isHidden(k) && k.id !== draggedId);
  const order = orderedKids(governor, kids).map(k => k.id);
  const idx = afterId ? order.indexOf(afterId) : -1;
  if (idx >= 0) order.splice(idx + 1, 0, draggedId);
  else order.push(draggedId);
  return order;
}

// Dry-run a reparent of `dragged` onto `governor` (inserted right after `afterId`, if given): re-
// parent, run the real layoutSubtree(), capture dragged's resulting position, then put every
// touched node/field back exactly as found.
function simulateLanding(dragged: MindNode, governor: MindNode, afterId?: string): { x: number; y: number } {
  const prevParent = dragged.parent;
  const prevKidOrder = governor.kidOrder ? [...governor.kidOrder] : undefined;
  const snapIds = new Set<string>();
  for (const k of childrenOf(governor.id)) if (k.id !== dragged.id) for (const id of subtreeIds(k.id)) snapIds.add(id);
  for (const id of subtreeIds(dragged.id)) snapIds.add(id);
  const snap = new Map([...snapIds].map(id => {
    const n = state.nodes.get(id)!; return [id, { x: n.x, y: n.y }] as [string, { x: number; y: number }];
  }));

  governor.kidOrder = insertedKidOrder(governor, dragged.id, afterId);
  dragged.parent = governor.id;
  layoutSubtree(governor);
  const land = { x: dragged.x, y: dragged.y };

  dragged.parent = prevParent;
  governor.kidOrder = prevKidOrder;
  for (const [id, p] of snap) { const n = state.nodes.get(id); if (n) { n.x = p.x; n.y = p.y; } }
  return land;
}

// number of leaves under a node (a collapsed node counts as a single leaf, since its
// subtree is hidden and shouldn't claim angular space)
function leafCount(id: string): number {
  const node = state.nodes.get(id);
  if (node && node.collapsed) return 1;
  const kids = childrenOf(id);
  if (kids.length === 0) return 1;
  let s = 0; for (const k of kids) s += leafCount(k.id); return s;
}
// Lay out a single subtree radially around `root`, keeping `root` where it already is
// (so re-laying a branch doesn't teleport it). Children fan out on widening rings; a
// collapsed node's subtree is skipped.
function radialLayoutFrom(root: MindNode | null | undefined): void {
  if (!root) return;
  const RING = 280;
  const ox = root.x, oy = root.y;     // pivot stays put
  const place = (node: MindNode, depth: number, a0: number, a1: number) => {
    if (depth > 0){
      const mid = (a0 + a1) / 2, radius = depth * RING;
      node.x = ox + Math.cos(mid) * radius;
      node.y = oy + Math.sin(mid) * radius;
      node.dirtyLayout = true;
    }
    if (node.collapsed) return;        // don't lay out a folded subtree
    const kids = childrenOf(node.id);
    if (!kids.length) return;
    const total = kids.reduce((s,k)=>s + leafCount(k.id), 0) || 1;
    const span  = (depth === 0) ? Math.PI*2 : (a1 - a0);
    let cur     = (depth === 0) ? -Math.PI/2 : a0;
    for (const k of kids){
      const frac = leafCount(k.id) / total;
      place(k, depth+1, cur, cur + span*frac);
      cur += span * frac;
    }
  };
  place(root, 0, 0, Math.PI*2);
}

// ---------- per-node layout (free / line / fan) ----------
// Every node carries its own layout that decides how its CHILDREN sit relative to it:
//   · free — children keep wherever they're dragged (the default; direction ignored)
//   · line — children chained one after another ALONG the direction (e.g. a column going down)
//   · fan  — children spread ACROSS the direction at one distance (the classic mindmap branch)
// `layoutDir` (left/right/top/bottom) picks the side. Line/fan nodes OWN their children's
// positions, so layout re-runs after every structural or drag change (there's no manual Tidy).
const LAYOUT_MAIN  = 60;   // gap between a card and its children along the growth axis
const LAYOUT_CROSS = 22;   // gap between FANNED sibling subtrees (spread across the side)
const LAYOUT_CHAIN = 12;   // gap between CHAINED sibling subtrees (a line along the direction)

// top/bottom are the user-facing names; internally the side axis uses up/down.
export function dirSide(dir: string | undefined): string { return dir === 'top' ? 'up' : dir === 'bottom' ? 'down' : (dir || 'right'); }

// Bounding box over a node + its VISIBLE descendants (what the layout actually placed).
function subtreeBox(node: MindNode){
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of subtreeIds(node.id)){
    const n = state.nodes.get(id); if (!n || isHidden(n)) continue;
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + NODE_W); y1 = Math.max(y1, n.y + layoutH(n));
  }
  return { x0, y0, x1, y1 };
}
function shiftSubtree(node: MindNode, dx: number, dy: number): void {
  // Saved positions are integers; layout targets are floats. Ignore sub-pixel nudges so a
  // re-opened, already-laid-out map settles to zero movement (no spurious rewrites, no drift).
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  for (const id of subtreeIds(node.id)){
    const n = state.nodes.get(id); if (!n || isHidden(n)) continue;
    n.x += dx; n.y += dy; n.dirtyLayout = true;
  }
}
// A node's EFFECTIVE layout. `none` (the default) inherits its parent's effective type AND
// direction, walking up until an explicit free/line/fan is found; a root with no explicit layout
// resolves to free (children stay where dragged).
export function effectiveLayout(node: MindNode): { type: string; dir: string } {
  let n: MindNode | null | undefined = node, guard = 0;
  while (n && guard++ < 4096){
    const t = n.layoutType || 'none';
    if (t !== 'none') return { type: t, dir: n.layoutDir || 'right' };
    n = n.parent ? state.nodes.get(n.parent) : null;
  }
  return { type: 'free', dir: 'right' };   // unset root → free
}
// Sibling order along the axis a parent stacks its children on (fan → cross axis, line → main).
// Ties break by filename so the seeded order is deterministic across reloads (folder iteration
// order is not stable, so we must never depend on it).
function kidsByPosition(node: MindNode, kids: MindNode[]): string[] {
  const eff = effectiveLayout(node);
  const side = dirSide(eff.dir), horiz = side === 'left' || side === 'right';
  const useX = (eff.type === 'fan' || eff.type === 'two-sided') ? !horiz : horiz;
  const pos = useX ? ((n: MindNode)=>n.x) : ((n: MindNode)=>n.y);
  const tie = (n: MindNode) => n.file || n.title || n.id;
  return kids.slice()
    .sort((a,b) => (pos(a)-pos(b)) || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0))
    .map(k => k.id);
}
// A parent's child order is STORED (in memory) and only changes when a child is directly
// dragged — never on an incidental relayout. So moving a parent, editing text, or collapsing
// never reshuffles children; order is seeded from saved positions the first time it's needed.
function orderedKids(node: MindNode, kids: MindNode[]): MindNode[] {
  const have = new Set(kids.map(k => k.id));
  let order = (node.kidOrder || []).filter(id => have.has(id));   // drop removed children
  const known = new Set(order);
  const fresh = kids.filter(k => !known.has(k.id));                // new children → append by position
  if (fresh.length) order = order.concat(kidsByPosition(node, fresh));
  node.kidOrder = order;
  const rank = new Map(order.map((id,i)=>[id,i]));
  return kids.slice().sort((a,b)=>rank.get(a.id)! - rank.get(b.id)!);
}
// After a drag the dropped positions are authoritative (heights didn't change), so refresh the
// sibling order of every parent that had a child moved — this is the ONLY place order changes.
export function reorderDraggedParents(movedIds: Iterable<string>): void {
  const parents = new Set<string>();
  for (const id of movedIds){ const n = state.nodes.get(id); if (n && n.parent) parents.add(n.parent); }
  for (const pid of parents){
    const p = state.nodes.get(pid); if (!p) continue;
    const t = effectiveLayout(p).type;
    if (t === 'line' || t === 'fan' || t === 'two-sided')
      p.kidOrder = kidsByPosition(p, childrenOf(p.id).filter(k => !isHidden(k)));
  }
}
// Arrange a node's children per its own layoutType/layoutDir, then recurse into them.
// The node itself stays put — only its children (and their whole subtrees) move. A `free`
// node leaves its children wherever they are. Sibling ORDER is read from the children's
// CURRENT positions, so dragging a child past a sibling reorders them on the next pass.
function layoutSubtree(node: MindNode): void {
  if (node.collapsed) return;
  const kids = childrenOf(node.id).filter(k => !isHidden(k));
  if (!kids.length) return;
  // lay out each child's own subtree first, so subtreeBox() reflects the grandchildren
  for (const k of kids) layoutSubtree(k);

  const eff  = effectiveLayout(node);                 // `none` inherits the parent's layout
  const type = eff.type;
  if (type !== 'line' && type !== 'fan' && type !== 'two-sided') return;  // free (or unset root): children stay manual

  const side  = dirSide(eff.dir);
  const horiz = side === 'left' || side === 'right';  // direction axis is x
  const boxOf = new Map(kids.map(k => [k.id, subtreeBox(k)]));
  const ax = node.x, ay = node.y;

  const sorted = orderedKids(node, kids);   // stored order — only a direct child-drag changes it

  // FAN of a given set of children to ONE side: every child the same distance out, spread
  // along the cross axis and centred on the parent. Used by `fan` (one call) and by
  // `two-sided` (two calls, left + right).
  const fanSide = (ids: MindNode[], sd: string) => {
    const hz = sd === 'left' || sd === 'right';
    const cross = ids.map(k => { const b=boxOf.get(k.id)!; return hz ? (b.y1-b.y0) : (b.x1-b.x0); });
    const total = cross.reduce((s,v)=>s+v,0) + LAYOUT_CROSS*Math.max(0, ids.length-1);
    let cur = (hz ? ay + layoutH(node)/2 : ax + NODE_W/2) - total/2;
    ids.forEach((k,i)=>{
      const b = boxOf.get(k.id)!; let dx=0, dy=0;
      if (hz){ dx = sd==='right' ? (ax+NODE_W+LAYOUT_MAIN - b.x0) : (ax-LAYOUT_MAIN - b.x1); dy = cur - b.y0; }
      else   { dy = sd==='down'  ? (ay+layoutH(node)+LAYOUT_MAIN - b.y0) : (ay-LAYOUT_MAIN - b.y1); dx = cur - b.x0; }
      shiftSubtree(k, dx, dy); cur += cross[i] + LAYOUT_CROSS;
    });
  };

  if (type === 'fan'){
    fanSide(sorted, side);
  } else if (type === 'two-sided'){
    // TWO-SIDED: spread children to BOTH ends of the direction's axis, greedily balancing the
    // two wings by cross-axis extent. dir picks the axis — left/right → a horizontal split (the
    // classic mind-map shape), up/down → a vertical split. Best on a root.
    const horizAxis = side === 'left' || side === 'right';
    const sideA = horizAxis ? 'right' : 'down', sideB = horizAxis ? 'left' : 'up';
    let a = 0, b = 0; const A: MindNode[] = [], B: MindNode[] = [];
    for (const k of sorted){
      const box = boxOf.get(k.id)!;
      const ext = horizAxis ? (box.y1 - box.y0) : (box.x1 - box.x0);
      if (a <= b){ A.push(k); a += ext + LAYOUT_CROSS; } else { B.push(k); b += ext + LAYOUT_CROSS; }
    }
    fanSide(A, sideA); fanSide(B, sideB);
  } else {
    // LINE: children chained one after another ALONG the direction, centred on the cross axis.
    // The chain grows in the direction's sign, so for left/up we walk the order in REVERSE — that
    // way the first child in stored (top-to-bottom / left-to-right) order ends up at the visual
    // top/left, not nearest the parent. (Otherwise dragging a child to the top snaps it to the bottom.)
    let cur = horiz ? (side==='right' ? ax+NODE_W+LAYOUT_MAIN : ax-LAYOUT_MAIN)
                    : (side==='down'  ? ay+layoutH(node)+LAYOUT_MAIN : ay-LAYOUT_MAIN);
    const seq = (side==='left' || side==='up') ? sorted.slice().reverse() : sorted;
    seq.forEach((k)=>{
      const b = boxOf.get(k.id)!; let dx=0, dy=0;
      if (horiz){
        const w = b.x1 - b.x0;
        dx = side==='right' ? (cur - b.x0) : (cur - b.x1);
        dy = (ay + layoutH(node)/2) - (k.y + layoutH(k)/2);   // centre child on the parent's y
        cur += side==='right' ? (w+LAYOUT_CHAIN) : -(w+LAYOUT_CHAIN);
      } else {
        const h = b.y1 - b.y0;
        dy = side==='down' ? (cur - b.y0) : (cur - b.y1);
        dx = (ax + NODE_W/2) - (k.x + NODE_W/2);          // centre child on the parent's x
        cur += side==='down' ? (h+LAYOUT_CHAIN) : -(h+LAYOUT_CHAIN);
      }
      shiftSubtree(k, dx, dy);
    });
  }
}

// Re-apply every node's layout across the whole forest. Free nodes keep their manual
// positions; line/fan nodes own their children's. Cheap enough to run after any change.
// Runs in read-only too (e.g. expanding a node must re-flow its children) — read-only just
// never persists: scheduleSave is a no-op there, so the in-memory positions are discarded
// when read-only is left and the map is reloaded from disk.
export function applyLayouts(): void {
  for (const n of state.nodes.values()) if (isRoot(n)) layoutSubtree(n);
}

// Used on first-ever load of a big map: lay every root out radially, side by side.
export function radialLayout(): void {
  const roots = [...state.nodes.values()].filter(n => isRoot(n));
  let ox = 0;
  for (const root of roots){
    root.x = ox; root.y = 0;
    radialLayoutFrom(root);
    ox += (leafCount(root.id) * 60) + 600;   // separate multiple roots
  }
}

// ---------- auto-collapse deep branches ----------
// Fold every branch at a given depth. A collapsed node folds into a "+" stub on its
// parent's edge (hiding itself + its subtree), so collapsing all nodes at `depth` leaves
// the shallower levels on screen as expandable stubs. depth = 1 → root stays, each of its
// children becomes a collapsed section you click to open.
export function collapseAtDepth(depth = 1): void {
  const depthOf = (n: MindNode) => { let d=0,p: MindNode | undefined =n; while(p && p.parent){ p=state.nodes.get(p.parent); d++; } return d; };
  for (const n of state.nodes.values()){
    n.collapsed = depthOf(n) === depth && childrenOf(n.id).length > 0;
  }
}
