// ============================================================
// Boot + home/storage screen. boot() opens straight into the last map (local-first, no
// gate): resume a granted FSA folder if one was last used, else the on-device vault.
// The home screen (🧠) manages where the map lives — open a folder, recents, import/export.
// ============================================================
import { state, setStatus } from './core/state.js';
import { applyView } from './view/camera.js';
import { store, useStore, loadFromDir, exportZip, openImportPicker, LAST_STORE_KEY } from './data/persistence.js';
import { fsaStore, resolveOnDeviceStore, readRecents, forgetRecent, setOnRecentsChanged, type Store } from './store/index.js';
import { applyReadOnly } from './main.js';
import folderIcon from './assets/icons/folder-open.svg?raw';

// Chrome/Edge offer opening a real local folder (FSA); iPad/Firefox/Safari use on-device +
// import/export. ?nofsa hides the folder option for testing the no-FSA layout on desktop.
const HAS_FSA = !location.search.includes('nofsa') && !!(window as any).showDirectoryPicker;

// The panel only *selects* a storage target; the actual load happens when the user closes it
// (commitAndClose). `pending` is what to load on close (null = no change); `selectedRecent` is
// the highlighted recent folder; `currentFolderKey` is the recent currently loaded (for the
// initial highlight when reopening the panel on a folder).
type Pending = null | { kind: 'device' } | { kind: 'recent'; key: string } | { kind: 'picked' };
let pending: Pending = null;
let selectedRecent: string | null = null;
let currentFolderKey: string | null = null;

// ---- on-device (the local-first default) ----
async function commitDevice({ keepView = false }: { keepView?: boolean } = {}): Promise<void> {
  const s = await resolveOnDeviceStore();
  useStore(s, 'opfs');
  await s.pick();
  await loadFromDir({ keepView });
}

// ---- local folder (Chrome/Edge only): pick/select here, load on close ----
async function pickFolder(): Promise<void> {
  const r = await fsaStore.pick();   // the picker needs this click as its user gesture
  if (r === 'unsupported') { setStatus('This browser can’t open a local folder — use Chrome or Edge.'); return; }
  if (r === 'denied') { setStatus('Folder permission denied.'); alert('Write permission was denied.\nReopen the folder and choose “Edit”/“Allow”.'); return; }
  if (r !== 'ok') { if (r === 'error') setStatus('Could not open folder.'); return; }
  pending = { kind: 'picked' };                     // fsaStore now holds the picked folder; load on close
  selectedRecent = readRecents()[0]?.key ?? null;   // _remember put it at the top
  renderRecents(); equalizePanels();
}
function selectRecent(key: string): void {          // just highlight + remember the choice
  pending = { kind: 'recent', key };
  selectedRecent = key;
  renderRecents();
}
async function commitRecent(key: string): Promise<boolean> {
  const r = await fsaStore.openRecent(key);         // the close click is the gesture for the permission prompt
  if (r === 'gone') {
    await forgetRecent(key);
    selectedRecent = null;
    renderRecents(); equalizePanels();
    setStatus('That folder is no longer available — removed from recents.');
    return false;
  }
  if (r === 'denied') { alert('Write permission was denied for this folder.'); return false; }
  useStore(fsaStore, 'folder');
  currentFolderKey = readRecents()[0]?.key ?? key;  // openRecent re-remembers with a fresh key
  await loadFromDir();
  return true;
}

// Apply the pending selection, then close — the map loads only now, on exit.
async function commitAndClose(): Promise<void> {
  const p = pending; pending = null;
  if (p?.kind === 'device') {
    if (store === fsaStore) await commitDevice();   // no-op if already on-device
  } else if (p?.kind === 'recent') {
    const alreadyLoaded = store === fsaStore && p.key === currentFolderKey;
    if (!alreadyLoaded && !(await commitRecent(p.key))) return;   // stay open on commit failure
  } else if (p?.kind === 'picked') {
    useStore(fsaStore, 'folder');
    currentFolderKey = selectedRecent;
    await loadFromDir();
  }
  hideStart();
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
    `<button class="recent-item${r.key === selectedRecent ? ' selected' : ''}" data-key="${r.key}">
       ${folderIcon.replace('btn-icon', 'ri-icon')}
       <span class="ri-name">${r.name}</span>
       <span class="ri-when">${timeAgo(r.when)}</span>
       <span class="ri-check" aria-hidden="true">✓</span></button>`).join('');
  box.querySelectorAll<HTMLElement>('.recent-item').forEach(btn => {
    btn.onclick = () => selectRecent(btn.dataset.key!);
  });
}

// ---------- home screen (storage settings; the map itself opens onto the canvas) ----------
const startScreen = document.getElementById('startScreen') as HTMLElement;
export function showStart(): void { startScreen.classList.remove('hidden'); renderStoreScreen(); }   // unhide first so equalizePanels can measure
export function hideStart(): void { startScreen.classList.add('hidden'); }

// The active tab reflects where the map currently lives; the folder tab is disabled (greyed,
// non-clickable) when the browser lacks the File System Access API. Selecting "On device"
// switches back to the on-device vault; "Local folder" reveals the open/recents controls
// (the actual switch happens when a folder is picked, which needs a permission prompt).
type StoreTab = 'device' | 'folder';
function activeTab(): StoreTab { return store === fsaStore ? 'folder' : 'device'; }
function selectTab(tab: StoreTab): void {
  const dev = tab === 'device';
  document.getElementById('tabDevice')!.classList.toggle('active', dev);
  document.getElementById('tabFolder')!.classList.toggle('active', !dev);
  (document.getElementById('panelDevice') as HTMLElement).style.display = dev ? '' : 'none';
  (document.getElementById('panelFolder') as HTMLElement).style.display = dev ? 'none' : '';
}

// Both panels get the height of the taller one, so the card doesn't resize (and never scrolls)
// when switching tabs — no matter how many recent folders are listed.
function equalizePanels(): void {
  const pd = document.getElementById('panelDevice') as HTMLElement;
  const pf = document.getElementById('panelFolder') as HTMLElement;
  pd.style.minHeight = pf.style.minHeight = '';
  const prevD = pd.style.display, prevF = pf.style.display;
  pd.style.display = pf.style.display = '';               // measure both, ignoring the active-tab hide
  const h = Math.max(pd.offsetHeight, pf.offsetHeight);
  pd.style.display = prevD; pf.style.display = prevF;
  pd.style.minHeight = pf.style.minHeight = h + 'px';
}

function renderStoreScreen(): void {
  document.getElementById('storeStatus')!.textContent =
    store.isOpen ? 'Editing: ' + store.name : 'Loading…';
  (document.getElementById('tabFolder') as HTMLButtonElement).disabled = !HAS_FSA;
  pending = null;                                                    // reopening the panel starts clean
  selectedRecent = store === fsaStore ? currentFolderKey : null;     // highlight the folder currently loaded
  renderRecents();
  selectTab(activeTab());
  equalizePanels();
}

document.getElementById('tabDevice')!.onclick = () => { selectTab('device'); selectedRecent = null; renderRecents(); pending = { kind: 'device' }; };
(document.getElementById('tabFolder') as HTMLButtonElement).onclick = () => { selectTab('folder'); };
(document.getElementById('startOpen') as HTMLElement).onclick   = () => pickFolder();
(document.getElementById('importBtn') as HTMLElement).onclick   = () => openImportPicker();
(document.getElementById('exportBtn') as HTMLElement).onclick   = () => exportZip();   // async; fire-and-forget
(document.getElementById('startClose') as HTMLElement).onclick  = () => commitAndClose();
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
      currentFolderKey = recent.key;
      await loadFromDir();
      return;
    }
  }
  await commitDevice();   // the on-device vault (empty on first run)
}
