// OPFS adapter — the LOCAL-FIRST default. The Origin Private File System is a private,
// per-origin store every modern browser (incl. iPad Safari) supports. Its handle API matches
// FSA, so file ops delegate to the same handle-store helpers (DRY); only the root differs.
// No picker, no permission, no external watcher.
//
// Multi-map: each map is its own directory — maps/<id>/ for new maps, plus the legacy
// pre-multi-map 'vault/' dir, which simply IS the map with id 'vault' (no migration copy).
// openMap(id) retargets every file op; each dir carries a map.json ({name}) so the registry
// can be rebuilt from disk if localStorage is ever cleared.
import { listMd, writeFile, removeFile, readFileBlob } from './handle-store.js';
import { MAP_META_FILE, serializeMapMeta, parseMapMetaName } from './maps.js';
import type { DeviceStore, PickResult } from './types.js';

export const opfsStore = {
  _dir: null as FileSystemDirectoryHandle | null,
  _opened: false,
  _mapId: 'vault',
  _mapName: 'On-device storage',
  get isOpen(){ return this._opened; },
  get name(){ return this._mapName; },
  get seenKey(){ return 'device:' + this._mapId; },

  // Resolve a map id to its directory handle ('vault' lives at the root, the rest under maps/).
  async _mapDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    if (id === 'vault') return root.getDirectoryHandle('vault', { create });
    const maps = await root.getDirectoryHandle('maps', { create: true });
    return maps.getDirectoryHandle(id, { create });
  },
  async _root(): Promise<FileSystemDirectoryHandle> {
    return this._dir ??= await this._mapDir(this._mapId, true);
  },

  // Retarget every file op at another map. Cheap — the dir handle is re-resolved lazily.
  openMap(id: string, name?: string): void {
    if (id !== this._mapId){ this._mapId = id; this._dir = null; this._opened = false; }
    if (name) this._mapName = name;
  },
  async createMap(id: string, name: string): Promise<void> {
    const d = await this._mapDir(id, true);
    await writeFile(d, MAP_META_FILE, serializeMapMeta(name));
  },
  async deleteMap(id: string): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      if (id === 'vault') await root.removeEntry('vault', { recursive: true });
      else await (await root.getDirectoryHandle('maps')).removeEntry(id, { recursive: true });
    } catch { /* already gone — fine */ }
    if (id === this._mapId){ this._dir = null; this._opened = false; }
  },
  async renameMap(id: string, name: string): Promise<void> {
    await this.createMap(id, name);   // rename IS a meta rewrite
    if (id === this._mapId) this._mapName = name;
  },
  // Enumerate the maps that exist on disk (for the registry's one-time migration/rebuild).
  async listMaps(): Promise<{ id: string; name: string }[]> {
    const nameOf = async (d: FileSystemDirectoryHandle, fallback: string): Promise<string> => {
      const blob = await readFileBlob(d, MAP_META_FILE);
      return (blob && parseMapMetaName(await blob.text())) || fallback;
    };
    const dirs: { id: string; handle: FileSystemDirectoryHandle; fallback: string }[] = [];
    const root = await navigator.storage.getDirectory();
    try { dirs.push({ id: 'vault', handle: await root.getDirectoryHandle('vault'), fallback: 'My map' }); } catch {}
    try {
      const maps = await root.getDirectoryHandle('maps');
      for await (const [id, h] of maps.entries())
        if (h.kind === 'directory') dirs.push({ id, handle: h as FileSystemDirectoryHandle, fallback: id });
    } catch {}
    return Promise.all(dirs.map(async d => ({ id: d.id, name: await nameOf(d.handle, d.fallback) })));
  },

  async pick(): Promise<PickResult> { try { await this._root(); this._opened = true; return 'ok'; } catch { return 'error'; } },
  async openRecent(): Promise<PickResult> { return this.pick(); },
  async list(){ return listMd(await this._root()); },
  async write(path: string, data: string | Blob){ return writeFile(await this._root(), path, data); },
  async remove(path: string){ return removeFile(await this._root(), path); },
  async readBlob(path: string){ return readFileBlob(await this._root(), path); },
  watch(){ /* OPFS can't change underneath us */ },
};
opfsStore satisfies DeviceStore;   // compile-time contract check (extra _dir/_opened/_root allowed on a reference)
