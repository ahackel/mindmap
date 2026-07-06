// File System Access API adapter (Chrome/Edge only): a real local folder, with permission
// prompts and IndexedDB-persisted handles for silent resume at boot. File ops delegate to
// the shared handle-store helpers (DRY); only handle acquisition is FSA-specific.
import { idbGet, idbPut } from '../utils/idb.js';
import { listMd, writeFile, removeFile, readFileBlob } from './handle-store.js';
import { rememberFolder, notifyRecentsChanged } from './recents.js';
import { installWatch } from './watch.js';
import type { Store, PickResult } from './types.js';

// The File System Access permission API + window.showDirectoryPicker aren't in lib.dom.
type Permable = {
  queryPermission(d: { mode: string }): Promise<PermissionState>;
  requestPermission(d: { mode: string }): Promise<PermissionState>;
};
const showDirectoryPicker: ((opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>) | undefined =
  (window as any).showDirectoryPicker;

export const fsaStore = {
  _dir: null as FileSystemDirectoryHandle | null,   // FSA directory handle
  _key: null as string | null,                      // the open folder's registry/handle key
  get isOpen(){ return !!this._dir; },
  get name(){ return this._dir ? this._dir.name : ''; },
  get seenKey(){ return this.name; },
  // Which map (registry id) the last pick/openRecent/resume landed on — callers use this
  // as the MapRef id instead of guessing it back out of the registry.
  get currentKey(){ return this._key; },

  // Re-confirm READWRITE. The picker's mode:'readwrite' asks, but the grant can
  // sit in 'prompt' until requested — without it every write silently fails.
  async _ensurePerm(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const opts = { mode: 'readwrite' };
    const h = handle as unknown as Permable;
    if ((await h.queryPermission(opts)) === 'granted') return true;
    if ((await h.requestPermission(opts)) === 'granted') return true;
    return false;
  },

  // Pick a NEW source (needs a user gesture — the toolbar / start-screen click).
  async pick(): Promise<PickResult> {
    if (!showDirectoryPicker) return 'unsupported';
    let handle: FileSystemDirectoryHandle;
    try { handle = await showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e){ return (e as DOMException).name === 'AbortError' ? 'cancel' : 'error'; }
    if (!(await this._ensurePerm(handle))) return 'denied';
    this._dir = handle;
    await this._remember(handle);
    return 'ok';
  },

  // Reopen a REMEMBERED source by its recents key (the click is the gesture).
  async openRecent(key?: string): Promise<PickResult> {
    if (!key) return 'gone';
    let handle: FileSystemDirectoryHandle | undefined;
    try { handle = await idbGet(key); } catch {}
    if (!handle) return 'gone';
    if (!(await this._ensurePerm(handle))) return 'denied';
    this._dir = handle;
    await this._remember(handle);
    return 'ok';
  },

  // Silent reopen at boot — only succeeds if permission is ALREADY granted (no prompt/gesture).
  async resume(key: string): Promise<boolean> {
    let handle: FileSystemDirectoryHandle | undefined;
    try { handle = await idbGet(key); } catch {}
    if (!handle) return false;
    try { if ((await (handle as unknown as Permable).queryPermission({ mode:'readwrite' })) !== 'granted') return false; } catch { return false; }
    this._dir = handle; this._key = key; return true;
  },

  list(){ return listMd(this._dir!); },
  write(path: string, data: string | Blob){ return writeFile(this._dir!, path, data); },
  remove(path: string){ return removeFile(this._dir!, path); },
  readBlob(path: string){ return readFileBlob(this._dir!, path); },

  // Fire cb when the source may have changed underneath us (window-focus / tab-visible).
  // An Obsidian/Tauri build would register a real file watcher here instead.
  watch(cb: () => void){ installWatch(cb); },

  // ---- recent sources: handles in IndexedDB, folder-kind MapRefs in the unified registry ----
  async _remember(handle: FileSystemDirectoryHandle){
    const key = 'dir:' + handle.name + ':' + Date.now();
    await idbPut(key, handle);                 // store the actual handle
    rememberFolder(key, handle.name);          // registry entry (de-dupes by folder name)
    this._key = key;
    notifyRecentsChanged();                    // main re-renders the recents UI
  },
};
fsaStore satisfies Store;   // compile-time contract check (extra _dir/_ensurePerm/_remember allowed on a reference)
