// ============================================================
// Disk I/O orchestration over the active `store` adapter: load the vault into state,
// debounced autosave, import/export .zip, and the focus/visibility reload. Every mutation
// elsewhere calls scheduleSave(); a burst coalesces into one write ~400ms later.
// `store` is the active backend (reassigned by useStore); main holds the open() flows.
// ============================================================
import { state, world, setStatus, type MindNode, type LayoutType } from '../core/state.js';
import { parseMd, serializeMd } from '../utils/frontmatter.js';
import { zipBlob, unzip } from '../utils/zip.js';
import { childrenOf } from '../utils/model.js';
import { applyLayouts, radialLayout, collapseAtDepth } from '../view/layout.js';
import { fit } from '../view/camera.js';
import { resetImageCache } from '../features/images.js';
import { opfsStore, fsaStore, resolveOnDeviceStore, seenFolders, markFolderSeen, type Store } from '../store/index.js';
import { paintAll, selectNode } from '../main.js';
import { ui, isTypingInField } from '../core/ui-state.js';
import { hideStart } from '../boot.js';

// Active backend. Local-first: default to the on-device vault; "Open folder" swaps in fsaStore.
export let store: Store = opfsStore;
export const LAST_STORE_KEY = 'mindmap.lastStore';   // 'opfs' | 'folder'
export function useStore(s: Store, kind?: string): void {
  store = s; store.watch(reloadFromDisk); if (kind) localStorage.setItem(LAST_STORE_KEY, kind);
}

// ---- import / export as .zip (move a map between devices / back it up) ----
const importInput = document.createElement('input');
importInput.type = 'file';
importInput.accept = '.zip,.md,.markdown,.png,.jpg,.jpeg,.gif,.webp,.svg,.avif,.bmp';
importInput.multiple = true;
importInput.style.display = 'none';
document.body.appendChild(importInput);
importInput.addEventListener('change', async () => {
  const files = [...(importInput.files || [])];
  importInput.value = '';
  if (files.length) await importFiles(files);
});
export function openImportPicker(): void { importInput.click(); }

const IMG_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
type ImportEntry = { name: string; text?: string; bytes?: Uint8Array };
export async function importFiles(files: File[]): Promise<void> {
  const entries: ImportEntry[] = [];
  for (const f of files){
    if (/\.zip$/i.test(f.name)) { try { entries.push(...await unzip(await f.arrayBuffer())); } catch { setStatus('That .zip could not be read.'); } }
    else if (/\.(md|markdown)$/i.test(f.name)) entries.push({ name: f.name, text: await f.text() });
    else if (IMG_RE.test(f.name)) entries.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  let md  = entries.filter(e => /\.(md|markdown)$/i.test(e.name) && !e.name.endsWith('/'));
  let img = entries.filter(e => e.bytes && IMG_RE.test(e.name) && !e.name.endsWith('/'));
  if (!md.length){ setStatus('No Markdown files found to import.'); return; }
  // strip a single common top-level folder (e.g. a zip of "MyNotes/…") from notes AND attachments,
  // so the relative ![](attachments/…) links still resolve after import
  const slash = md[0].name.indexOf('/');
  const top = slash >= 0 ? md[0].name.slice(0, slash + 1) : '';
  if (top && md.every(e => e.name.startsWith(top))){
    md  = md.map(e => ({ ...e, name: e.name.slice(top.length) }));
    img = img.map(e => e.name.startsWith(top) ? { ...e, name: e.name.slice(top.length) } : e);
  }
  for (const e of md)  await store.write(e.name, e.text ?? '');
  for (const e of img) await store.write(e.name, new Blob([e.bytes! as BlobPart]));
  hideStart();
  await loadFromDir();
  setStatus(`Imported ${md.length} note${md.length===1?'':'s'}${img.length ? ` + ${img.length} image${img.length===1?'':'s'}` : ''}.`);
}

// download every current note (plus the image attachments they reference) packed into a .zip
export async function exportZip(): Promise<void> {
  const nodes = [...state.nodes.values()];
  if (!nodes.length){ setStatus('Nothing to export yet.'); return; }
  const used = new Set<string>();
  const files: { name: string; data?: string; bytes?: Uint8Array }[] = nodes.map(n => {
    let name = n.file || (safeName(n.title) + '.md');
    while (used.has(name)) name = name.replace(/(\.md)?$/, '') + '-1.md';
    used.add(name);
    return { name, data: serializeMd(n) };
  });
  // collect every vault-relative image referenced in a body, and pack the files alongside the notes
  const refs = new Set<string>();
  const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  for (const n of nodes){ let m: RegExpExecArray | null; const b = n.body || ''; while ((m = re.exec(b))){ const p = m[1]; if (!/^(https?:|data:)/i.test(p)) refs.add(p); } }
  // read every referenced image concurrently, then pack the ones that resolved
  const images = await Promise.all([...refs].map(async path => {
    const blob = store.readBlob ? await store.readBlob(path) : null;
    return blob ? { name: path, bytes: new Uint8Array(await blob.arrayBuffer()) } : null;
  }));
  const attached = images.filter(Boolean).length;
  for (const img of images) if (img) files.push(img);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zipBlob(files));
  a.download = 'mindmap.zip';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  setStatus(`Exported ${nodes.length} notes${attached ? ` + ${attached} image${attached === 1 ? '' : 's'}` : ''} → mindmap.zip`);
}

export async function loadFromDir({ keepView = false }: { keepView?: boolean } = {}): Promise<void> {
  state.nodes.clear(); state.toDelete = []; world.querySelectorAll('[data-id]').forEach(e=>e.remove());
  resetImageCache();   // blob URLs from the previous map (or store) are stale now

  // First pass: read every .md and parse it (layout now lives in each note's frontmatter).
  const entries: { rel: string; parsed: ReturnType<typeof parseMd> }[] = [];
  for (const { path, text } of await store.list()) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    entries.push({ rel: path, parsed: parseMd(text, base) });
  }

  // Ids are ephemeral (minted fresh each load) since the filename is the real identity —
  // parent links are stored/resolved BY PATH, so ids never need to survive a reload.
  let seq = 0;
  let placed = 0;          // count of notes lacking a saved position, for fallback layout
  for (const { rel, parsed } of entries) {
    const { mm, ...rest } = parsed;
    const hasPos = (mm.x != null && mm.y != null);
    const node: MindNode = {
      id: 'n' + (++seq), file:rel,
      x: hasPos ? mm.x! : (120 + (placed % 4) * 240),
      y: hasPos ? mm.y! : (120 + Math.floor(placed / 4) * 200),
      _parentPath: mm.parent || '',                // resolved to an id once all notes are loaded
      parent: null,
      collapsed: !!mm.collapsed,
      done: !!mm.done,
      checklist: !!mm.checklist,
      layoutType: (mm.layout || 'none') as LayoutType,
      ...rest, dirty:false, dirtyLayout: !hasPos,   // notes lacking a position get one persisted
    };
    if (!hasPos) placed++;                         // new note with no saved position
    state.nodes.set(node.id, node);
  }
  // Resolve each note's parent path -> the loaded node's id (drops links to missing files).
  const byPath = new Map([...state.nodes.values()].map(n => [n.file, n.id]));
  for (const n of state.nodes.values()) {
    n.parent = n._parentPath ? (byPath.get(n._parentPath) || null) : null;
    delete n._parentPath;
  }
  // advance the runtime id counter past everything we just loaded so new nodes don't collide
  state.idSeq = seq + 1;
  // Auto-collapse a big map ONLY the very first time this folder is opened. After that we
  // always restore exactly the saved frontmatter state — reopening must look like you left it.
  const firstEver = !seenFolders().includes(store.name);
  if (!keepView && firstEver && state.nodes.size > 40) {
    collapseAtDepth(1);
    radialLayout();
  }
  if (!keepView) markFolderSeen(store.name);
  // Resolve layouts in three steps: paint once so every card has a real measured height, run
  // the line/fan layout against those true heights, then paint the resolved positions.
  paintAll();
  applyLayouts();
  paintAll();
  if (!keepView) fit();
  // Persist the resolved layout so the saved mm_x/mm_y match what's on screen. Only write when
  // the load actually moved something, so a stable reopen touches no files.
  if (!state.readOnly && [...state.nodes.values()].some(n => n.dirty || n.dirtyLayout))
    scheduleSave();
  // show the loaded folder's name inside the home button (:empty hides it until loaded)
  document.getElementById('folderName')!.textContent = store.name;
  document.title = 'Mindmap - ' + store.name;
}
// title -> safe filename component (no path separators or illegal chars)
function safeName(title: string): string {
  return (title || 'Untitled').trim().replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g,' ').slice(0,120);
}
// returns the filename a node SHOULD have, given its title, keeping its current directory.
function desiredFileFor(n: MindNode): string {
  const dir = n.file ? n.file.slice(0, n.file.lastIndexOf('/')+1) : '';
  const base = safeName(n.title) + '.md';
  let rel = dir + base;
  // avoid clobbering a DIFFERENT node that already uses this filename
  let i = 2;
  while ([...state.nodes.values()].some(o => o !== n && o.file === rel)) {
    rel = dir + safeName(n.title) + ' ' + (i++) + '.md';
  }
  return rel;
}
export async function saveAll(): Promise<void> {
  if (state.readOnly) return;        // read-only mode never writes to disk
  if (!store.isOpen) { setStatus('Open a folder first.'); return; }
  for (const f of state.toDelete) await store.remove(f);
  state.toDelete = [];

  // Layout lives in each note's frontmatter, so any content OR layout change rewrites the file.
  const needWrite = new Set<string>();
  for (const n of state.nodes.values()) if (n.dirty || n.dirtyLayout || !n.file) needWrite.add(n.id);

  // Phase 1 — settle every note's final filename IN MEMORY first. A child records its parent
  // by path (mm_parent), so a renamed parent forces its children to be rewritten, and all
  // parent paths must be final before we serialize anyone.
  const removals: string[] = [];
  for (const n of state.nodes.values()) {
    // While the title is being typed, keep the current filename (rename happens on blur).
    const freezeName = !!ui.inlineEdit && n.id === state.selId && n.file;
    const target = freezeName ? n.file : desiredFileFor(n);
    if (n.file && n.file !== target) {
      removals.push(n.file);                       // old file to delete once the rename is written
      for (const c of childrenOf(n.id)) needWrite.add(c.id);
    }
    if (n.file !== target) needWrite.add(n.id);    // brand-new node, or a rename
    n.file = target;                               // adopt the final name
  }

  // Phase 2 — write everything that changed, now that all paths are final.
  let written = 0;
  for (const n of state.nodes.values()) {
    if (!needWrite.has(n.id)) continue;
    await store.write(n.file!, serializeMd(n));
    n.dirty = false; n.dirtyLayout = false;
    written++;
  }
  // Phase 3 — drop files left behind by renames (unless some node now legitimately holds the path).
  for (const old of removals)
    if (![...state.nodes.values()].some(n => n.file === old)) await store.remove(old);

  state.lastSelfWrite = Date.now();   // so focus-reload can ignore our own writes
  paintAll();
  setStatus(`Saved ${written} file${written===1?'':'s'} · ` + new Date().toLocaleTimeString());
}

// ---------- autosave (debounced) ----------
let saveTimer: number | undefined, saving = false, saveAgain = false;
export function scheduleSave(): void {
  if (state.readOnly) return;         // read-only mode never writes to disk
  if (!store.isOpen) return;          // demo mode: nothing to write
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
export async function flushSave(): Promise<void> {
  if (!store.isOpen) return;
  if (saving) { saveAgain = true; return; }   // coalesce overlapping writes
  saving = true;
  try {
    await saveAll();
  } catch (err) {
    console.error('Save failed:', err);
    setStatus('⚠ Save failed: ' + ((err as Error).message || (err as Error).name));
  }
  saving = false;
  if (saveAgain) { saveAgain = false; flushSave(); }
}

// ---------- reload on focus ----------
let reloading = false;
export async function reloadFromDisk(): Promise<void> {
  if (!store.isOpen) return;
  // A single refocus dispatches BOTH window 'focus' and 'visibilitychange'. Guard re-entry.
  if (reloading) return;
  // if we just wrote, the focus event is almost certainly our own round-trip — skip
  if (Date.now() - (state.lastSelfWrite || 0) < 600) return;
  clearTimeout(saveTimer);
  if (saving) return;                 // a write is mid-flight; don't read torn state
  const selBefore = state.selId;
  // Don't yank the rug out while the user is actively typing in the panel or renaming a card.
  if (ui.inlineEdit || ui.bodyEdit || isTypingInField()) return;
  reloading = true;
  try {
    await loadFromDir({ keepView:true });
    if (selBefore && state.nodes.has(selBefore)) selectNode(selBefore);
    else selectNode(null);
  } finally {
    reloading = false;
  }
}
store.watch(reloadFromDisk);   // re-read on external change (FSA: window-focus / tab-visible)
