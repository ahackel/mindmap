// ============================================================
// Boot + home/storage screen. boot() opens straight into the last map (local-first, no
// gate): resume a granted FSA folder if one was last used, else the on-device vault.
// The home screen (🧠) manages where the map lives — open a folder, recents, import/export.
// ============================================================
import { state, setStatus } from './core/state.js';
import { applyView } from './view/camera.js';
import { store, useStore, loadFromDir, exportZip, openImportPicker, LAST_STORE_KEY } from './data/persistence.js';
import { opfsStore, fsaStore, resolveOnDeviceStore, readRecents, forgetRecent, setOnRecentsChanged, type Store } from './store/index.js';
import { applyReadOnly } from './main.js';
import folderIcon from './assets/icons/folder-open.svg?raw';

// Chrome/Edge offer opening a real local folder (FSA); iPad/Firefox/Safari use on-device +
// import/export. ?nofsa hides the folder option for testing the no-FSA layout on desktop.
const HAS_FSA = !location.search.includes('nofsa') && !!(window as any).showDirectoryPicker;

// ---- on-device (the local-first default) ----
async function openDevice({ keepView = false }: { keepView?: boolean } = {}): Promise<void> {
  const s = await resolveOnDeviceStore();
  useStore(s, 'opfs');
  await s.pick();
  hideStart();
  await loadFromDir({ keepView });
}

// ---- local folder (Chrome/Edge only) ----
async function openFolder(): Promise<void> {
  const r = await fsaStore.pick();
  if (r === 'unsupported') { setStatus('This browser can’t open a local folder — use Chrome or Edge.'); return; }
  if (r === 'denied') { setStatus('Folder permission denied.'); alert('Write permission was denied.\nReopen the folder and choose “Edit”/“Allow”.'); return; }
  if (r !== 'ok') { if (r === 'error') setStatus('Could not open folder.'); return; }
  useStore(fsaStore, 'folder');
  hideStart();
  await loadFromDir();
}
async function openRecentFolder(key: string): Promise<void> {
  const r = await fsaStore.openRecent(key);
  if (r === 'gone') {
    await forgetRecent(key);
    renderRecents();
    const msg = document.getElementById('storeStatus');
    if (msg) msg.textContent = 'That folder is no longer available — removed from recents.';
    return;
  }
  if (r === 'denied') { alert('Write permission was denied for this folder.'); return; }
  useStore(fsaStore, 'folder');
  hideStart();
  await loadFromDir();
}

function timeAgo(ts: number): string {
  const s = (Date.now()-ts)/1000;
  if (s<60) return 'just now';
  if (s<3600) return Math.floor(s/60)+'m ago';
  if (s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
function renderRecents(): void {
  const list = readRecents();
  const wrap = document.getElementById('recentWrap') as HTMLElement;
  const box = document.getElementById('recentList') as HTMLElement;
  if (!list.length){ wrap.style.display='none'; return; }
  wrap.style.display='block';
  box.innerHTML = list.map(r =>
    `<button class="recent-item" data-key="${r.key}">
       ${folderIcon.replace('btn-icon', 'ri-icon')}
       <span class="ri-name">${r.name}</span>
       <span class="ri-when">${timeAgo(r.when)}</span></button>`).join('');
  box.querySelectorAll<HTMLElement>('.recent-item').forEach(btn => {
    btn.onclick = () => openRecentFolder(btn.dataset.key!);
  });
}

// ---------- home screen (storage settings; the map itself opens onto the canvas) ----------
const startScreen = document.getElementById('startScreen') as HTMLElement;
export function showStart(): void { renderStoreScreen(); startScreen.classList.remove('hidden'); }
export function hideStart(): void { startScreen.classList.add('hidden'); }

function renderStoreScreen(): void {
  document.getElementById('storeStatus')!.textContent =
    store.isOpen ? 'Editing: ' + store.name : 'Loading…';
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  (document.getElementById('startOpen') as HTMLElement).style.display = (HAS_FSA && !isTouch) ? '' : 'none';
  (document.getElementById('useDeviceBtn') as HTMLElement).style.display = (store === opfsStore) ? 'none' : '';
  renderRecents();
}

(document.getElementById('startOpen') as HTMLElement).onclick   = () => openFolder();
(document.getElementById('useDeviceBtn') as HTMLElement).onclick = () => openDevice();
(document.getElementById('importBtn') as HTMLElement).onclick   = () => openImportPicker();
(document.getElementById('exportBtn') as HTMLElement).onclick   = () => exportZip();   // async; fire-and-forget
(document.getElementById('startClose') as HTMLElement).onclick  = () => hideStart();
setOnRecentsChanged(renderRecents);   // let the store signal recents changes without rendering UI itself

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
  async pick(){ return 'ok'; },
  async openRecent(){ return 'ok'; },
  async list(){
    return Object.entries(helpNotes).map(([path, text]) => ({ path, text }));
  },
  async write(){}, async remove(){},
  async readBlob(){ return null; },   // help notes reference no local images
  watch(){}, recents(){ return []; },
};
export function openHelpTab(): void {
  const url = location.pathname + '?help';
  if (!window.open(url, '_blank')) location.href = url;   // fall back if a new tab is blocked
}
async function openHelp(): Promise<void> {
  state.readOnly = true; applyReadOnly();                 // help is view-only; nothing is saved
  useStore(helpStore);                                    // no `kind` → doesn't change the saved store
  try { await loadFromDir(); }
  catch { setStatus('Help content (help/) not found next to index.html.'); }
}

// ---------- boot: local-first — open straight into the last map, no gate ----------
export async function boot(): Promise<void> {
  applyView();
  hideStart();
  if (new URLSearchParams(location.search).has('help')){ await openHelp(); return; }
  // resume a local folder only if we can do it silently (permission still granted); else on-device
  if (HAS_FSA && localStorage.getItem(LAST_STORE_KEY) === 'folder'){
    const recent = readRecents()[0];
    if (recent && fsaStore.resume && await fsaStore.resume(recent.key)){
      useStore(fsaStore, 'folder');
      await loadFromDir();
      return;
    }
  }
  await openDevice();   // the on-device vault (empty on first run)
}
