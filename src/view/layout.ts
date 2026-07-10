// ---------- node layout: per-node free/line/fan ----------
// Computes node x/y. applyLayouts re-flows every node per
// its own layoutType after any change. The node itself stays put — only its children (and
// their subtrees) move. A child's SIDE (left/right/up/down) is STORED (MindNode.side, mm_side
// in frontmatter) — set explicitly by a drop, or backfilled once from position (see sideOf/
// deriveSide below) on load or first use, but never re-derived afterward. That avoids a fan's
// own placement (spreading same-side siblings wide) ever flipping a child's side purely as a
// side effect of laying it out. layoutH/NODE_W/subtreeIds come from main (render + tree
// helpers) — a runtime-only cycle.
import { state, isFrameLayout, type MindNode, type LayoutSide } from '../core/state.js';
import type { Seg } from '../core/ui-state.js';
import { childrenOf, isHidden, isRoot } from '../utils/model.js';
import { subtreeIds, layoutH, nodeH, nodeW, NODE_W, GRID_SNAP, FRAME_BORDER } from '../main.js';

// ---------- absolute <-> relative position ----------
// Two forms of a node's position: the WORKING form x/y (absolute world coords, what the layout
// and drag engines read and mutate) and the PERSISTED form rx/ry (offset from the parent, world
// origin for a root — what serializeMd writes as mm_position_x/y). commitRel() derives the
// persisted form from the working form; it's the only bridge, called just before every save
// (saveAll / exportZip). Load does the reverse — see data/persistence.ts loadFromDir.
export function commitRel(): void {
  for (const n of state.nodes.values()) {
    const p = n.parent ? state.nodes.get(n.parent) : null;
    n.rx = n.x - (p ? p.x : 0);
    n.ry = n.y - (p ? p.y : 0);
  }
}

const LANDING_GAP = 40;   // gap below/beside the hovered card a drag-reparented child/sibling snaps to
// Where `dragged` will land if dropped onto `target` in the given mode — CHILD (edge zone of the
// card, attaching on whichever side the drop point is near) or SIBLING (centre zone, adopts
// target's parent and lands on target's side). Shared by the drop-target ghost preview
// (features/drag.ts) and the actual reparent commit, so what you see while dragging is exactly
// where the card ends up.
//
// The governing layout is TARGET's own (child mode) or TARGET's PARENT's (sibling mode) — note
// both cases resolve to the same node `dragged` would actually be re-parented onto. SIBLING mode
// also anchors the insertion: the dragged card slots in right after `target` in the governor's
// child order (not at the end), so dropping near the middle of a card among several siblings
// inserts it there, matching the centre-zone hover that triggered sibling mode in the first place.
//
// For a managed layout (line/fan) the only way to know the EXACT final spot is to run the real
// layout: applying it would also reflow target's other children (a fan re-centers, a chain
// re-packs), so a simple "just outside target's border" estimate drifts once there's more than
// one sibling on that side. So we temporarily re-parent `dragged` onto the governor (with `side`
// set — the drop resolved it, see drag.ts updateDropTarget) at the anchored order position, run
// the same layoutSubtree() the commit path uses, read off where it placed `dragged`, then revert
// every position/order/parent/side change — a dry run, no visible side effect. A free/unset
// governing layout never reflows on drop, so the cheap geometric estimate is exact there and a
// simulation would be wasted work (though `side` is still what the caller stores on commit).
// REORDER mode (in-parent, no hovered card): `target` IS dragged's current parent — always a
// line/fan governor (the caller checks), so it always takes the simulation path below.
// `afterId` is the explicit insertion anchor when the caller resolved one (`null` = front of
// the order, `undefined` = default: after `target` in sibling mode, append in child mode).
export function dropLanding(dragged: MindNode, target: MindNode, mode: 'child' | 'sibling' | 'reorder', side: LayoutSide, afterId?: string | null): { x: number; y: number } {
  const governor = mode === 'child' || mode === 'reorder' ? target : (target.parent ? state.nodes.get(target.parent) : null) ?? target;
  // A frame adopts the card where it's released, snapped to the grid RELATIVE to the frame's
  // origin (its children live in the frame's coordinate space).
  if (isFrame(governor)) {
    const rel = (v: number, o: number): number => Math.round((v - o) / GRID_SNAP) * GRID_SNAP + o;
    return { x: rel(dragged.x, governor.x), y: rel(dragged.y, governor.y) };
  }
  if (!isManagedLayout(governor)) {
    // Nudge the cross-axis in child mode (a fresh attachment, offset from target) but keep it
    // aligned with target in sibling mode (it's slotting into target's own spot). `side` is the
    // side of TARGET the card is docking against — same geometry regardless of which side that is.
    const nudge = mode === 'child' ? LANDING_GAP : 0;
    switch (side) {
      case 'up':    return { x: target.x + nudge, y: target.y - nodeH(dragged) - LANDING_GAP };
      case 'left':  return { x: target.x - NODE_W - LANDING_GAP, y: target.y + nudge };
      case 'right': return { x: target.x + NODE_W + LANDING_GAP, y: target.y + nudge };
      default:      return { x: target.x + nudge, y: target.y + nodeH(target) + LANDING_GAP };
    }
  }
  return simulateLanding(dragged, governor, side, afterId !== undefined ? afterId : (mode === 'sibling' ? target.id : undefined));
}

// The order `governor`'s children would have if `draggedId` were inserted right after `afterId`
// (`null` = at the FRONT of the order; omitted/not a current child = appended at the end) —
// everyone else keeps their existing relative order. Shared by the ghost-preview dry run and the
// real reparent commit so both agree on where a sibling/reorder drop slots in. (Front-of-order is
// also front of dragged's own side bucket, since bucketing preserves the global relative order.)
export function insertedKidOrder(governor: MindNode, draggedId: string, afterId?: string | null): string[] {
  const kids = childrenOf(governor.id).filter(k => !isHidden(k) && k.id !== draggedId);
  const order = orderedKids(governor, kids).map(k => k.id);
  if (afterId === null) { order.unshift(draggedId); return order; }
  const idx = afterId ? order.indexOf(afterId) : -1;
  if (idx >= 0) order.splice(idx + 1, 0, draggedId);
  else order.push(draggedId);
  return order;
}

// Dry-run a reparent of `dragged` onto `governor` (inserted right after `afterId`, if given) with
// `side` set (so bucketing sees the drop's resolved side, not whatever `dragged` had before): re-
// parent, run the real layoutSubtree(), capture dragged's resulting position, then put every
// touched node/field back exactly as found.
function simulateLanding(dragged: MindNode, governor: MindNode, side: LayoutSide, afterId?: string | null): { x: number; y: number } {
  const prevParent = dragged.parent;
  const prevSide = dragged.side;
  const prevKidOrder = governor.kidOrder ? [...governor.kidOrder] : undefined;
  const snapIds = new Set<string>();
  for (const k of childrenOf(governor.id)) if (k.id !== dragged.id) for (const id of subtreeIds(k.id)) snapIds.add(id);
  for (const id of subtreeIds(dragged.id)) snapIds.add(id);
  const snap = new Map([...snapIds].map(id => {
    const n = state.nodes.get(id)!; return [id, { x: n.x, y: n.y }] as [string, { x: number; y: number }];
  }));

  governor.kidOrder = insertedKidOrder(governor, dragged.id, afterId);
  dragged.parent = governor.id;
  dragged.side = side;
  layoutSubtree(governor);
  const land = { x: dragged.x, y: dragged.y };

  dragged.parent = prevParent;
  dragged.side = prevSide;
  governor.kidOrder = prevKidOrder;
  for (const [id, p] of snap) { const n = state.nodes.get(id); if (n) { n.x = p.x; n.y = p.y; } }
  return land;
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
// Both are multiples of GRID_SNAP so flowed content stays grid-aligned: the frame's own x/y/w/h
// are already grid multiples (position/resize snap), and every child's w/h is too (NODE_W=200,
// heights rounded up to the grid in main.ts's snapCardHeights) — so keeping these constants (and
// the flow gap below) grid multiples means every computed cx/cy stays on the grid, with no
// runtime rounding needed.
const FRAME_PAD = 20;       // inset from a frame's border to its content area (flow arrange)
const FRAME_TITLE_H = 40;   // top strip a frame reserves for its title, above the flowed content
const FRAME_FLOW_GAP = 20;  // gap between flowed children — GRID_SNAP, not the line/fan LAYOUT_CHAIN
// Cross-axis tolerance for clustering a flow frame's children into rows/columns when (re)seeding
// order from raw position (kidsByPosition) — roughly half a default card's row pitch (40 height +
// 20 gap), so a genuinely different row/column always exceeds it while hand-placed jitter within
// an intended row doesn't fracture into singleton bands.
const FLOW_BAND_TOL = 30;

// Bounding box over a node + its VISIBLE descendants (what the layout actually placed).
export function subtreeBox(node: MindNode){
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  // Union the visible subtree's boxes — but a FRAME is bounded by its OWN box (mm_w/mm_h): its
  // children live INSIDE it, so we count the frame's box and DON'T descend into its content.
  // Otherwise a fan/line/grid parent would size a frame child by its content and re-space it (and
  // shift the frame's children with it) whenever the frame is expanded or its content changes.
  const walk = (n: MindNode): void => {
    if (isHidden(n)) return;
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + nodeW(n)); y1 = Math.max(y1, n.y + layoutH(n));
    if (isFrame(n)) return;   // frame footprint = its box; its children are contained within it
    for (const c of childrenOf(n.id)) walk(c);
  };
  walk(node);
  return { x0, y0, x1, y1 };
}
// A node whose children live freely inside a resizable container box (mm_w/mm_h). Unlike free, it
// draws that box (see main.ts paintNode) and adopts cards dropped inside / detaches cards dragged
// out (see features/drag.ts). Its children aren't repositioned by layout (they stay where placed).
// A COLLAPSED frame folds to an ordinary card (children hidden), so it isn't a frame while folded —
// its footprint and behaviour revert to a normal card, matching how it renders.
export function isFrame(node: MindNode): boolean { return isFrameLayout(node.layoutType) && !node.collapsed; }
// Does this node live inside a frame (any frame ancestor)? Such nodes are positioned in the
// frame's coordinate space, so they must track the frame even while HIDDEN — else a collapsed
// frame moved by its own parent's layout leaves its (hidden, free) children behind, and they
// reappear misplaced on expand. Uses layoutType (not isFrame) so a COLLAPSED frame still counts.
function insideFrame(node: MindNode): boolean {
  for (let p = node.parent ? state.nodes.get(node.parent) : null; p; p = p.parent ? state.nodes.get(p.parent) : null)
    if (isFrameLayout(p.layoutType)) return true;
  return false;
}
// The nearest ANCESTOR frame actually hosting `node` right now — walking PAST non-frame ancestors
// (a grandchild inherits its parent's host), so it's the frame whose content wrapper `node`'s
// element lives inside, DOM-wise (main.ts frameContentEl/place). Unlike insideFrame this only
// counts EXPANDED frames (isFrame, not isFrameLayout), matching what actually renders a wrapper —
// a collapsed frame has no box/wrapper, so it can't host anything. Shared with edges.ts so an edge
// between two cards inside the same frame clips to it too, not just the cards themselves.
export function hostFrame(node: MindNode): MindNode | null {
  for (let p = node.parent ? state.nodes.get(node.parent) : null; p; p = p.parent ? state.nodes.get(p.parent) : null)
    if (isFrame(p)) return p;
  return null;
}
// How many ancestors `node` has (0 for a root). Used to pick the INNERMOST of several nested,
// overlapping frames — shared by drag.ts's pointerdown retarget (innermostFrameAt) and its
// pointer-hover hit-test (updateDropTarget), which both need "deepest wins" among frame hits.
export function ancestorDepth(node: MindNode): number {
  let d = 0;
  for (let p = node.parent ? state.nodes.get(node.parent) : null; p; p = p.parent ? state.nodes.get(p.parent) : null) d++;
  return d;
}
// A frame's INTERIOR rect (absolute world coords, inside its border) — the single source of truth
// for "where does this frame's content go". Shared by main.ts's frameContentEl (the real DOM
// containment wrapper) and edges.ts's frameClipDefs (the SVG clip-path for edges/backgrounds,
// which can't be DOM-reparented into that wrapper) so the two containment mechanisms stay
// pixel-identical by construction instead of by two hand-synced copies of the same arithmetic.
export function frameInterior(f: MindNode): { x: number; y: number; w: number; h: number } {
  return {
    x: f.x + FRAME_BORDER, y: f.y + FRAME_BORDER,
    w: Math.max(0, nodeW(f) - FRAME_BORDER * 2), h: Math.max(0, nodeH(f) - FRAME_BORDER * 2),
  };
}
// Is `child`'s centre inside `frame`'s OUTER box? The single source of truth for "a frame child is
// still in its frame" — the trigger drag.ts uses in BOTH the rip PREVIEW (updateRip) and the detach
// COMMIT (dragPointerUp), so a child ripping out previews the detach exactly where it commits. Uses
// the full box (not frameInterior's inset) deliberately: a card counts as inside until its centre
// clears the frame edge.
export function centreInFrame(child: MindNode, frame: MindNode): boolean {
  const cx = child.x + NODE_W/2, cy = child.y + nodeH(child)/2;
  return cx >= frame.x && cx <= frame.x + nodeW(frame)
      && cy >= frame.y && cy <= frame.y + nodeH(frame);
}
function shiftSubtree(node: MindNode, dx: number, dy: number): void {
  // Saved positions are integers; layout targets are floats. Ignore sub-pixel nudges so a
  // re-opened, already-laid-out map settles to zero movement (no spurious rewrites, no drift).
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  for (const id of subtreeIds(node.id)){
    const n = state.nodes.get(id); if (!n) continue;
    // Skip hidden nodes (a collapsed branch is re-laid on expand) — EXCEPT frame-contained ones,
    // which are free and must keep tracking their frame even while folded.
    if (isHidden(n) && !insideFrame(n)) continue;
    n.x += dx; n.y += dy; n.dirtyLayout = true;
  }
}
// A node's EFFECTIVE layout TYPE. `none` (the default) inherits its parent's effective type,
// walking up until an explicit free/line/fan is found; a root with no explicit layout resolves
// to free (children stay where dragged).
export function effectiveLayout(node: MindNode): { type: string } {
  let n: MindNode | null | undefined = node, guard = 0;
  while (n && guard++ < 4096){
    const t = n.layoutType || 'none';
    if (t !== 'none') return { type: t };
    n = n.parent ? state.nodes.get(n.parent) : null;
  }
  return { type: 'free' };   // unset root → free
}
// How a FRAME arranges its children (flow-h/flow-v), or null when the node isn't an (expanded) frame
// with a flow arrangement. A flow frame auto-positions its children into a wrapping row/column; a
// free frame leaves them where placed. Shared by layout, drag, and the side-bucket drag previews
// (which flow frames opt out of, ordering by 2D position rather than a single side axis).
export function frameFlow(node: MindNode): 'flow-h' | 'flow-v' | null {
  if (!isFrame(node)) return null;
  return node.layoutType === 'frame-h' ? 'flow-h' : node.layoutType === 'frame-v' ? 'flow-v' : null;
}
// Whether a node's effective layout actively MANAGES its children's positions — line/fan (side-based)
// or a flow frame (box-flow) — vs free/free-frame, where children stay where dragged. The single
// spelling of "is this a managed governor?" shared by layout, drop-landing sim, and order reseeding.
export function isManagedLayout(node: MindNode): boolean {
  const t = effectiveLayout(node).type;
  return t === 'line' || t === 'fan' || !!frameFlow(node);
}
// Which of the parent's 4 sides a child sits on, computed FRESH from its current position —
// dominant axis of the offset between the two centers, SCALED by the parent's own aspect ratio
// (a card is wide and short) rather than compared as raw pixels: a `fan` spreads same-side
// siblings wide across the cross axis, so a couple of siblings alone would put more raw pixels
// between a "down" child and its parent horizontally than vertically, misreading it as
// "left"/"right" purely from being laid out. Scaling each axis by the parent's own width/height
// first (comparing fractions of the parent's own size, not absolute px) gives a lot more
// headroom before a wide fan spuriously flips side. Used to BACKFILL `child.side` when it's
// unset (see sideOf) and to refresh it after a plain reposition with no explicit drop target.
export function deriveSide(parent: MindNode, child: MindNode): LayoutSide {
  const dx = (child.x + NODE_W/2) - (parent.x + NODE_W/2);
  const dy = (child.y + nodeH(child)/2) - (parent.y + nodeH(parent)/2);
  const h = nodeH(parent) || 1;
  return Math.abs(dx) / NODE_W >= Math.abs(dy) / h ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'down' : 'up');
}
// A child's side, from the STORED field — backfilling (and caching) it via deriveSide the
// first time it's asked for a child that doesn't have one yet (a legacy note with no mm_side,
// or a freshly created child). Once set, a plain relayout never changes it — only an explicit
// drop (or a reposition with no drop target — see drag.ts) does. Shared by layout grouping/
// ordering and edge-exit-border selection (edges.ts).
export function sideOf(parent: MindNode, child: MindNode): LayoutSide {
  return child.side ?? (child.side = deriveSide(parent, child));
}
const SIDE_RANK: Record<LayoutSide, number> = { right: 0, down: 1, left: 2, up: 3 };
// Sibling order: group by each child's own derived side, then by the coordinate that side's
// layout treats as "along" (fan → cross axis, line → the growth axis). Ties break by filename
// so the seeded order is deterministic across reloads (folder iteration order is not stable).
// Whether ordering along `side` under this layout reads the X coordinate (else Y): a fan orders
// along the CROSS axis of the side, a line along the growth axis. Shared by the position sort
// below and the live reorder-anchor computation (reorderTarget).
// Exported: the outline view packs reordered siblings along this same axis (features/outline.ts).
export function orderAxisIsX(node: MindNode, side: LayoutSide): boolean {
  const horiz = side === 'left' || side === 'right';
  return effectiveLayout(node).type === 'fan' ? !horiz : horiz;
}
function kidsByPosition(node: MindNode, kids: MindNode[]): string[] {
  const tie = (n: MindNode) => n.file || n.title || n.id;
  const cmpTie = (a: MindNode, b: MindNode) => (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0);
  // Box midpoint, falling back to the card's own centre when the subtree is fully hidden
  // (its governor is collapsed → empty box) so order still seeds deterministically.
  const midXY = (k: MindNode): { x: number; y: number } => {
    const b = subtreeBox(k);
    return Number.isFinite(b.x0)
      ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }
      : { x: k.x + NODE_W / 2, y: k.y + nodeH(k) / 2 };
  };
  // FLOW frame: order by reading order along the flow axis. Read the subtree box's TOP-LEFT — NOT
  // its midpoint — because that's exactly what the flow layout aligns to a row/column line, so all
  // items in a row (flow-h) share the same box-top even when one has a tall subtree (a midpoint
  // would band that item into a later row and sort it to the end, losing its saved order on reload).
  // Cluster into bands by GAP (not exact equality): sort by the cross axis, then start a new band
  // whenever the jump from the previous item exceeds FLOW_BAND_TOL. Already flow-placed siblings
  // share an EXACT top per row, so this clusters them correctly too — but tolerant clustering is
  // what makes a FIRST-time conversion (a free frame's hand-placed cards, never pixel-aligned)
  // group into sensible rows/columns instead of every card landing in its own singleton band.
  const flow = frameFlow(node);
  if (flow) {
    const tl = (k: MindNode): { x: number; y: number } => {
      const b = subtreeBox(k);
      return Number.isFinite(b.x0) ? { x: b.x0, y: b.y0 } : { x: k.x, y: k.y };
    };
    const cross = (k: MindNode) => flow === 'flow-h' ? tl(k).y : tl(k).x;
    const along = (k: MindNode) => flow === 'flow-h' ? tl(k).x : tl(k).y;
    const byCross = kids.slice().sort((a, b) => cross(a) - cross(b) || cmpTie(a, b));
    let band = 0;
    const banded = byCross.map((k, i) => {
      if (i > 0 && cross(k) - cross(byCross[i - 1]) > FLOW_BAND_TOL) band++;
      return { k, band };
    });
    return banded
      .sort((a, b) => (a.band - b.band) || (along(a.k) - along(b.k)) || cmpTie(a.k, b.k))
      .map(x => x.k.id);
  }
  // Sort by the SUBTREE box's midpoint, not the card's own corner — a sibling with a big
  // subtree visually occupies its whole box, so that's the order the user perceives. Grouped by
  // each child's stored side, then by the coordinate that side's layout treats as "along".
  const coord = (k: MindNode): number => {
    const useX = orderAxisIsX(node, sideOf(node, k));
    const m = midXY(k);
    return useX ? m.x : m.y;
  };
  return kids.slice()
    .sort((a,b) => (SIDE_RANK[sideOf(node,a)] - SIDE_RANK[sideOf(node,b)]) || (coord(a)-coord(b)) || cmpTie(a, b))
    .map(k => k.id);
}
// A parent's child order is STORED (in memory) and only changes when a child is directly
// dragged — never on an incidental relayout. So moving a parent, editing text, or collapsing
// never reshuffles children; order is seeded from saved positions the first time it's needed.
// Exported: the outline view renders siblings in exactly this order (features/outline.ts).
export function orderedKids(node: MindNode, kids: MindNode[]): MindNode[] {
  const have = new Set(kids.map(k => k.id));
  let order = (node.kidOrder || []).filter(id => have.has(id));   // drop removed children
  const known = new Set(order);
  const fresh = kids.filter(k => !known.has(k.id));                // new children → append by position
  if (fresh.length) order = order.concat(kidsByPosition(node, fresh));
  node.kidOrder = order;
  const rank = new Map(order.map((id,i)=>[id,i]));
  return kids.slice().sort((a,b)=>rank.get(a.id)! - rank.get(b.id)!);
}
// Turn a live drag position into an insertion anchor among `parent`'s children: which side the
// dragged card is on right now (or `forcedSide`, e.g. the hovered sibling's stored side for a
// centre-zone drop) and which same-side sibling it should slot in AFTER (`null` = before them
// all). Compares the dragged CARD's midpoint against each sibling's SUBTREE-box midpoint along
// the side's ordering axis, so "between two siblings" means between their visible boxes — the
// order the user perceives — not between the cards' top-left corners. Stored bucket order equals
// visual order along the increasing coordinate on all four sides for both fan and line (lineSide
// reverses left/up iteration precisely to guarantee that), so no mapping is needed. The single
// source of the anchor for both the insertion-line preview and the drop commit.
//
// `line` is the world-space segment for the insertion indicator: it sits in the CURRENT gap
// between the two adjacent siblings' subtree boxes (perpendicular to the ordering axis, spanning
// the neighbours' cards) — i.e. relative to where the siblings are NOW, not where the post-drop
// layout would put things. `null` when there's no same-side sibling to slot against.
//
// `near` is the engage gate: whether the dragged card is close enough to the sibling band that a
// release should mean "re-slot" rather than rip/free-move. Between two neighbours the along-axis
// position is correct by construction (that's how afterId was picked), so only the CROSS-axis
// distance to the gap matters; past the first/last sibling the along-axis distance is bounded
// too, so pulling away off the end of the row/column still rips as before.
export function reorderTarget(parent: MindNode, dragged: MindNode, forcedSide?: LayoutSide): { side: LayoutSide; afterId: string | null; line: Seg | null; near: boolean } {
  const side = forcedSide ?? deriveSide(parent, dragged);
  const kids = childrenOf(parent.id).filter(k => !isHidden(k) && k.id !== dragged.id);
  const sibs = orderedKids(parent, kids).filter(k => sideOf(parent, k) === side);
  const useX = orderAxisIsX(parent, side);
  const mid = useX ? dragged.x + NODE_W / 2 : dragged.y + nodeH(dragged) / 2;
  let afterId: string | null = null;
  let idx = -1;   // index of the `afterId` sibling in sibs
  for (const s of sibs) {
    const b = subtreeBox(s);
    if ((useX ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2) <= mid) { afterId = s.id; idx++; }
    else break;
  }
  // The gap the card would slot into: between `prev` (the afterId sibling) and `next` — either
  // may be missing at the ends of the row/column, where the line sits just beyond the last box.
  const prev = idx >= 0 ? sibs[idx] : null, next = sibs[idx + 1] ?? null;
  let line: Seg | null = null;
  let near = false;
  if (prev || next) {
    const pb = prev ? subtreeBox(prev) : null, nb = next ? subtreeBox(next) : null;
    const END = LAYOUT_CHAIN;   // half-gap-ish offset past the first/last sibling's box
    if (useX) {
      const x = pb && nb ? (pb.x1 + nb.x0) / 2 : pb ? pb.x1 + END : nb!.x0 - END;
      const y0 = Math.min(prev?.y ?? Infinity, next?.y ?? Infinity);
      const y1 = Math.max(prev ? prev.y + nodeH(prev) : -Infinity, next ? next.y + nodeH(next) : -Infinity);
      line = { x0: x, y0, x1: x, y1 };
      const crossMid = dragged.y + nodeH(dragged) / 2;
      near = crossMid > y0 - (nodeH(dragged) + LANDING_GAP) && crossMid < y1 + (nodeH(dragged) + LANDING_GAP)
          && (!!(prev && next) || Math.abs(mid - x) < NODE_W);
    } else {
      const y = pb && nb ? (pb.y1 + nb.y0) / 2 : pb ? pb.y1 + END : nb!.y0 - END;
      const x0 = Math.min(prev?.x ?? Infinity, next?.x ?? Infinity);
      const x1 = Math.max(prev ? prev.x + NODE_W : -Infinity, next ? next.x + NODE_W : -Infinity);
      line = { x0, y0: y, x1, y1: y };
      const crossMid = dragged.x + NODE_W / 2;
      near = crossMid > x0 - NODE_W && crossMid < x1 + NODE_W
          && (!!(prev && next) || Math.abs(mid - y) < nodeH(dragged) + LANDING_GAP);
    }
  }
  return { side, afterId, line, near };
}
// Where a card dragged inside a FLOW frame would be inserted: the sibling it lands AFTER in the flow
// reading order (`null` = front), plus the insertion bar to draw. flow-h reads row-major and draws a
// VERTICAL bar in the gap; flow-v reads column-major and draws a HORIZONTAL bar. The 2D analogue of
// reorderTarget — used for both the live preview and the drop commit so they agree.
//
// Two-step, like reading a grid: (1) which BAND (row for flow-h, column for flow-v) is the dragged
// card in — resolved by NEAREST band centre on the cross axis, not exact position matching, since
// the dragged card's live position rarely lands exactly on a row/column line (drag offset, no snap
// mid-drag); (2) where within that band, by comparing along-axis midpoints — same technique as
// reorderTarget. Bands are grouped from already-placed siblings, whose box-tops are EXACT per row
// (that's what the flow layout assigns), so grouping consecutive same-top siblings is reliable.
export function flowReorderTarget(frame: MindNode, dragged: MindNode): { afterId: string | null; line: Seg } {
  const flow = frameFlow(frame)!;                                   // caller ensures a flow frame
  const kids = childrenOf(frame.id).filter(k => !isHidden(k) && k.id !== dragged.id);
  const sibs = orderedKids(frame, kids);                            // flow reading order
  if (!sibs.length) return { afterId: null, line: flowLine(frame, null, null, flow) };

  type Band = { key: number; size: number; items: MindNode[] };
  const bands: Band[] = [];
  for (const s of sibs) {
    const b = subtreeBox(s);
    const key = Math.round(flow === 'flow-h' ? b.y0 : b.x0);
    const size = flow === 'flow-h' ? (b.y1 - b.y0) : (b.x1 - b.x0);
    const last = bands[bands.length - 1];
    if (last && last.key === key) { last.items.push(s); last.size = Math.max(last.size, size); }
    else bands.push({ key, size, items: [s] });
  }

  const dCross = flow === 'flow-h' ? dragged.y + nodeH(dragged) / 2 : dragged.x + nodeW(dragged) / 2;
  let bandIdx = 0, bestDist = Infinity;
  bands.forEach((b, i) => {
    const d = Math.abs(dCross - (b.key + b.size / 2));
    if (d < bestDist) { bestDist = d; bandIdx = i; }
  });
  const band = bands[bandIdx];

  const dAlong = flow === 'flow-h' ? dragged.x + nodeW(dragged) / 2 : dragged.y + nodeH(dragged) / 2;
  let afterInBand: MindNode | null = null;
  for (const s of band.items) {
    const b = subtreeBox(s);
    const mid = flow === 'flow-h' ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2;
    if (mid <= dAlong) afterInBand = s; else break;
  }
  const afterId = afterInBand ? afterInBand.id
    : bandIdx > 0 ? bands[bandIdx - 1].items[bands[bandIdx - 1].items.length - 1].id
    : null;

  const idxInSibs = afterId ? sibs.findIndex(s => s.id === afterId) : -1;
  const prev = idxInSibs >= 0 ? sibs[idxInSibs] : null;
  const next = sibs[idxInSibs + 1] ?? null;
  return { afterId, line: flowLine(frame, prev, next, flow) };
}
// The insertion bar between `prev` and `next` (either may be null at the ends) for a flow frame.
// flow-h draws a VERTICAL bar (positioned along x, spanning a y range); flow-v draws a HORIZONTAL
// bar (positioned along y, spanning an x range) — same along/cross-axis split as flowReorderTarget,
// so the two branches below differ only in which axis is "along" vs "cross", not in the logic.
function flowLine(frame: MindNode, prev: MindNode | null, next: MindNode | null, flow: 'flow-h' | 'flow-v'): Seg {
  const G = 6;
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const pb = prev ? subtreeBox(prev) : null, nb = next ? subtreeBox(next) : null;
  const alongLo = (b: Box) => flow === 'flow-h' ? b.x0 : b.y0, alongHi = (b: Box) => flow === 'flow-h' ? b.x1 : b.y1;
  const crossLo = (b: Box) => flow === 'flow-h' ? b.y0 : b.x0, crossHi = (b: Box) => flow === 'flow-h' ? b.y1 : b.x1;
  // same row (flow-h) / column (flow-v): the flow layout gives row-mates an identical box top.
  const sameBand = !!pb && !!nb && Math.round(crossLo(pb)) === Math.round(crossLo(nb));
  let pos: number, spanLo: number, spanHi: number;
  if (pb && nb && sameBand) { pos = (alongHi(pb) + alongLo(nb)) / 2; spanLo = Math.min(crossLo(pb), crossLo(nb)); spanHi = Math.max(crossHi(pb), crossHi(nb)); }
  else if (nb) { pos = alongLo(nb) - G; spanLo = crossLo(nb); spanHi = crossHi(nb); }
  else if (pb) { pos = alongHi(pb) + G; spanLo = crossLo(pb); spanHi = crossHi(pb); }
  else if (flow === 'flow-h') { pos = frame.x + FRAME_PAD; spanLo = frame.y + FRAME_TITLE_H; spanHi = spanLo + 40; }
  else { pos = frame.y + FRAME_TITLE_H; spanLo = frame.x + FRAME_PAD; spanHi = spanLo + NODE_W; }
  return flow === 'flow-h' ? { x0: pos, y0: spanLo, x1: pos, y1: spanHi } : { x0: spanLo, y0: pos, x1: spanHi, y1: pos };
}
// After a drag the dropped positions are authoritative (heights didn't change), so refresh the
// sibling order of every parent that had a child moved — this is the ONLY place order changes.
export function reorderDraggedParents(movedIds: Iterable<string>): void {
  const parents = new Set<string>();
  for (const id of movedIds){ const n = state.nodes.get(id); if (n && n.parent) parents.add(n.parent); }
  for (const pid of parents){
    const p = state.nodes.get(pid); if (!p) continue;
    if (isManagedLayout(p))
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

  const type = effectiveLayout(node).type;            // `none` inherits the parent's layout
  const flow = frameFlow(node);                       // flow-h / flow-v for a flow frame, else null
  if (type !== 'line' && type !== 'fan' && !flow) return;  // free / free-frame / unset: manual

  const boxOf = new Map(kids.map(k => [k.id, subtreeBox(k)]));
  const ax = node.x, ay = node.y;

  const sorted = orderedKids(node, kids);   // stored order — only a direct child-drag changes it

  // FLOW frame: fill the content area along the primary axis, wrapping to the next row/column when
  // the next child won't fit. flow-h fills rows left→right (wrap down); flow-v fills columns
  // top→bottom (wrap right). Reflows as the frame is resized (content width/height changes).
  if (flow) {
    const gap = FRAME_FLOW_GAP;
    const left = ax + FRAME_PAD, top = ay + FRAME_TITLE_H;
    const right = ax + nodeW(node) - FRAME_PAD, bottom = ay + nodeH(node) - FRAME_PAD;
    let cx = left, cy = top, band = 0;   // band = tallest row (flow-h) / widest column (flow-v) so far
    for (const k of sorted) {
      const b = boxOf.get(k.id)!, w = b.x1 - b.x0, h = b.y1 - b.y0;
      if (flow === 'flow-h') {
        if (cx > left && cx + w > right) { cx = left; cy += band + gap; band = 0; }   // wrap to next row
        shiftSubtree(k, cx - b.x0, cy - b.y0);
        cx += w + gap; band = Math.max(band, h);
      } else {
        if (cy > top && cy + h > bottom) { cy = top; cx += band + gap; band = 0; }    // wrap to next column
        shiftSubtree(k, cx - b.x0, cy - b.y0);
        cy += h + gap; band = Math.max(band, w);
      }
    }
    return;
  }

  // FAN a set of children to ONE side: every child the same distance out, spread along the
  // cross axis and centred on the parent. Called once per occupied side (up to 4).
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
  // LINE a set of children to ONE side: chained one after another ALONG the side, centred on
  // the cross axis. Called once per occupied side (up to 4). The chain grows in the side's
  // sign, so for left/up we walk the order in REVERSE — that way the first child in stored
  // order ends up at the visual top/left, not nearest the parent. (Otherwise dragging a child
  // to the top snaps it to the bottom.)
  const lineSide = (ids: MindNode[], sd: string) => {
    const hz = sd === 'left' || sd === 'right';
    let cur = hz ? (sd==='right' ? ax+NODE_W+LAYOUT_MAIN : ax-LAYOUT_MAIN)
                 : (sd==='down'  ? ay+layoutH(node)+LAYOUT_MAIN : ay-LAYOUT_MAIN);
    const seq = (sd==='left' || sd==='up') ? ids.slice().reverse() : ids;
    seq.forEach((k)=>{
      const b = boxOf.get(k.id)!; let dx=0, dy=0;
      if (hz){
        const w = b.x1 - b.x0;
        dx = sd==='right' ? (cur - b.x0) : (cur - b.x1);
        dy = (ay + layoutH(node)/2) - (k.y + layoutH(k)/2);   // centre child on the parent's y
        cur += sd==='right' ? (w+LAYOUT_CHAIN) : -(w+LAYOUT_CHAIN);
      } else {
        const h = b.y1 - b.y0;
        dy = sd==='down' ? (cur - b.y0) : (cur - b.y1);
        dx = (ax + NODE_W/2) - (k.x + NODE_W/2);          // centre child on the parent's x
        cur += sd==='down' ? (h+LAYOUT_CHAIN) : -(h+LAYOUT_CHAIN);
      }
      shiftSubtree(k, dx, dy);
    });
  };
  // Each child sits on whichever of the parent's 4 sides is STORED on it (see sideOf). Group
  // the stored order into up to 4 side-buckets, then lay out each occupied bucket independently
  // (generalizes the old two-sided balance to up to 4 sides).
  const buckets: Record<LayoutSide, MindNode[]> = { right: [], left: [], down: [], up: [] };
  for (const k of sorted) buckets[sideOf(node, k)].push(k);
  const place = type === 'fan' ? fanSide : lineSide;
  for (const side of ['right', 'left', 'down', 'up'] as const) {
    if (buckets[side].length) place(buckets[side], side);
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
