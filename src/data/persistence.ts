// ============================================================
// Disk I/O orchestration over the active `store` adapter: load the vault into state,
// debounced autosave, import/export .zip, and the focus/visibility reload. Every mutation
// elsewhere calls scheduleSave(); a burst coalesces into one write ~400ms later.
// `store` is the active backend (reassigned by useStore); main holds the open() flows.
// ============================================================
import { state, world, setStatus, type MindNode, type LayoutSide } from '../core/state.js';
import { parseMd, serializeMd } from '../utils/frontmatter.js';
import { zipBlob, unzip } from '../utils/zip.js';
import { downloadBlob } from '../utils/download.js';
import { childrenOf } from '../utils/model.js';
import { applyLayouts, collapseAtDepth, deriveSide, commitRel } from '../view/layout.js';
import { fit } from '../view/camera.js';
import { resetImageCache } from '../features/images.js';
import { clearHistory } from '../features/history.js';
import { opfsStore, fsaStore, resolveOnDeviceStore, seenFolders, markFolderSeen, setLastMap, touchMap, createDeviceMap, type Store, type MapKind, type MapRef } from '../store/index.js';
import { paintAll, selectNode } from '../main.js';
import { updateDocumentTitle } from '../nav/url-state.js';
import { paintStrokes } from '../features/sketch.js';
import { refreshGrid } from '../view/grid.js';
import { ui, isTypingInField, editSessionActive, frozenFileNodeId } from '../core/ui-state.js';
import { hideStart } from '../boot.js';

// The sketch layer lives beside the notes as one plain JSON data file (Obsidian .canvas-style),
// not a note — it holds no mm_* / frontmatter, just world-space strokes. Read/written through the
// same store I/O as everything else (see load/save below).
export const SKETCH_FILE = 'sketch.json';

// Small per-map view preferences that should travel with the vault (like the sketch layer)
// rather than live in localStorage (which is per-browser). Currently just the background grid.
export const SETTINGS_FILE = 'settings.json';

// Active backend. Local-first: default to on-device; "Open folder" swaps in fsaStore.
// `ref` identifies WHICH map is now open (registry entry + what boot() reopens); omit it
// for stores that aren't registry-backed (help).
export let store: Store = opfsStore;
// Which map is on the canvas RIGHT NOW — in-memory runtime state, unlike the persisted
// last-map key (which another tab may rewrite). null for non-registry stores (help).
export let currentMap: { kind: MapKind; id: string } | null = null;
export function useStore(s: Store, ref?: { kind: MapKind; id: string }): void {
  store = s; store.watch(reloadFromDisk);
  currentMap = ref ?? null;
  if (ref) { setLastMap(ref.kind, ref.id); touchMap(ref.id); }
}

// Retarget the app at another on-device map. settleSave MUST come first — a straggling
// autosave firing after the adapter retargets would write the old map's files into the new one.
export async function switchToDeviceMap(ref: MapRef): Promise<void> {
  await settleSave();
  const s = await resolveOnDeviceStore();
  s.openMap(ref.id, ref.name);
  await s.pick();
  useStore(s, { kind: 'device', id: ref.id });
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
  // An import always ADDS a new on-device map, never merges into the current one — named
  // after the .zip when there is one.
  const zipBase = files.find(f => /\.zip$/i.test(f.name))?.name.replace(/\.zip$/i, '').trim();
  const ref = await createDeviceMap(await resolveOnDeviceStore(), zipBase || 'Imported map');
  await switchToDeviceMap(ref);
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
  // carry over the sketch layer if the archive included one (matching the note top-folder strip)
  const sketch = entries.find(e => e.text != null && (e.name === SKETCH_FILE || e.name === top + SKETCH_FILE));
  if (sketch?.text != null) await store.write(SKETCH_FILE, sketch.text);
  hideStart();
  await loadFromDir();
  setStatus(`Imported ${md.length} note${md.length===1?'':'s'}${img.length ? ` + ${img.length} image${img.length===1?'':'s'}` : ''}.`);
}

// download every current note (plus the image attachments they reference) packed into a .zip
export async function exportZip(): Promise<void> {
  const nodes = [...state.nodes.values()];
  if (!nodes.length){ setStatus('Nothing to export yet.'); return; }
  commitRel();   // serializeMd persists rx/ry — refresh it from the live x/y first
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
  if (state.strokes.length) files.push({ name: SKETCH_FILE, data: sketchJSON() });
  const zipName = safeName(store.name || 'mindmap') + '.zip';   // the map's name, not a generic one
  downloadBlob(zipBlob(files), zipName);
  setStatus(`Exported ${nodes.length} notes${attached ? ` + ${attached} image${attached === 1 ? '' : 's'}` : ''} → ${zipName}`);
}

export async function loadFromDir({ keepView = false }: { keepView?: boolean } = {}): Promise<void> {
  clearHistory();   // ids are minted fresh per load, so no snapshot survives a (re)load / map switch
  state.nodes.clear(); state.toDelete = []; world.querySelectorAll('[data-id]').forEach(e=>e.remove());
  resetImageCache();   // blob URLs from the previous map (or store) are stale now
  await loadSketch();  // read the freehand ink layer (sketch.json) for this map, if any
  await loadSettings(); // read this map's view prefs (settings.json), e.g. the background grid
  refreshGrid();

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
  // Seed each node's rx/ry from disk; the top-down pass below settles them to parent-relative and
  // derives the working x/y. The raw seed's frame of reference depends on the fields present:
  //  · relSeed  — the current mm_position_x/y fields: already parent-relative (roots world-relative).
  //  · legacySeed — the legacy mm_x/mm_y fields: parent-relative ONLY for frame children (the old
  //    behaviour), otherwise ABSOLUTE — converted to relative in the top-down pass below.
  //  · neither — a grid fallback (absolute), likewise converted below.
  // TODO: legacySeed is a transitional migration shim — it can go once every map has been re-saved
  // (serializeMd only re-emits mm_position_*, so the first save of any note drops its mm_x/mm_y).
  const relSeed = new Set<string>();
  const legacySeed = new Set<string>();
  for (const { rel, parsed } of entries) {
    const { mm, ...rest } = parsed;
    const hasRel = (mm.px != null && mm.py != null);
    const hasLegacy = (mm.x != null && mm.y != null);
    const hasPos = hasRel || hasLegacy;
    const node: MindNode = {
      id: 'n' + (++seq), file:rel, x: 0, y: 0,   // x/y derived from rx/ry in the top-down pass below
      rx: hasRel ? mm.px! : hasLegacy ? mm.x! : (120 + (placed % 4) * 240),
      ry: hasRel ? mm.py! : hasLegacy ? mm.y! : (120 + Math.floor(placed / 4) * 200),
      _parentPath: mm.parent || '',                // resolved to an id once all notes are loaded
      parent: null,
      collapsed: !!mm.collapsed,
      locked: !!mm.locked,
      done: !!mm.done,
      checklist: !!mm.checklist,
      bg: !!mm.bg,
      type: mm.type, layout: mm.layout,
      w: mm.w ?? undefined,
      h: mm.h ?? undefined,
      side: (mm.side || undefined) as LayoutSide | undefined,
      ...rest, dirty:false, dirtyLayout: !hasPos,   // notes lacking a position get one persisted
    };
    if (hasRel) relSeed.add(node.id);
    else if (hasLegacy) legacySeed.add(node.id);
    else placed++;                                  // no saved position → fallback layout
    state.nodes.set(node.id, node);
  }
  // Resolve each note's parent path -> the loaded node's id (drops links to missing files).
  const byPath = new Map([...state.nodes.values()].map(n => [n.file, n.id]));
  for (const n of state.nodes.values()) {
    n.parent = n._parentPath ? (byPath.get(n._parentPath) || null) : null;
    delete n._parentPath;
  }
  // Settle every rx/ry to parent-relative and derive the working x/y, in one top-down pass so the
  // parent's absolute x/y is already final when we reach a child. relSeed and legacy frame children
  // are already relative; the rest hold an ABSOLUTE seed, so subtract the parent's position.
  const kidsOf = new Map<string | null, MindNode[]>();
  for (const n of state.nodes.values()) { const k = kidsOf.get(n.parent) ?? []; k.push(n); kidsOf.set(n.parent, k); }
  const stack = [...(kidsOf.get(null) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    const p = n.parent ? state.nodes.get(n.parent) : null;
    const pax = p ? p.x : 0, pay = p ? p.y : 0;   // final (parents are visited before their children)
    const alreadyRel = relSeed.has(n.id) || (legacySeed.has(n.id) && !!p && p.type === 'frame');
    if (p && !alreadyRel) { n.rx -= pax; n.ry -= pay; }   // absolute seed → parent-relative
    n.x = pax + n.rx; n.y = pay + n.ry;                   // working absolute coords
    for (const k of kidsOf.get(n.id) ?? []) stack.push(k);
  }
  // A note with no `mm_side` yet (never dropped, or from before this field existed) gets one
  // backfilled from its saved position, once, right here — not re-derived on every relayout.
  for (const n of state.nodes.values()) {
    if (n.parent && !n.side) {
      const p = state.nodes.get(n.parent);
      if (p) n.side = deriveSide(p, n);
    }
  }
  // advance the runtime id counter past everything we just loaded so new nodes don't collide
  state.idSeq = seq + 1;
  // Auto-collapse a big map ONLY the very first time this folder is opened. After that we
  // always restore exactly the saved frontmatter state — reopening must look like you left it.
  const seenKey = store.seenKey;   // stable per map (names can be renamed / collide)
  const firstEver = !seenFolders().includes(seenKey);
  if (!keepView && firstEver && state.nodes.size > 40)
    collapseAtDepth(1);   // applyLayouts() below resolves positions
  if (!keepView) markFolderSeen(seenKey);
  // Resolve layouts in three steps: paint once so every card has a real measured height, run
  // the line/fan layout against those true heights, then paint the resolved positions.
  paintAll();
  applyLayouts();
  paintAll();
  paintStrokes();      // render the sketch layer over the freshly loaded map
  if (!keepView) fit();
  // Persist the resolved layout so the saved mm_x/mm_y match what's on screen. Only write when
  // the load actually moved something, so a stable reopen touches no files.
  if (!state.readOnly && [...state.nodes.values()].some(n => n.dirty || n.dirtyLayout))
    scheduleSave();
  updateMapTitle();
}
// Show the open map's name in the home button (:empty hides it until loaded) + the tab title.
export function updateMapTitle(): void {
  document.getElementById('folderName')!.textContent = store.name;
  updateDocumentTitle();
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
  commitRel();   // serializeMd persists rx/ry — refresh it from the live x/y first
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
    // While the title is being typed (in-card rename OR the editor sheet), keep the current
    // filename (rename happens when the edit session commits).
    const freezeName = frozenFileNodeId(state.selId) === n.id && n.file;
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
let saveTimer: number | undefined, saveAgain = false;
let savePromise: Promise<void> | null = null;   // non-null while a save chain is in flight
export function scheduleSave(): void {
  if (state.readOnly) return;         // read-only mode never writes to disk
  if (!store.isOpen) return;          // demo mode: nothing to write
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
export function flushSave(): Promise<void> {
  if (!store.isOpen) return Promise.resolve();
  clearTimeout(saveTimer); saveTimer = undefined;
  if (savePromise) { saveAgain = true; return savePromise; }   // coalesce overlapping writes
  savePromise = (async () => {
    try {
      await saveAll();
    } catch (err) {
      console.error('Save failed:', err);
      setStatus('⚠ Save failed: ' + ((err as Error).message || (err as Error).name));
    }
    savePromise = null;
    if (saveAgain) { saveAgain = false; await flushSave(); }
  })();
  return savePromise;
}
// Write out everything still pending (debounced or in flight, notes AND sketch), awaiting
// completion. MUST be called before retargeting the store at another map/folder — a straggling
// autosave firing after the switch would write the old map's files into the new one.
export async function settleSave(): Promise<void> {
  const sketchPending = sketchTimer != null;
  clearTimeout(sketchTimer); sketchTimer = undefined;
  if (sketchPending) await flushSketch();
  const settingsPending = settingsTimer != null;
  clearTimeout(settingsTimer); settingsTimer = undefined;
  if (settingsPending) await flushSettings();
  if (saveTimer != null || savePromise) await flushSave();
}

// ---------- sketch layer (freehand ink) ----------
// Serialised as one JSON data file (SKETCH_FILE) beside the notes — not a node. It rides the same
// store I/O; only the .md walk in the store filters by extension, so this file is invisible to the
// node model. Its own debounce keeps a burst of pen moves from rewriting every note.
function sketchJSON(): string { return JSON.stringify({ version: 1, strokes: state.strokes }); }
export async function loadSketch(): Promise<void> {
  state.strokes = [];
  try {
    const blob = store.readBlob ? await store.readBlob(SKETCH_FILE) : null;
    if (!blob) return;
    const data = JSON.parse(await blob.text());
    if (Array.isArray(data?.strokes)) state.strokes = data.strokes;
  } catch { /* missing or malformed → start with an empty ink layer */ }
}
let sketchTimer: number | undefined;
export function scheduleSaveSketch(): void {
  if (state.readOnly || !store.isOpen) return;   // read-only / demo mode: never write
  clearTimeout(sketchTimer);
  sketchTimer = setTimeout(flushSketch, 400);
}
async function flushSketch(): Promise<void> {
  if (state.readOnly || !store.isOpen) return;
  try {
    await store.write(SKETCH_FILE, sketchJSON());
    state.lastSelfWrite = Date.now();            // so the focus-reload ignores our own write
  } catch (err) {
    console.error('Sketch save failed:', err);
    setStatus('⚠ Sketch save failed: ' + ((err as Error).message || (err as Error).name));
  }
}

// ---------- per-map settings (view prefs that travel with the vault, e.g. the background grid) ----------
function settingsJSON(): string { return JSON.stringify({ version: 1, grid: state.gridStyle, gridSize: state.gridSize }); }
const VALID_GRID_SIZES = [0, 20, 40, 80, 160, 320];
export async function loadSettings(): Promise<void> {
  state.gridStyle = 'none';
  state.gridSize = 20;
  try {
    const blob = store.readBlob ? await store.readBlob(SETTINGS_FILE) : null;
    if (!blob) return;
    const data = JSON.parse(await blob.text());
    if (data?.grid === 'dot' || data?.grid === 'line') state.gridStyle = data.grid;
    if (VALID_GRID_SIZES.includes(data?.gridSize)) state.gridSize = data.gridSize;
  } catch { /* missing or malformed → default to no grid */ }
}
let settingsTimer: number | undefined;
export function scheduleSaveSettings(): void {
  if (state.readOnly || !store.isOpen) return;   // read-only / demo mode: never write
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(flushSettings, 400);
}
async function flushSettings(): Promise<void> {
  if (state.readOnly || !store.isOpen) return;
  try {
    await store.write(SETTINGS_FILE, settingsJSON());
    state.lastSelfWrite = Date.now();            // so the focus-reload ignores our own write
  } catch (err) {
    console.error('Settings save failed:', err);
    setStatus('⚠ Settings save failed: ' + ((err as Error).message || (err as Error).name));
  }
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
  if (savePromise) return;            // a write is mid-flight; don't read torn state
  const selBefore = state.selId;
  // Don't yank the rug out while the user is actively typing in the panel or renaming a card.
  // ui.sheetEdit counts even when no field is focused — on iOS the keyboard can be dismissed
  // while the editor sheet still holds uncommitted text.
  if (editSessionActive() || isTypingInField()) return;
  if (ui.sketchDraw) return;          // mid-stroke: don't reload the ink layer under the pen
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
