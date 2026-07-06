// ---------- copy / cut / paste of cards ----------
// The clipboard payload is the cards' NATIVE format: each card's .md file content
// (serializeMd), concatenated. Since a card's title is its FILENAME (not stored inside the
// file), every card is preceded by a marker line carrying it:
//
//   <!-- mindmap-card: My Title.md -->
//   ---
//   …frontmatter…
//   ---
//   body
//
// `mm_parent` is rewritten to the PAYLOAD-LOCAL name ("Title.md") when the parent is part of
// the payload, and stripped for payload roots — so ids/disk paths never leak and a paste into
// another tab/map reconstructs the subtree by name. Plain text stays readable markdown, so
// pasting into a text editor / Obsidian yields real notes. Anything on the clipboard that
// doesn't start with the marker falls through to the existing paste-as-new-card behaviour
// (features/attachments.ts).
import { state, setStatus, type MindNode, type LayoutType, type LayoutSide } from '../core/state.js';
import { serializeMd, parseMd, type ParsedNote } from '../utils/frontmatter.js';
import { isAncestor } from '../utils/model.js';
import { mkNode, uniqueTitle, deleteSelection } from './crud.js';
import { touch, record } from './history.js';
import { screenToWorld } from '../view/camera.js';
import { applyLayouts } from '../view/layout.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, setSelectionSet, selectedIds, subtreeIds } from '../main.js';

const MARK = '<!-- mindmap-card: ';
const MARK_RE = /^<!-- mindmap-card: (.+?) -->$/gm;

// Rewrite the frontmatter's mm_parent to a payload-local name (or drop it for payload roots).
// serializeMd emits the parent's on-disk path, which is meaningless outside this map.
function withParentRef(md: string, parentName: string | null): string {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return md;
  const fm = m[1].split('\n').filter(l => !l.startsWith('mm_parent:'));
  if (parentName) fm.push(`mm_parent: ${parentName}`);
  return `---\n${fm.join('\n')}\n---\n${m[2]}`;
}

// Copy the selected cards INCLUDING their subtrees to the system clipboard. Allowed in
// read-only mode (copying mutates nothing). Resolves true iff the clipboard write succeeded.
export async function copySelection(): Promise<boolean> {
  const ids = selectedIds();
  // dedupe: a selected node inside another selected node's subtree is already covered
  const roots = ids.filter(id => !ids.some(a => a !== id && isAncestor(a, id)));
  const all = roots.flatMap(id => subtreeIds(id));   // preorder per root → parents precede kids
  if (!all.length) return false;
  const inPayload = new Set(all);
  const text = all.map(id => {
    const n = state.nodes.get(id)!;
    const p = n.parent && inPayload.has(n.parent) ? state.nodes.get(n.parent) : null;
    return `${MARK}${n.title}.md -->\n` + withParentRef(serializeMd(n), p ? `${p.title}.md` : null);
  }).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${all.length} card${all.length === 1 ? '' : 's'}`);
    return true;
  } catch {
    setStatus('Couldn’t copy');
    return false;
  }
}

// Cut = copy + delete. The delete only happens once the clipboard write succeeded, so a
// denied clipboard can never destroy cards. deleteSelection records its own undo step.
export async function cutSelection(): Promise<void> {
  if (state.readOnly) return;
  const ids = selectedIds();
  if (!ids.length || !(await copySelection())) return;
  deleteSelection();
  setStatus(`Cut ${ids.length} card${ids.length === 1 ? '' : 's'}`);
}

// Try to paste `text` as cards. Returns false when it isn't a card payload (the caller falls
// through to the ordinary text/image paste); true when handled (even if only with a status).
// Roots land as children of `parent` (when given), else free at (sx,sy) / the viewport centre,
// keeping the copied cards' relative offsets plus a small nudge so a paste over the source
// never lands exactly on top.
export function tryPasteCards(text: string, at: { sx: number | null; sy: number | null; parent: string | null }): boolean {
  if (!text.startsWith(MARK)) return false;
  if (state.readOnly){ setStatus('Read-only — can’t paste'); return true; }
  // split on the marker lines; each chunk is one card's .md content named by its marker
  const cards: { name: string; p: ParsedNote }[] = [];
  const marks = [...text.matchAll(MARK_RE)];
  for (let i = 0; i < marks.length; i++){
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    cards.push({ name: marks[i][1], p: parseMd(text.slice(start, end).trim(), marks[i][1]) });
  }
  if (!cards.length) return false;
  const byName = new Map(cards.map(c => [c.name, c]));
  const isPayloadRoot = (c: { p: ParsedNote }): boolean => !c.p.mm.parent || !byName.has(c.p.mm.parent);
  // anchor the payload roots' top-left at the target point (+ a nudge off the source)
  const target = (at.sx != null && at.sy != null)
    ? screenToWorld(at.sx, at.sy)
    : screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  let ax = Infinity, ay = Infinity;
  for (const c of cards) if (isPayloadRoot(c) && c.p.mm.x != null && c.p.mm.y != null){
    ax = Math.min(ax, c.p.mm.x); ay = Math.min(ay, c.p.mm.y);
  }
  const dx = target.x - (ax === Infinity ? target.x : ax) + 16;
  const dy = target.y - (ay === Infinity ? target.y : ay) + 16;
  const rootIds: string[] = [];
  record([], () => {
    const parentNode = at.parent ? state.nodes.get(at.parent) : undefined;
    if (parentNode?.collapsed){ touch(parentNode.id); parentNode.collapsed = false; }   // reveal the drop
    const newIds = new Map<string, string>();   // payload name -> minted id
    for (const c of cards){
      const root = isPayloadRoot(c);
      const n = mkNode({
        x: (c.p.mm.x ?? target.x) + dx, y: (c.p.mm.y ?? target.y) + dy,
        title: uniqueTitle(c.p.title),
        color: c.p.color, keepStatus: c.p.keepStatus,
        tags: [...c.p.tags], body: c.p.body, fmEntries: c.p.fmEntries,
        collapsed: c.p.mm.collapsed, done: c.p.mm.done, checklist: c.p.mm.checklist, bg: c.p.mm.bg,
        layoutType: (c.p.mm.layout || 'none') as LayoutType,
        // a root reattaches to the paste target — its old side is meaningless there
        side: root ? undefined : (c.p.mm.side || undefined) as LayoutSide | undefined,
      });
      state.nodes.set(n.id, n);
      newIds.set(c.name, n.id);
      if (root) rootIds.push(n.id);
    }
    // resolve payload-internal parent links (by original names, before any title renaming)
    for (const c of cards){
      const n = state.nodes.get(newIds.get(c.name)!) as MindNode;
      n.parent = isPayloadRoot(c) ? (parentNode?.id ?? null) : newIds.get(c.p.mm.parent)!;
    }
    // paint first so the new cards have real DOM heights, then lay out, then commit
    paintAll(); applyLayouts(); paintAll();
    setSelectionSet(rootIds);
    scheduleSave();
  });
  setStatus(`Pasted ${cards.length} card${cards.length === 1 ? '' : 's'}`);
  return true;
}
