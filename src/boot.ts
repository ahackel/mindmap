// ============================================================
// Boot + home screen. boot() opens straight into the last map (local-first, no gate):
// resume a granted FSA folder if one was last open, else the last on-device map.
// The home screen (🧠) is ONE unified list of maps — on-device maps and local folders look
// and behave the same: click a row to open it (the click doubles as the FSA permission
// gesture), with per-row rename / export / delete actions.
// ============================================================
import { state, setStatus } from './core/state.js';
import { applyView } from './view/camera.js';
import { store, currentMap, useStore, loadFromDir, exportZip, settleSave, switchToDeviceMap, updateMapTitle, openImportPicker } from './data/persistence.js';
import {
  fsaStore, resolveOnDeviceStore, forgetRecent, setOnRecentsChanged,
  readMaps, getLastMap, ensureMapRegistry, createDeviceMap, deleteDeviceMap, renameDeviceMap,
  type Store, type MapRef, type MapKind,
} from './store/index.js';
import { esc } from './utils/markdown.js';
import { applyReadOnly } from './main.js';
import { openMenu } from './features/context-menu.js';
import folderIcon from './assets/icons/folder-open.svg?raw';

// Chrome/Edge offer opening a real local folder (FSA); iPad/Firefox/Safari use on-device +
// import/export. ?nofsa hides the folder option for testing the no-FSA layout on desktop.
const HAS_FSA = !location.search.includes('nofsa') && !!(window as any).showDirectoryPicker;

// ---- opening maps (each path ends on the canvas with the panel closed) ----
async function openDeviceMap(ref: MapRef): Promise<void> {
  await switchToDeviceMap(ref);
  await loadFromDir();
}
// Reopen a remembered FSA folder (the row click is the gesture for the permission prompt).
async function openFolderMap(key: string): Promise<boolean> {
  await settleSave();   // the old map's pending writes must not land in the folder
  const r = await fsaStore.openRecent(key);
  if (r === 'gone') {
    await forgetRecent(key);
    renderMapList();
    setStatus('That folder is no longer available — removed from the list.');
    return false;
  }
  if (r === 'denied') { alert('Write permission was denied for this folder.'); return false; }
  if (r !== 'ok') return false;
  useStore(fsaStore, { kind: 'folder', id: fsaStore.currentKey! });   // openRecent re-remembers under a fresh key
  await loadFromDir();
  return true;
}
// Pick a NEW local folder (Chrome/Edge only) and open it right away.
async function pickFolder(): Promise<void> {
  await settleSave();   // the old map's pending writes must not land in the picked folder
  const r = await fsaStore.pick();   // the picker needs this click as its user gesture
  if (r === 'unsupported') { setStatus('This browser can’t open a local folder — use Chrome or Edge.'); return; }
  if (r === 'denied') { setStatus('Folder permission denied.'); alert('Write permission was denied.\nReopen the folder and choose “Edit”/“Allow”.'); return; }
  if (r !== 'ok') { if (r === 'error') setStatus('Could not open folder.'); return; }
  useStore(fsaStore, { kind: 'folder', id: fsaStore.currentKey! });
  await loadFromDir();
  hideStart();
}

// ---------- the map list ----------
function timeAgo(ts: number): string {
  if (!ts) return '';                       // migrated entries carry no last-opened time yet
  const s = (Date.now()-ts)/1000;
  if (s<60) return 'just now';
  if (s<3600) return Math.floor(s/60)+'m ago';
  if (s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
// the map currently open on the canvas — runtime state, not the persisted last-map key
// (another tab may rewrite that one)
function isCurrent(m: MapRef): boolean {
  return !!currentMap && currentMap.id === m.id && currentMap.kind === m.kind && store.isOpen;
}

let renaming: string | null = null;   // map id whose row shows the inline rename input
let activeTab: MapKind = 'device';    // which backend's maps the sidebar shows

function selectTab(tab: MapKind): void {
  activeTab = tab;
  const dev = tab === 'device';
  document.getElementById('tabDevice')!.classList.toggle('active', dev);
  document.getElementById('tabFolder')!.classList.toggle('active', !dev);
  // the "+" action creates where the active tab points
  document.getElementById('newBtnLabel')!.textContent = dev ? 'New map' : 'Open folder…';
  renaming = null;
  renderMapList();
}

function renderMapList(): void {
  const list = readMaps().filter(m => m.kind === activeTab);
  const box = document.getElementById('mapList') as HTMLElement;
  if (!list.length){
    box.innerHTML = `<p class="side-empty">${activeTab === 'device' ? 'No maps yet.' : 'No recent folders yet.'}</p>`;
    return;
  }
  box.innerHTML = list.map(m => {
    const name = renaming === m.id
      ? `<input class="mi-name-input" value="${esc(m.name)}" aria-label="Map name">`
      : `<span class="mi-name">${esc(m.name)}</span><span class="mi-when">${timeAgo(m.when)}</span>
         <button class="mi-more" aria-label="Map actions" title="Map actions">⋮</button>`;
    return `<div class="map-item${isCurrent(m) ? ' current' : ''}" data-id="${esc(m.id)}" tabindex="0" role="button" aria-label="Open ${esc(m.name)}">
      <span class="mi-icon">${folderIcon.replace('btn-icon', '')}</span>${name}</div>`;
  }).join('');

  box.querySelectorAll<HTMLElement>('.map-item').forEach((row, i) => {
    const m = list[i]!;   // rows are rendered in list order
    row.onclick = e => {
      if ((e.target as HTMLElement).closest('.mi-more, .mi-name-input')) return;
      openRow(m);
    };
    row.onkeydown = e => { if (e.key === 'Enter' && e.target === row) openRow(m); };
    // map actions live in a context menu: the ⋮ button (tap-friendly) or a desktop right-click
    const more = row.querySelector<HTMLButtonElement>('.mi-more');
    if (more) more.onclick = e => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      openMapMenu(m, r.left, r.bottom + 4);
    };
    row.oncontextmenu = e => {
      e.preventDefault(); e.stopPropagation();   // keep the canvas ctx-menu handler out of it
      openMapMenu(m, e.clientX, e.clientY);
    };
    const inp = row.querySelector<HTMLInputElement>('.mi-name-input');
    if (inp) {
      inp.focus(); inp.select();
      inp.onkeydown = e => {
        if (e.key === 'Enter') inp.blur();
        else if (e.key === 'Escape') { renaming = null; renderMapList(); }
      };
      inp.onblur = () => {
        if (renaming !== m.id) return;   // Escape already cancelled (re-render detached us)
        renaming = null;
        commitRename(m, inp.value);
      };
    }
  });
}

function openMapMenu(m: MapRef, x: number, y: number): void {
  const cur = isCurrent(m);
  openMenu([
    ...(m.kind === 'device' ? [{ label: 'Rename', run: () => { renaming = m.id; renderMapList(); } }] : []),
    // export packs what's loaded on the canvas, so it exists only for the open map
    { label: 'Export .zip', run: () => { exportZip(); }, disabled: !cur },
    'sep',
    m.kind === 'device'
      ? { label: 'Delete…', run: () => { void deleteMap(m); }, danger: true }
      : { label: 'Remove from list', run: () => { void removeFolder(m); }, danger: true },
  ], x, y);
}

async function openRow(m: MapRef): Promise<void> {
  if (isCurrent(m)) { hideStart(); return; }          // already on the canvas
  if (m.kind === 'device') { await openDeviceMap(m); hideStart(); }
  else if (await openFolderMap(m.id)) hideStart();
}

async function commitRename(m: MapRef, name: string): Promise<void> {
  await renameDeviceMap(await resolveOnDeviceStore(), m.id, name);
  if (isCurrent(m)) updateMapTitle();   // the open map's name shows in the toolbar + tab title
  renderMapList();
}

async function removeFolder(m: MapRef): Promise<void> {
  if (!confirm(`Remove “${m.name}” from this list?\nThe folder and its files stay on disk.`)) return;
  await forgetRecent(m.id);
  renderMapList();
}
async function deleteMap(m: MapRef): Promise<void> {
  if (!confirm(`Delete “${m.name}” and all its notes from this device?\nThis cannot be undone.`)) return;
  const wasCurrent = isCurrent(m);
  if (wasCurrent) await settleSave();   // settle any pending autosave before the dir vanishes
  await deleteDeviceMap(await resolveOnDeviceStore(), m.id);
  if (wasCurrent) await commitDevice();   // fall back to the next map (or a fresh one)
  renderMapList();
}

// ---------- home sidebar ----------
const startScreen = document.getElementById('startScreen') as HTMLElement;
export function showStart(): void {
  renaming = null;
  (document.getElementById('tabFolder') as HTMLButtonElement).disabled = !HAS_FSA;
  // open on the tab of the map currently on the canvas
  selectTab(HAS_FSA && currentMap?.kind === 'folder' ? 'folder' : 'device');
  startScreen.classList.remove('hidden');
}
export function hideStart(): void { startScreen.classList.add('hidden'); }

document.getElementById('tabDevice')!.onclick = () => selectTab('device');
document.getElementById('tabFolder')!.onclick = () => selectTab('folder');
// the "+" action: a new on-device map, or the FSA folder picker — per the active tab
document.getElementById('newBtn')!.onclick = async () => {
  if (activeTab === 'device'){
    const ref = await createDeviceMap(await resolveOnDeviceStore());
    await openDeviceMap(ref);
    hideStart();
  } else {
    await pickFolder();
  }
};
(document.getElementById('importBtn') as HTMLElement).onclick = () => openImportPicker();
(document.getElementById('startClose') as HTMLElement).onclick = () => hideStart();
// clicking the canvas area beside the sidebar closes it
startScreen.addEventListener('click', e => { if (e.target === startScreen) hideStart(); });
setOnRecentsChanged(renderMapList);   // let the store signal registry changes without rendering UI itself

// ---------- help mindmap (help/*.md, opened with F1) ----------
// Read-only store serving the help notes; lives in its own tab (?help), so the user's own map
// and vault are never touched. The notes are embedded in the bundle at build time (via glob)
// rather than fetched: `fetch()` is blocked under the file:// protocol, so a fetch-based help
// store silently failed when the single-file build was opened directly from disk.
const helpModules = import.meta.glob('../public/help/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
// Key off the bare filename ('Storage.md'), matching the old fetch paths / manifest entries.
const helpNotes: Record<string, string> = Object.fromEntries(
  Object.entries(helpModules).map(([path, text]) => [path.split('/').pop()!, text]),
);
const helpStore: Store = {
  get isOpen(){ return true; },
  get name(){ return 'Help'; },
  get seenKey(){ return 'help'; },
  async pick(){ return 'ok'; },
  async openRecent(){ return 'ok'; },
  async list(){
    return Object.entries(helpNotes).map(([path, text]) => ({ path, text }));
  },
  async write(){}, async remove(){},
  async readBlob(){ return null; },   // help notes reference no local images
  watch(){},
};
export function openHelpTab(): void {
  const url = location.pathname + '?help';
  if (!window.open(url, '_blank')) location.href = url;   // fall back if a new tab is blocked
}
async function openHelp(): Promise<void> {
  state.readOnly = true; applyReadOnly();                 // help is view-only; nothing is saved
  useStore(helpStore);                                    // no ref → doesn't change the last-map bookkeeping
  try { await loadFromDir(); }
  catch { setStatus('Help content (help/) not found next to index.html.'); }
}

// ---------- boot: local-first — open straight into the last map, no gate ----------
// Open the last-used on-device map; else the most recent one; else create a fresh "My map".
async function commitDevice(): Promise<void> {
  const s = await resolveOnDeviceStore();
  const device = readMaps().filter(m => m.kind === 'device');
  const last = getLastMap();
  const ref = (last?.kind === 'device' && device.find(m => m.id === last.id))
    || device[0]
    || await createDeviceMap(s, 'My map');
  await openDeviceMap(ref);
}

export async function boot(): Promise<void> {
  applyView();
  hideStart();
  if (new URLSearchParams(location.search).has('help')){ await openHelp(); return; }
  // one-time legacy migration / rebuild — the store probe is skipped once the registry exists
  if (!readMaps().length) await ensureMapRegistry(await resolveOnDeviceStore());
  // resume a local folder only if we can do it silently (permission still granted); else on-device
  const last = getLastMap();
  if (HAS_FSA && last?.kind === 'folder'){
    if (fsaStore.resume && await fsaStore.resume(last.id)){
      useStore(fsaStore, { kind: 'folder', id: last.id });
      await loadFromDir();
      return;
    }
  }
  await commitDevice();   // the last / most recent on-device map (fresh "My map" on first run)
}
