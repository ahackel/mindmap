// ---------- node lifecycle: create / duplicate / delete / extract ----------
// Every node is one .md file; ids are ephemeral (minted in mkNode). All create/duplicate paths go
// through mkNode so the node schema stays in one place. Each mutation schedules a save. Re-parenting
// by drag lives in features/drag.ts; this is the keyboard/toolbar-driven lifecycle.
import { state, setStatus, type MindNode, type LayoutType } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { childrenOf, takenTitles } from '../utils/model.js';
import { applyLayouts } from '../view/layout.js';
import { screenToWorld } from '../view/camera.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, selectNode, setSelectionSet, applySelection, selectedIds, nodeH, subtreeIds } from '../main.js';
import { startInlineEdit } from './inline-edit.js';
import { touch, commitStep, record } from './history.js';

// Mint a fresh node with the standard shape; callers override only the fields they care about.
// Keeps the node schema (and its defaults) in ONE place so every create/duplicate path stays in
// sync — the id is always minted here (ids are ephemeral, see below).
function mkNode(fields: Partial<MindNode> = {}): MindNode {
  const id = 'n' + (state.idSeq++);
  touch(id);   // not in state.nodes yet → before-image is null (undo of a create = remove it)
  return {
    id, file:null,
    x:0, y:0, parent:null, collapsed:false, done:false, checklist:false, bg:false,
    title:'', color:'', keepStatus:'', tags:[], body:'',
    layoutType:'none',
    dirty:true, dirtyLayout:true,
    ...fields,
  };
}
// Make a new UNCONNECTED node (parent:null) at the viewport centre (or a given spot).
interface CreateOpts {
  x?: number; y?: number; parent?: string | null; title?: string; color?: string;
  tags?: string[]; body?: string; layoutType?: LayoutType; isNew?: boolean;
}
export function createNode(opts: CreateOpts = {}): MindNode | undefined {
  if (state.readOnly) return;
  const c = screenToWorld(window.innerWidth/2, window.innerHeight/2);
  const n = mkNode({
    x: opts.x ?? (c.x - 100), y: opts.y ?? (c.y - 40),
    parent: opts.parent ?? null,
    title: opts.title ?? uniqueTitle('New Node'),  // avoid colliding with an existing "New Node"
    color: opts.color ?? '',
    tags: opts.tags ? [...opts.tags] : [], body: opts.body ?? '',
    layoutType: opts.layoutType ?? 'none',
  });
  const id = n.id;
  state.nodes.set(id, n);
  applyLayouts(); paintAll(); selectNode(id); startInlineEdit(n, { isNew: opts.isNew ?? true });
  scheduleSave();
  return n;
}
// Make a new unconnected node at (x,y) and render it, but DON'T select / rename / save yet — the
// caller drives it (e.g. the ghost-card drag rides it under the cursor, then renames on drop or
// deletes it on cancel). Kept save-free so an abandoned drag never writes a file.
export function createDetachedNode(x: number, y: number): MindNode | undefined {
  if (state.readOnly) return;
  const n = mkNode({ x, y, parent:null, title: uniqueTitle('New Node') });
  state.nodes.set(n.id, n);
  paintAll();   // give the card a DOM element so it can be dragged
  return n;
}
// Pick a title not already in use. "Tether Gun" -> "Tether Gun copy" -> "Tether Gun copy 2"…
// For brand-new nodes, "New Node" -> "New Node 2" -> "New Node 3"…
function uniqueTitle(base: string, { copy = false }: { copy?: boolean } = {}): string {
  const taken = takenTitles();
  let cand = copy ? `${base} copy` : base;
  if (!taken.has(cand.toLowerCase())) return cand;
  let i = 2;
  while (taken.has((copy ? `${base} copy ${i}` : `${base} ${i}`).toLowerCase())) i++;
  return copy ? `${base} copy ${i}` : `${base} ${i}`;
}
// Clone one card (not its subtree) at (x,y): same content/colour, keeping its parent so the copy
// stays attached as a sibling. Gets a unique "… copy" title so its file is valid. Shared by the
// duplicate (sidebar/keyboard) and Shift-drag clone paths; doesn't touch selection/layout.
function cloneNodeAt(s: MindNode, x: number, y: number): MindNode {
  const copy = mkNode({
    x, y,
    parent: s.parent,
    title: uniqueTitle(s.title, { copy: true }),
    color: s.color,
    tags: [...s.tags], body: s.body, done: s.done, checklist: s.checklist, bg: s.bg,
    layoutType: s.layoutType || 'none', side: s.side,
  });
  state.nodes.set(copy.id, copy);
  return copy;
}
// A duplicate sits directly below the original, clear of it.
function copyNode(s: MindNode): MindNode { return cloneNodeAt(s, s.x, s.y + nodeH(s) + 24); }
// Duplicate every selected card (or just the one). Each copy keeps its source's parent, so it
// stays connected. One card → open its rename like a fresh node; many → select the new copies.
export function duplicateSelection(): MindNode[] | undefined {
  if (state.readOnly) return;
  const ids = selectedIds();
  const srcs = ids.map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n);
  if (!srcs.length) return;
  const copies = srcs.map(copyNode);
  // paint first so the new cards get real DOM heights — applyLayouts measures offsetHeight,
  // and a chain/fan of fresh copies would otherwise stack on the 64px fallback (only the first
  // lands right). Then lay out with correct heights and commit.
  paintAll(); applyLayouts(); paintAll();
  if (copies.length === 1){
    selectNode(copies[0].id);
    startInlineEdit(copies[0], { isNew: false });
    setStatus(`Duplicated → “${copies[0].title}”`);
  } else {
    setSelectionSet(copies.map(c => c.id));
    setStatus(`Duplicated ${copies.length} cards`);
    commitStep();   // multi-copy: no rename opens, so the step ends here
  }
  scheduleSave();
  return copies;
}
// Shift+drag clone: drop a copy at `pos` that keeps the source's parent (a sibling),
// while the original is the node being dragged away. Doesn't steal selection/focus.
export function leaveClone(s: MindNode, pos: Pt): MindNode {
  const copy = cloneNodeAt(s, pos.x, pos.y);
  setStatus(`Cloned → “${copy.title}”`);
  return copy;
}

// ---------- add child / sibling ----------
export function addChild(parentId: string): void {
  if (state.readOnly) return;
  const parent = state.nodes.get(parentId); if (!parent) return;
  touch(parentId);   // the reveal below (and a line/fan kidOrder change) belong to the create step
  if (parent.collapsed){ parent.collapsed = false; } // reveal so the new child is visible
  const sibs = childrenOf(parentId);
  const n = mkNode({
    x: parent.x + 40 + sibs.length * 30,
    y: parent.y + 150 + sibs.length * 10,
    parent: parentId,
    title: uniqueTitle('New Node'),
  });
  const id = n.id;
  state.nodes.set(id, n);
  applyLayouts();        // a line/fan parent immediately slots the new child into place
  paintAll();
  selectNode(id);
  startInlineEdit(n, { isNew: true });   // drop straight into renaming the fresh card; Esc cancels creation
  scheduleSave();
}
// Add a SIBLING of `refId` — a new node sharing its parent. For a parented node we delegate
// to addChild so the parent's order/layout handling stays in one place; a root-level node has
// no parent, so its "sibling" is a fresh unconnected node placed just below it.
export function createSibling(refId: string){
  if (state.readOnly) return;
  const ref = state.nodes.get(refId); if (!ref) return;
  if (ref.parent != null) return addChild(ref.parent);
  return createNode({ x: ref.x, y: ref.y + nodeH(ref) + 40 });
}

// ---------- extract selected body text into a new child card ----------
// Triggered with ⌘⇧E while editing a card's body in place: cut the selected text out of the
// note and drop it into a fresh child card.
export function extractToChild(): void {
  if (state.readOnly || !ui.bodyEdit) return;
  const n = state.nodes.get(ui.bodyEdit.id); if (!n) return;
  const ta = ui.bodyEdit.ta;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e){ setStatus('Select some body text to extract'); return; }
  touch(n.id);   // usually already touched by startBodyEdit — idempotent
  const sel = ta.value.slice(s, e);
  const lines = sel.split('\n');
  let ti = lines.findIndex((l: string) => l.trim()); if (ti < 0) ti = 0;
  const title = uniqueTitle(
    lines[ti].replace(/^\s*(#{1,6}|[-*+]|>|\d+\.)\s*/, '').trim() || 'New Node');
  const childBody = lines.slice(ti+1).join('\n').trim();
  // cut the selection out of the parent (tidy up the blank lines it leaves) and close its editor
  n.body = (ta.value.slice(0, s) + ta.value.slice(e)).replace(/\n{3,}/g, '\n\n').trim();
  n.dirty = true;
  ui.bodyEdit = null;   // commit & drop the in-card editor
  // make the child below the parent and jump to it
  const sibs = childrenOf(n.id);
  if (n.collapsed) n.collapsed = false;
  const child = mkNode({
    x: n.x + 40 + sibs.length*30, y: n.y + 180 + sibs.length*10,
    parent: n.id, title, body: childBody,
  });
  const id = child.id;
  state.nodes.set(id, child);
  applyLayouts(); paintAll(); selectNode(id); scheduleSave();
  commitStep();   // extract bypasses endBodyEdit (ui.bodyEdit nulled above), so close the step here
  setStatus(`Extracted “${title}” as a child`);
}

// ---------- delete ----------
// Forget a set of node ids: drop them from state, remove their DOM cards, and queue
// their files for deletion on the next save. Callers pass the full subtree(s) to remove.
function deleteNodes(ids: Iterable<string>): void {
  touch(...ids);   // single choke point: every removal's before-image lands in the step
  for (const id of ids){
    const n = state.nodes.get(id); if (!n) continue;
    state.nodes.delete(id); n.el?.remove();
    if (n.file) state.toDelete.push(n.file);
  }
}
export function deleteNode(id: string): void {
  if (state.readOnly) return;
  if (!state.nodes.has(id)) return;
  record([], () => {                 // ids are touched inside deleteNodes
    deleteNodes(subtreeIds(id));
    applyLayouts(); selectNode(null); paintAll();
    scheduleSave();
  });
}
// Delete every selected card and their entire subtrees.
export function deleteSelection(): void {
  if (state.readOnly) return;
  const ids = [...state.sel];
  if (!ids.length) return;
  record([], () => {                 // ids are touched inside deleteNodes
    state.sel.clear(); state.selId = null;
    deleteNodes(new Set(ids.flatMap(id => subtreeIds(id))));   // dedup overlapping subtrees
    applyLayouts(); applySelection(); scheduleSave();
  });
  setStatus(`Deleted ${ids.length} card${ids.length===1?'':'s'}`);
}
