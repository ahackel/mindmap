// ---------- node lifecycle: create / duplicate / delete / extract ----------
// Every node is one .md file; ids are ephemeral (minted in mkNode). All create/duplicate paths go
// through mkNode so the node schema stays in one place. Each mutation schedules a save. Re-parenting
// by drag lives in features/drag.ts; this is the keyboard/toolbar-driven lifecycle.
import { state, setStatus, isLeafType, isAnnotation, isImageCard, type MindNode, type NodeType, type NodeLayout } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { childrenOf, takenTitles, isLockedEffective, subtreeHasLocked } from '../utils/model.js';
import { applyLayouts, insertedKidOrder, sideOf } from '../view/layout.js';
import { screenToWorld } from '../view/camera.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, selectNode, setSelectionSet, applySelection, selectedIds, nodeH, subtreeIds } from '../main.js';
import { startInlineEdit } from './inline-edit.js';
import { touch, commitStep, record } from './history.js';

// Mint a fresh node with the standard shape; callers override only the fields they care about.
// Keeps the node schema (and its defaults) in ONE place so every create/duplicate path stays in
// sync — the id is always minted here (ids are ephemeral, see below).
export function mkNode(fields: Partial<MindNode> = {}): MindNode {
  const id = 'n' + (state.idSeq++);
  touch(id);   // not in state.nodes yet → before-image is null (undo of a create = remove it)
  return {
    id, file:null,
    x:0, y:0, rx:0, ry:0, parent:null, collapsed:false, locked:false, done:false, checklist:false, bg:false,
    title:'', color:'', keepStatus:'', tags:[], body:'',
    type:'card', layout:'inherit',
    dirty:true, dirtyLayout:true,
    ...fields,
  };
}
// Make a new UNCONNECTED node (parent:null) at the viewport centre (or a given spot).
interface CreateOpts {
  x?: number; y?: number; parent?: string | null; title?: string; color?: string;
  tags?: string[]; body?: string; type?: NodeType; layout?: NodeLayout; isNew?: boolean;
  w?: number; h?: number;
  edit?: boolean;   // false = don't open the inline rename (e.g. paste — the content is final)
}
export function createNode(opts: CreateOpts = {}): MindNode | undefined {
  if (state.readOnly) return;
  const c = screenToWorld(window.innerWidth/2, window.innerHeight/2);
  const n = mkNode({
    x: opts.x ?? (c.x - 100), y: opts.y ?? (c.y - 40),
    parent: opts.parent ?? null,
    title: opts.title ?? (opts.type === 'annotation' ? uniqueTitle('Annotation') : newCardTitle()),
    color: opts.color ?? '',
    tags: opts.tags ? [...opts.tags] : [], body: opts.body ?? '',
    type: opts.type ?? 'card', layout: opts.layout ?? 'inherit',
    w: opts.w, h: opts.h,
  });
  const id = n.id;
  state.nodes.set(id, n);
  applyLayouts(); paintAll(); selectNode(id);
  if (opts.edit !== false) startInlineEdit(n, { isNew: opts.isNew ?? true });
  else commitStep();   // no rename session follows, so the create step ends here
  scheduleSave();
  return n;
}
// Create an annotation at (x,y). If a card is selected it becomes that card's child (the primary
// selection anchor — as long as it can hold children); otherwise it's a root. Shared by the 'A'
// shortcut and the "Create annotation here" context-menu entry.
export function createAnnotationHere(x: number, y: number): MindNode | undefined {
  const sel = state.selId ? state.nodes.get(state.selId) : null;
  // an annotation can pin to anything EXCEPT another annotation (images included — you can annotate them)
  const parent = sel && !isAnnotation(sel) ? sel.id : null;
  return createNode({ x, y, type:'annotation', parent });
}
// Make a new unconnected node at (x,y) and render it, but DON'T select / rename / save yet — the
// caller drives it (e.g. the ghost-card drag rides it under the cursor, then renames on drop or
// deletes it on cancel). Kept save-free so an abandoned drag never writes a file.
export function createDetachedNode(x: number, y: number): MindNode | undefined {
  if (state.readOnly) return;
  const n = mkNode({ x, y, parent:null, title: newCardTitle() });
  state.nodes.set(n.id, n);
  paintAll();   // give the card a DOM element so it can be dragged
  return n;
}
// Pick a title not already in use: "Some heading" -> "Some heading 2" -> "Some heading 3"…
export function uniqueTitle(base: string): string {
  const taken = takenTitles();
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}
// Titles are numbered: fresh cards are "New Card 1", "New Card 2", …; a copy of "Idea 3" tries
// "Idea 4" next (or the first free number after it), and a copy of an unnumbered "Idea" starts
// a new suffix at "Idea 2".
function splitNumbered(title: string): { base: string; num: number | null } {
  const m = title.match(/^(.*\S) (\d+)$/);
  return m ? { base: m[1], num: parseInt(m[2], 10) } : { base: title, num: null };
}
function nextNumberedTitle(base: string, from = 1): string {
  const taken = takenTitles();
  let i = from;
  while (taken.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}
export const newCardTitle = (): string => nextNumberedTitle('New Card');
const copyTitle = (title: string): string => {
  const { base, num } = splitNumbered(title);
  return nextNumberedTitle(base, (num ?? 1) + 1);   // numbered → next free number; plain → "… 2"
};
// Clone one card (not its subtree) at (x,y): same content/colour, keeping its parent so the copy
// stays attached as a sibling. Gets the next free numbered title (copyTitle) so its file is valid.
// Shared by the duplicate (sidebar/keyboard) and Shift-drag clone paths; doesn't touch selection/layout.
function cloneNodeAt(s: MindNode, x: number, y: number): MindNode {
  const copy = mkNode({
    x, y,
    parent: s.parent,
    title: copyTitle(s.title),
    color: s.color,
    tags: [...s.tags], body: s.body, done: s.done, checklist: s.checklist, bg: s.bg,
    type: s.type, layout: s.layout, side: s.side,
    w: s.w, h: s.h,   // a frame/image card's own box size
  });
  state.nodes.set(copy.id, copy);
  return copy;
}
// A duplicate sits directly below the original, clear of it.
function copyNode(s: MindNode): MindNode { return cloneNodeAt(s, s.x, s.y + nodeH(s) + 24); }
// Duplicate every selected card (or just the one). Each copy keeps its source's parent, so it
// stays connected. One card → open its rename like a fresh node; many → select the new copies.
// `edit:false` skips the rename (outline duplicate just drops the copy into the list, selected —
// see features/outline.ts) so it doesn't yank the user into an editor.
export function duplicateSelection({ edit = true }: { edit?: boolean } = {}): MindNode[] | undefined {
  if (state.readOnly) return;
  const ids = selectedIds();
  const srcs = ids.map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n);
  if (!srcs.length) return;
  const copies = srcs.map(copyNode);
  // paint first so the new cards get real DOM heights — applyLayouts measures offsetHeight,
  // and a chain/fan of fresh copies would otherwise stack on the 64px fallback (only the first
  // lands right). Then lay out with correct heights and commit.
  paintAll(); applyLayouts(); paintAll();
  const msg = copies.length === 1 ? `Duplicated → “${copies[0].title}”` : `Duplicated ${copies.length} cards`;
  if (copies.length === 1 && edit){
    selectNode(copies[0].id);
    startInlineEdit(copies[0], { isNew: false });
  } else {
    setSelectionSet(copies.map(c => c.id));
    commitStep();   // no rename opens, so the step ends here
  }
  setStatus(msg);
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
  if (isLeafType(parent)) return;   // image/annotation are leaves — they can't have children
  if (isLockedEffective(parent)) { setStatus('Locked — can’t add a child'); return; }
  touch(parentId);   // the reveal below (and a line/fan kidOrder change) belong to the create step
  if (parent.collapsed){ parent.collapsed = false; } // reveal so the new child is visible
  const sibs = childrenOf(parentId);
  const n = mkNode({
    x: parent.x + 40 + sibs.length * 30,
    y: parent.y + 150 + sibs.length * 10,
    parent: parentId,
    title: newCardTitle(),
  });
  const id = n.id;
  state.nodes.set(id, n);
  applyLayouts();        // a line/fan parent immediately slots the new child into place
  paintAll();
  selectNode(id);
  startInlineEdit(n, { isNew: true });   // drop straight into renaming the fresh card; Esc cancels creation
  scheduleSave();
}
// Add a SIBLING of `refId` — a new node sharing its parent, on the SAME side as the reference
// card and slotted into the child order DIRECTLY AFTER it (not appended at the end). A root-level
// node has no parent, so its "sibling" is a fresh unconnected node placed just below it.
export function createSibling(refId: string){
  if (state.readOnly) return;
  const ref = state.nodes.get(refId); if (!ref) return;
  if (ref.parent == null) return createNode({ x: ref.x, y: ref.y + nodeH(ref) + 40 });
  const parent = state.nodes.get(ref.parent); if (!parent) return;
  if (isLockedEffective(parent)) { setStatus('Locked — can’t add a sibling'); return; }
  touch(parent.id);   // the kidOrder change (and a possible reveal) belong to the create step
  if (parent.collapsed) parent.collapsed = false;
  const n = mkNode({
    // seed just below the reference; a managed layout re-places it, a free layout keeps it here
    x: ref.x, y: ref.y + nodeH(ref) + 24,
    parent: ref.parent,
    side: sideOf(parent, ref),                             // same direction as the reference card
    title: newCardTitle(),
  });
  state.nodes.set(n.id, n);
  parent.kidOrder = insertedKidOrder(parent, n.id, ref.id);   // directly after the reference
  applyLayouts(); paintAll();
  selectNode(n.id);
  startInlineEdit(n, { isNew: true });   // drop straight into renaming the fresh card; Esc cancels creation
  scheduleSave();
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
    lines[ti].replace(/^\s*(#{1,6}|[-*+]|>|\d+\.)\s*/, '').trim() || newCardTitle());
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
  if (subtreeHasLocked(id)) { setStatus('Locked — can’t delete'); return; }
  record([], () => {                 // ids are touched inside deleteNodes
    deleteNodes(subtreeIds(id));
    applyLayouts(); selectNode(null); paintAll();
    scheduleSave();
  });
}
// Delete every selected card and their entire subtrees.
export function deleteSelection(): void {
  if (state.readOnly) return;
  const ids = [...state.sel].filter(id => !subtreeHasLocked(id));
  if (!ids.length) { setStatus('Locked — can’t delete'); return; }
  record([], () => {                 // ids are touched inside deleteNodes
    state.sel.clear(); state.selId = null;
    deleteNodes(new Set(ids.flatMap(id => subtreeIds(id))));   // dedup overlapping subtrees
    applyLayouts(); applySelection(); scheduleSave();
  });
  setStatus(`Deleted ${ids.length} card${ids.length===1?'':'s'}`);
}
// Alt-drop an image CARD onto a regular card (features/drag.ts): fold each image card's markdown
// (its `![alt](path)` body) onto the end of the target card's body as an inline image, then delete
// the now-redundant image card(s). The referenced attachment file stays on disk — the target body
// still points at it; only the image card's own .md note is removed. Runs INSIDE the live drag
// undo step: it touches + mutates only, and the caller (dragPointerUp) commits.
export function foldImageCardsIntoBody(targetId: string, imageCardIds: Iterable<string>): number {
  if (state.readOnly) return 0;
  const target = state.nodes.get(targetId); if (!target) return 0;
  const cards = [...imageCardIds]
    .map(id => state.nodes.get(id))
    .filter((n): n is MindNode => !!n && isImageCard(n));
  if (!cards.length) return 0;
  const md = cards.map(c => (c.body || '').trim()).filter(Boolean).join('\n\n');
  touch(targetId);
  if (md){
    target.body = (target.body && target.body.trim()) ? target.body.replace(/\s*$/, '') + '\n\n' + md : md;
    target.dirty = true;
    if (ui.bodyEdit && ui.bodyEdit.id === targetId) ui.bodyEdit.ta.value = target.body;   // sync an open editor
  }
  deleteNodes(cards.map(c => c.id));
  return cards.length;
}
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Alt-drag an image OUT of a card (features/image-extract.ts): strip the `![alt](path)` from the
// source card's body, then either MOVE it into another card's body (`target.toCardId`) or drop it
// as a fresh image-only card at a world position (`target.x/y/w/h`). One undo step — touches +
// mutates and commits it (image extraction is its own gesture, not nested in a live drag).
export function extractImage(sourceId: string, path: string, alt: string,
    target: { toCardId: string } | { x: number; y: number; w: number; h: number }): void {
  if (state.readOnly || !path) return;
  const source = state.nodes.get(sourceId); if (!source) return;
  const re = new RegExp(`[ \\t]*!\\[[^\\]]*\\]\\(\\s*${escRe(path)}\\s*\\)[ \\t]*\\n?`);
  touch(sourceId);
  source.body = source.body.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  source.dirty = true;
  if (ui.bodyEdit && ui.bodyEdit.id === sourceId) ui.bodyEdit.ta.value = source.body;
  const md = `![${alt}](${path})`;
  if ('toCardId' in target){
    const tgt = state.nodes.get(target.toCardId);
    if (tgt){
      touch(tgt.id);
      tgt.body = (tgt.body && tgt.body.trim()) ? tgt.body.replace(/\s*$/, '') + '\n\n' + md : md;
      tgt.dirty = true;
      if (ui.bodyEdit && ui.bodyEdit.id === tgt.id) ui.bodyEdit.ta.value = tgt.body;
    }
    setStatus('Image moved');
  } else {
    const n = mkNode({ x: target.x, y: target.y, parent: null, title: uniqueTitle(alt || 'image'),
      body: md, type: 'image', color: 'none', w: target.w, h: target.h });
    touch(n.id);                 // before-image is null (not yet in state) → undo removes it
    state.nodes.set(n.id, n);
    setStatus('Image extracted');
  }
  applyLayouts(); paintAll(); scheduleSave(); commitStep();
}
