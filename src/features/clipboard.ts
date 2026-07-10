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
import { state, setStatus, isImageCard, type MindNode, type LayoutSide } from '../core/state.js';
import { serializeMd, parseMd, type ParsedNote } from '../utils/frontmatter.js';
import { isAncestor } from '../utils/model.js';
import { zipBytes, zipBlob } from '../utils/zip.js';
import { mkNode, uniqueTitle, deleteSelection } from './crud.js';
import { touch, record } from './history.js';
import { cancelDragRestore } from './drag.js';
import { imageExtractInProgress } from './image-extract.js';
import { downloadBlob } from '../utils/download.js';
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

// One card as a would-be .md file: its filename (title) + its exact file content.
export interface CardFile { name: string; text: string }

// The given cards INCLUDING their subtrees as one .md file per card, parent refs payload-local.
// Shared by copy (clipboard), the drag-out chip and ⌥-dragging a card out (files via DownloadURL).
export function filesFor(ids: string[]): CardFile[] {
  // dedupe: a card inside another given card's subtree is already covered
  const roots = ids.filter(id => !ids.some(a => a !== id && isAncestor(a, id)));
  const all = roots.flatMap(id => subtreeIds(id));   // preorder per root → parents precede kids
  const inPayload = new Set(all);
  return all.map(id => {
    const n = state.nodes.get(id)!;
    const p = n.parent && inPayload.has(n.parent) ? state.nodes.get(n.parent) : null;
    return { name: `${n.title}.md`, text: withParentRef(serializeMd(n), p ? `${p.title}.md` : null) };
  });
}
export function selectionFiles(): CardFile[] { return filesFor(selectedIds()); }
// Files → the marker-separated text payload tryPasteCards understands. Also used by the
// .md-file drop importer (a dropped note IS one of these chunks).
export const cardsToPayload = (files: CardFile[]): string =>
  files.map(f => `${MARK}${f.name} -->\n${f.text}`).join('\n');

// Copy the selected cards INCLUDING their subtrees to the system clipboard. Allowed in
// read-only mode (copying mutates nothing). Resolves true iff the clipboard write succeeded.
export async function copySelection(): Promise<boolean> {
  const files = selectionFiles();
  if (!files.length) return false;
  try {
    await navigator.clipboard.writeText(cardsToPayload(files));
    setStatus(`Copied ${files.length} card${files.length === 1 ? '' : 's'}`);
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
        type: c.p.mm.type, layout: c.p.mm.layout,
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

// ---------- drag cards OUT of the app as .md files ----------
// ⌥-dragging a card is natively draggable; dropping it on the OS file manager creates real
// files. That uses Chrome/Edge's non-standard `DownloadURL` flavour, which allows ONE entry per
// drag — a single card ships as its .md, a bigger selection as one .zip (the store-only writer
// is synchronous, so it can run inside dragstart). Browsers without DownloadURL still carry the
// text payload — dropping into an editor lands markdown.
function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// A multi-card export .zip is named after its first (root) card.
const zipName = (files: CardFile[]): string => files[0].name.replace(/\.md$/, '') + '.zip';
// The selection as ONE downloadable file: a single card is its .md, more become a .zip.
function exportFile(files: CardFile[]): { mime: string; name: string; bytes: Uint8Array } {
  return files.length === 1
    ? { mime: 'text/markdown', name: files[0].name, bytes: new TextEncoder().encode(files[0].text) }
    : { mime: 'application/zip', name: zipName(files),
        bytes: zipBytes(files.map(f => ({ name: f.name, data: f.text }))) };
}
// ⌥/Alt-drag a CARD out of the window → the same OS file drag as the chip. The card's plain
// drag gesture belongs to the pointer-based canvas move (drag.ts), and a native drag can only
// begin at gesture start — so ⌥ at dragstart is the fork: without it the native drag is
// suppressed (canvas move proceeds untouched); with it the already-started pointer drag is
// cancelled (positions snap back) and the browser's drag takes over, carrying the DownloadURL.
export function bindCardFileDrag(n: MindNode): void {
  const el = n.el!;
  el.draggable = true;
  el.addEventListener('dragstart', (e: DragEvent) => {
    if (!e.altKey || !e.dataTransfer){ e.preventDefault(); return; }
    // ⌥-press began on an inline body image → that's an image EXTRACT gesture (image-extract.ts),
    // not a card-file export; let the native drag stand down so the pointer machinery keeps it.
    if (imageExtractInProgress()){ e.preventDefault(); return; }
    // ⌥-dragging an image CARD is a merge-into-a-card / reposition gesture handled entirely by the
    // pointer machinery (drag.ts updateDropTarget) — an image isn't a note, so never take it over
    // as a .md export; bail so the pointer drag keeps control (otherwise cancelDragRestore below
    // would abort it, killing the drop-target highlight and the merge).
    if (isImageCard(n)){ e.preventDefault(); return; }
    // the pointer machinery grabbed this gesture at pointerdown — take it back cleanly
    cancelDragRestore();
    const ids = state.sel.has(n.id) && state.sel.size > 1 ? [...state.sel] : [n.id];
    const f = exportFile(filesFor(ids));
    e.dataTransfer.effectAllowed = 'copy';
    // ONLY DownloadURL — Chrome ignores it when other formats are set alongside (crbug 55071)
    e.dataTransfer.setData('DownloadURL', `${f.mime}:${f.name}:data:${f.mime};base64,${b64(f.bytes)}`);
    setStatus(`Drop to save ${f.name}`);
  });
}

// The float bar's kebab-menu export entry: download the selected cards (with their subtrees)
// as one .zip. A plain download works in every browser; for drag-to-Finder use ⌥-drag on the
// card itself.
export function exportSelection(): void {
  const files = selectionFiles();
  if (!files.length) return;
  const name = zipName(files);
  downloadBlob(zipBlob(files.map(f => ({ name: f.name, data: f.text }))), name);
  setStatus(`Saved ${name}`);
}

// Whether the OS share sheet is available for files — feature-detected once; gates the kebab
// menu's "Share" entry. canShare()/navigator.share can report truthy yet every real share() call
// still rejects with the exact same NotAllowedError, because the browser has no OS share surface
// to hand the file to at all — excluded up front rather than greying the entry in on a false
// positive:
//  - a bare `file://` page (only rejects at call time)
//  - any desktop Linux browser (no native share sheet exists on that platform at all)
//  - Chromium (Chrome/Edge) on macOS before Chrome 128 — crbug.com/1144920, a long-standing
//    macOS-specific gap in Chromium's Web Share implementation (Safari on macOS always had it;
//    Chromium fixed it around Chrome 128 per caniuse, so 128+ is trusted at face value).
const ua = navigator.userAgent;
const isMac = /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad|iPod/.test(ua);
const isLinux = /Linux/.test(ua) && !/Android/.test(ua) && !/CrOS/.test(ua);
const chromeVersion = Number(ua.match(/Chrome\/(\d+)/)?.[1]);
const isPreFix128MacChrome = isMac && chromeVersion > 0 && chromeVersion < 128;
const noOsShareSurface = isLinux || isPreFix128MacChrome;
const shareFile = new File(['x'], 'x.md', { type: 'text/markdown' });
export const canShareFiles = location.protocol !== 'file:' && !noOsShareSurface
  && typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [shareFile] });

// Share the selected cards (with their subtrees) via the OS share sheet — same payload as
// exportSelection (single card → .md, multi → .zip), handed to another app/device instead of
// downloaded. The receiving side just needs to accept a .md/.zip file (e.g. another Mindmap
// tab/device via its "Open .md/.zip" import, AirDrop, Files, a chat app, …).
export async function shareSelection(): Promise<void> {
  const files = selectionFiles();
  if (!files.length) return;
  const f = exportFile(files);
  const file = new File([f.bytes as BlobPart], f.name, { type: f.mime });
  if (!navigator.canShare?.({ files: [file] })){
    console.error('shareSelection: navigator.canShare rejected', file.type, file.name);
    setStatus('Can’t share this as a file');
    return;
  }
  try {
    await navigator.share({ files: [file], title: f.name });
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return;   // user dismissed the share sheet
    console.error('shareSelection: navigator.share failed', err, { ua: navigator.userAgent, platform: navigator.platform });
    setStatus('Couldn’t share');
  }
}
