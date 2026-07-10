// ---------- undo / redo ----------
// A unified, in-memory history of every mutation, as per-step per-node before/after snapshots
// keyed by node id (safe: ids are stable within a session and the history is cleared on every
// loadFromDir). Capture is a lazy "pending step": any mutation site calls touch(id) BEFORE
// changing a node (creations touch before inserting, so their before-image is null) and some
// gesture boundary calls commitStep() — pointer-up for drags, end-of-edit for inline editing,
// record() for one-shot ops. A step whose before/after images are identical is discarded, so
// plain clicks, cancelled drags and unchanged edits never pollute the history.
import { state, stage, setStatus, type MindNode, type Stroke } from '../core/state.js';
import { applyLayouts } from '../view/layout.js';
import { frameBox } from '../view/camera.js';
import { scheduleSave, scheduleSaveSketch } from '../data/persistence.js';
import { paintAll, setSelectionSet, NODE_W, nodeH } from '../main.js';
import { paintStrokes } from './sketch.js';
import { endInlineEdit, endBodyEdit } from './inline-edit.js';

// Everything persistent about a node EXCEPT its identity/render/dirty fields. `file` is
// snapshotted (needed to restore a deleted node) but is NOT written back onto a node that
// still exists — see applyImages. rx/ry are omitted too: they're the derived relative form of
// x/y, re-canonicalised by commitRel() (in applyLayouts / before save), so restoring x/y suffices.
type NodeSnap = Omit<MindNode, 'id' | 'el' | 'dirty' | 'dirtyLayout' | '_parentPath' | 'rx' | 'ry'>;
type Images = Map<string, NodeSnap | null>;      // null = the node does not exist
// A step captures node before/after images and, when a sketch gesture changed the ink layer,
// the whole strokes array before/after — one unified timeline covers both (see touchStrokes).
interface Step { before: Images; after: Images; strokes?: { before: Stroke[]; after: Stroke[] }; }

const MAX_STEPS = 100;
const undoStack: Step[] = [];
const redoStack: Step[] = [];
let pending: Images | null = null;
let pendingStrokes: Stroke[] | null = null;      // strokes before-image for the open step, if a sketch op touched it

const cloneStrokes = (s: Stroke[]): Stroke[] => structuredClone(s);
const sameStrokes = (a: Stroke[], b: Stroke[]): boolean => JSON.stringify(a) === JSON.stringify(b);

// Fixed key order (so JSON-compare in commitStep is reliable) + deep copies of the arrays.
function snap(n: MindNode): NodeSnap {
  return {
    file: n.file, x: n.x, y: n.y, parent: n.parent,
    collapsed: n.collapsed, done: n.done, checklist: n.checklist, bg: n.bg,
    layoutType: n.layoutType, side: n.side,
    title: n.title, color: n.color, keepStatus: n.keepStatus,
    tags: [...n.tags], body: n.body,
    fmEntries: n.fmEntries?.map(e => ({ key: e.key, lines: [...e.lines] })),
    kidOrder: n.kidOrder ? [...n.kidOrder] : undefined,
  };
}
const cloneSnap = (s: NodeSnap): NodeSnap => structuredClone(s);
const sameSnap = (a: NodeSnap | null, b: NodeSnap | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// Remember a node's pre-mutation image in the pending step (opening one if needed). Call
// BEFORE mutating — and for creations, before state.nodes.set(), so the image is null.
// Idempotent per id; a no-op in read-only mode (nothing records there).
export function touch(...ids: (string | null | undefined)[]): void {
  if (state.readOnly) return;
  for (const id of ids) {
    if (!id) continue;
    if (!pending) pending = new Map();
    if (pending.has(id)) continue;
    const n = state.nodes.get(id);
    pending.set(id, n ? snap(n) : null);
  }
}
// Remember the ink layer's pre-mutation image in the pending step. Call BEFORE changing
// state.strokes (adding a stroke, erasing). Idempotent per step; a no-op in read-only mode.
export function touchStrokes(): void {
  if (state.readOnly) return;
  if (!pendingStrokes) pendingStrokes = cloneStrokes(state.strokes);
}
// Close the pending step: capture after-images, drop untouched-in-practice nodes, and push.
export function commitStep(): void {
  const before = pending; pending = null;
  const strokesBefore = pendingStrokes; pendingStrokes = null;
  const step: Step = { before: new Map(), after: new Map() };
  if (before) for (const [id, b] of before) {
    const n = state.nodes.get(id);
    const a = n ? snap(n) : null;
    if (sameSnap(b, a)) continue;
    step.before.set(id, b); step.after.set(id, a);
  }
  if (strokesBefore && !sameStrokes(strokesBefore, state.strokes))
    step.strokes = { before: strokesBefore, after: cloneStrokes(state.strokes) };
  if (!step.before.size && !step.strokes) return;    // nothing actually changed
  undoStack.push(step);
  if (undoStack.length > MAX_STEPS) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
// Sugar for one-shot synchronous ops. Re-entrant: called while another step is already
// pending (e.g. deleteNode inside a live drag), it only touches — the outer owner commits.
export function record(ids: Iterable<string | null | undefined>, fn: () => void): void {
  const owner = !pending;
  touch(...ids);
  fn();
  if (owner) commitStep();
}
export function clearHistory(): void {
  undoStack.length = 0; redoStack.length = 0; pending = null; pendingStrokes = null;
  updateUndoButtons();
}

// Overwrite live state with one side of a step's images.
function applyImages(images: Images): void {
  for (const [id, s] of images) {
    const live = state.nodes.get(id);
    if (!s) {                                       // node must not exist
      if (live) {
        state.nodes.delete(id);
        live.el?.remove(); live.el = null;
        if (live.file) state.toDelete.push(live.file);
      }
    } else if (live) {
      // Keep the CURRENT file path: if a rename already flushed, saveAll's phase 1 must see
      // the on-disk name so it can rename back — restoring the old path would orphan the new
      // file. The restored title re-derives the right name via desiredFileFor.
      Object.assign(live, cloneSnap(s), { file: live.file });
      live.dirty = true; live.dirtyLayout = true;
    } else {                                        // resurrect a deleted node
      // rx/ry are re-canonicalised from the restored x/y by commitRel() (applyLayouts / save).
      state.nodes.set(id, { id, ...cloneSnap(s), rx: 0, ry: 0, dirty: true, dirtyLayout: true, el: null });
    }
  }
}
// Glide to the affected nodes only when they're entirely off-screen; a visible change
// shouldn't yank the camera around.
function frameIfOffscreen(ids: string[]): void {
  const nodes = ids.map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n);
  if (!nodes.length) return;
  const v = state.view, r = stage.getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x * v.k + v.x);            minY = Math.min(minY, n.y * v.k + v.y);
    maxX = Math.max(maxX, (n.x + NODE_W) * v.k + v.x); maxY = Math.max(maxY, (n.y + nodeH(n)) * v.k + v.y);
  }
  if (maxX < 0 || minX > r.width || maxY < 0 || minY > r.height) frameBox(nodes);
}
function applyStep(images: Images, strokes: Stroke[] | undefined, label: string): void {
  applyImages(images);
  if (strokes) { state.strokes = cloneStrokes(strokes); paintStrokes(); scheduleSaveSketch(); }
  // paint first so resurrected cards have real DOM heights, then lay out, then commit
  paintAll(); applyLayouts(); paintAll();
  const ids = [...images.keys()].filter(id => state.nodes.has(id));
  setSelectionSet(ids);
  frameIfOffscreen(ids);
  scheduleSave();
  setStatus(label);
}
export function undo(): void {
  if (state.readOnly) return;
  endInlineEdit(); endBodyEdit();      // an open edit session becomes the step being undone
  commitStep();                        // flush any dangling pending step
  const step = undoStack.pop();
  if (!step) { setStatus('Nothing to undo'); return; }
  redoStack.push(step);
  applyStep(step.before, step.strokes?.before, 'Undo');
  updateUndoButtons();
}
export function redo(): void {
  if (state.readOnly) return;
  endInlineEdit(); endBodyEdit();
  commitStep();                        // a fresh step clears redo, so this usually empties it
  const step = redoStack.pop();
  if (!step) { setStatus('Nothing to redo'); return; }
  undoStack.push(step);
  applyStep(step.after, step.strokes?.after, 'Redo');
  updateUndoButtons();
}

// ---------- toolbar buttons ----------
const undoBtn = document.getElementById('undoBtn') as HTMLButtonElement;
const redoBtn = document.getElementById('redoBtn') as HTMLButtonElement;
undoBtn.onclick = undo;
redoBtn.onclick = redo;
export function updateUndoButtons(): void {
  undoBtn.disabled = state.readOnly || !undoStack.length;
  redoBtn.disabled = state.readOnly || !redoStack.length;
}
updateUndoButtons();
