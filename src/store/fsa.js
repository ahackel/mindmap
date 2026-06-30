// File System Access API adapter (Chrome/Edge only): a real local folder, with permission
// prompts and IndexedDB-persisted handles for silent resume at boot. File ops delegate to
// the shared handle-store helpers (DRY); only handle acquisition is FSA-specific.
import { idbGet, idbPut } from '../utils/idb.js';
import { listMd, writeFile, removeFile, readFileBlob } from './handle-store.js';
import { readRecents, writeRecents, notifyRecentsChanged } from './recents.js';
import { installWatch } from './watch.js';

export const fsaStore = {
  _dir: null,                                  // FileSystemDirectoryHandle (FSA-specific)
  get isOpen(){ return !!this._dir; },
  get name(){ return this._dir ? this._dir.name : ''; },

  // Re-confirm READWRITE. The picker's mode:'readwrite' asks, but the grant can
  // sit in 'prompt' until requested — without it every write silently fails.
  async _ensurePerm(handle){
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  },

  // Pick a NEW source (needs a user gesture — the toolbar / start-screen click).
  // Returns: 'ok' | 'cancel' | 'denied' | 'unsupported' | 'error'.
  async pick(){
    if (!window.showDirectoryPicker) return 'unsupported';
    let handle;
    try { handle = await window.showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e){ return e.name === 'AbortError' ? 'cancel' : 'error'; }
    if (!(await this._ensurePerm(handle))) return 'denied';
    this._dir = handle;
    await this._remember(handle);
    return 'ok';
  },

  // Reopen a REMEMBERED source by its recents key (the click is the gesture).
  // Returns: 'ok' | 'gone' | 'denied'.
  async openRecent(key){
    let handle;
    try { handle = await idbGet(key); } catch {}
    if (!handle) return 'gone';
    if (!(await this._ensurePerm(handle))) return 'denied';
    this._dir = handle;
    await this._remember(handle);
    return 'ok';
  },

  // Silent reopen at boot — only succeeds if permission is ALREADY granted (no prompt/gesture).
  async resume(key){
    let handle; try { handle = await idbGet(key); } catch {}
    if (!handle) return false;
    try { if ((await handle.queryPermission({ mode:'readwrite' })) !== 'granted') return false; } catch { return false; }
    this._dir = handle; return true;
  },

  list(){ return listMd(this._dir); },
  write(path, text){ return writeFile(this._dir, path, text); },
  remove(path){ return removeFile(this._dir, path); },
  readBlob(path){ return readFileBlob(this._dir, path); },

  // Fire cb when the source may have changed underneath us (window-focus / tab-visible).
  // An Obsidian/Tauri build would register a real file watcher here instead.
  watch(cb){ installWatch(cb); },

  // ---- recent sources: handles in IndexedDB, a tiny display list in localStorage ----
  recents(){ return readRecents(); },
  async _remember(handle){
    const key = 'dir:' + handle.name + ':' + Date.now();
    await idbPut(key, handle);                                       // store the actual handle
    const list = readRecents().filter(r => r.name !== handle.name);  // de-dupe by name
    list.unshift({ key, name: handle.name, when: Date.now() });
    writeRecents(list);                                              // keep newest 5
    notifyRecentsChanged();                                          // main re-renders the recents UI
  },
};
