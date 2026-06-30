// OPFS adapter — the LOCAL-FIRST default. The Origin Private File System is a private,
// per-origin store every modern browser (incl. iPad Safari) supports. Its handle API matches
// FSA, so file ops delegate to the same handle-store helpers (DRY); only the root differs.
// No picker, no permission, no external watcher.
import { listMd, writeFile, removeFile, readFileBlob } from './handle-store.js';
import type { Store, PickResult } from './types.js';

export const opfsStore = {
  _dir: null as FileSystemDirectoryHandle | null,
  _opened: false,
  get isOpen(){ return this._opened; },
  get name(){ return 'On-device storage'; },
  async _root(): Promise<FileSystemDirectoryHandle> {
    if (this._dir) return this._dir;
    const root = await navigator.storage.getDirectory();
    this._dir = await root.getDirectoryHandle('vault', { create:true });
    return this._dir;
  },
  async pick(): Promise<PickResult> { try { await this._root(); this._opened = true; return 'ok'; } catch { return 'error'; } },
  async openRecent(): Promise<PickResult> { return this.pick(); },
  async list(){ return listMd(await this._root()); },
  async write(path: string, text: string){ return writeFile(await this._root(), path, text); },
  async remove(path: string){ return removeFile(await this._root(), path); },
  async readBlob(path: string){ return readFileBlob(await this._root(), path); },
  watch(){ /* OPFS can't change underneath us */ },
  recents(){ return []; },
};
opfsStore satisfies Store;   // compile-time contract check (extra _dir/_opened/_root allowed on a reference)
