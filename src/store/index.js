// ============================================================
// The store adapter — the single swappable I/O boundary. All disk access (pick,
// openRecent, list, write, remove, readBlob, watch, recents, resume) goes through one
// of these two objects, which share the same handle-based interface:
//   opfsStore — local-first default (Origin Private File System), works on every
//               browser incl. iPad; no picker/permission/watcher.
//   fsaStore  — File System Access API (Chrome/Edge): a real local folder, with
//               permission prompts and IndexedDB-persisted handles for silent resume.
// Retargeting the app (Obsidian vault, Tauri, …) means replacing only this module.
// Also here: the "recent folders" backing store (handles in IndexedDB, display list in
// localStorage) and the one-time "seen folders" set.
// ============================================================
import { idbGet, idbPut, idbDel } from '../utils/idb.js';

// ============================================================
//  Recent folders backing store: handles live in IndexedDB (not serializable
//  to JSON), a small display list lives in localStorage. Used by `store` above.
// ============================================================
const RECENT_KEY = 'mindmap.recentFolders';   // [{key, name, when}]  (localStorage)
export function readRecents() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
export function writeRecents(list) { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5))); }
// Drop a recent folder by its key (display list + its stored handle) when it can no longer be opened.
export async function forgetRecent(key){
  writeRecents(readRecents().filter(r => r.key !== key));
  try { await idbDel(key); } catch {}
}

// Folders we've already auto-arranged once. Used so the one-time auto-collapse never
// fires again — every later open restores the saved frontmatter state verbatim.
const SEEN_KEY = 'mindmap.seenFolders';
export function seenFolders(){
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch { return []; }
}
export function markFolderSeen(name){
  const s = seenFolders();
  if (!s.includes(name)) { s.push(name); localStorage.setItem(SEEN_KEY, JSON.stringify(s)); }
}

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

  // Every .md in the source as { path, text } (path relative, '/'-separated).
  async list(){
    const out = [];
    const walk = async (handle, prefix) => {
      for await (const [name, h] of handle.entries()){
        if (h.kind === 'directory'){ await walk(h, prefix + name + '/'); continue; }
        if (!name.endsWith('.md')) continue;
        out.push({ path: prefix + name, text: await (await h.getFile()).text() });
      }
    };
    await walk(this._dir, '');
    return out;
  },

  // Create/overwrite a note at a relative path (intermediate dirs created).
  async write(path, text){
    let d = this._dir;
    const parts = path.split('/');
    for (let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i], { create:true });
    const h = await d.getFileHandle(parts[parts.length-1], { create:true });
    const w = await h.createWritable(); await w.write(text); await w.close();
  },

  // Delete a note (a missing file is fine).
  async remove(path){
    try {
      const parts = path.split('/'); let d = this._dir;
      for (let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i]);
      await d.removeEntry(parts[parts.length-1]);
    } catch { /* already gone — fine */ }
  },

  // Read a binary file (e.g. an image attachment) as a Blob, or null if it's gone.
  async readBlob(path){
    try {
      const parts = path.split('/'); let d = this._dir;
      for (let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i]);
      return await (await d.getFileHandle(parts[parts.length-1])).getFile();
    } catch { return null; }
  },

  // Fire cb when the source may have changed underneath us. FSA can't truly
  // watch, so window-focus / tab-visible stand in for "might have changed"
  // (an Obsidian/Tauri build would register a real file watcher here instead).
  watch(cb){ installWatch(cb); },

  // ---- recent sources: handles in IndexedDB, a tiny display list in localStorage ----
  recents(){ return readRecents(); },
  async _remember(handle){
    const key = 'dir:' + handle.name + ':' + Date.now();
    await idbPut(key, handle);                                       // store the actual handle
    const list = readRecents().filter(r => r.name !== handle.name);  // de-dupe by name
    list.unshift({ key, name: handle.name, when: Date.now() });
    writeRecents(list);                                              // keep newest 5
    renderRecents();
  },
};

// OPFS backend — the LOCAL-FIRST default. The Origin Private File System is a private,
// per-origin store every modern browser (incl. iPad Safari) supports; its handle API matches
// fsaStore, so list/write/remove are identical. No picker, no permission, no external watcher.
export const opfsStore = {
  _dir: null, _opened: false,
  get isOpen(){ return this._opened; },
  get name(){ return 'On-device storage'; },
  async _root(){
    if (this._dir) return this._dir;
    const root = await navigator.storage.getDirectory();
    this._dir = await root.getDirectoryHandle('vault', { create:true });
    return this._dir;
  },
  async pick(){ try { await this._root(); this._opened = true; return 'ok'; } catch { return 'error'; } },
  async openRecent(){ return this.pick(); },
  async list(){
    const out = [];
    const walk = async (handle, prefix) => {
      for await (const [name, h] of handle.entries()){
        if (h.kind === 'directory'){ await walk(h, prefix + name + '/'); continue; }
        if (!name.endsWith('.md')) continue;
        out.push({ path: prefix + name, text: await (await h.getFile()).text() });
      }
    };
    await walk(await this._root(), '');
    return out;
  },
  async write(path, text){
    let d = await this._root();
    const parts = path.split('/');
    for (let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i], { create:true });
    const h = await d.getFileHandle(parts[parts.length-1], { create:true });
    const w = await h.createWritable(); await w.write(text); await w.close();
  },
  async remove(path){
    try {
      const parts = path.split('/'); let d = await this._root();
      for (let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i]);
      await d.removeEntry(parts[parts.length-1]);
    } catch { /* already gone — fine */ }
  },
  async readBlob(path){
    try {
      const parts = path.split('/'); let d = await this._root();
      for (let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i]);
      return await (await d.getFileHandle(parts[parts.length-1])).getFile();
    } catch { return null; }
  },
  watch(){ /* OPFS can't change underneath us */ },
  recents(){ return []; },
};

// OPFS write requires FileSystemWritableFileStream (createWritable), which Safari added in 17.2.
// On iOS ≤16 we fall back to an IndexedDB store with the same interface.
async function opfsCanWrite(){
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('__writetest__', { create: true });
    const w = await fh.createWritable();
    await w.close();
    await root.removeEntry('__writetest__');
    return true;
  } catch { return false; }
}

// IndexedDB fallback store — identical interface to opfsStore, used on Safari < 17.2.
const idbStore = (() => {
  let _db = null, _opened = false;
  async function db(){
    if (_db) return _db;
    return new Promise((res, rej) => {
      const r = indexedDB.open('mindmap-vault', 1);
      r.onupgradeneeded = e => e.target.result.createObjectStore('files');
      r.onsuccess = e => { _db = e.target.result; res(_db); };
      r.onerror = e => rej(e.target.error);
    });
  }
  return {
    get isOpen(){ return _opened; },
    get name(){ return 'On-device storage'; },
    async pick(){ try { await db(); _opened = true; return 'ok'; } catch { return 'error'; } },
    async openRecent(){ return this.pick(); },
    async list(){
      const d = await db();
      return new Promise((res, rej) => {
        const tx = d.transaction('files','readonly'), out = [];
        tx.objectStore('files').openCursor().onsuccess = e => {
          const c = e.target.result;
          if (c){ if (c.key.endsWith('.md')) out.push({ path: c.key, text: c.value }); c.continue(); }
          else res(out);
        };
        tx.onerror = e => rej(e.target.error);
      });
    },
    async write(path, text){
      const d = await db();
      return new Promise((res, rej) => {
        const tx = d.transaction('files','readwrite');
        tx.objectStore('files').put(text, path);
        tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
      });
    },
    async remove(path){
      try {
        const d = await db();
        await new Promise((res, rej) => {
          const tx = d.transaction('files','readwrite');
          tx.objectStore('files').delete(path);
          tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
        });
      } catch {}
    },
    async readBlob(path){
      try {
        const d = await db();
        return new Promise((res, rej) => {
          const tx = d.transaction('files','readonly');
          const r = tx.objectStore('files').get(path);
          r.onsuccess = e => res(e.target.result ? new Blob([e.target.result], { type:'text/plain' }) : null);
          r.onerror = e => rej(e.target.error);
        });
      } catch { return null; }
    },
    watch(){ },
    recents(){ return []; },
  };
})();

// Pick the on-device store once: the real OPFS where writes work, else the IndexedDB
// fallback (Safari < 17.2). Cached so the capability probe runs at most once.
let _onDeviceStore = null;
export async function resolveOnDeviceStore(){
  if (_onDeviceStore) return _onDeviceStore;
  _onDeviceStore = await opfsCanWrite() ? opfsStore : idbStore;
  return _onDeviceStore;
}
