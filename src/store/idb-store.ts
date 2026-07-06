// IndexedDB fallback store — identical interface to opfsStore, used on Safari < 17.2 where
// OPFS lacks createWritable(). A flat key/value object store keyed by relative path.
// Multi-map: each map's files share one object store, namespaced by an `<id>::` key prefix;
// the legacy pre-multi-map notes live unprefixed and simply ARE the map with id 'vault'
// (mirroring the OPFS adapter's legacy vault/ dir). `<id>::map.json` carries the display name.
import type { DeviceStore, PickResult, NoteFile } from './types.js';
import { openDB, dbPut, dbGet, dbDel } from '../utils/idb.js';
import { MAP_META_FILE, serializeMapMeta, parseMapMetaName } from './maps.js';

export const idbStore = (() => {
  let _db: IDBDatabase | null = null, _opened = false;
  let _mapId = 'vault', _mapName = 'On-device storage';
  async function db(): Promise<IDBDatabase> {
    return _db ??= await openDB('mindmap-vault', 'files');
  }
  const prefixOf = (id: string): string => id === 'vault' ? '' : id + '::';
  // does this raw key belong to the map `id`? (vault owns every unprefixed key)
  const ownedBy = (key: string, id: string): boolean =>
    id === 'vault' ? !key.includes('::') : key.startsWith(prefixOf(id));

  async function eachKey(cb: (key: string, value: unknown) => void): Promise<void> {
    const d = await db();
    return new Promise<void>((res, rej) => {
      const tx = d.transaction('files', 'readonly');
      tx.objectStore('files').openCursor().onsuccess = e => {
        const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (c){ cb(c.key as string, c.value); c.continue(); }
        else res();
      };
      tx.onerror = e => rej((e.target as IDBTransaction).error);
    });
  }
  const put = async (key: string, data: string | Blob): Promise<void> => dbPut(await db(), 'files', key, data);
  const del = async (key: string): Promise<void> => dbDel(await db(), 'files', key);

  return {
    get isOpen(){ return _opened; },
    get name(){ return _mapName; },
    get seenKey(){ return 'device:' + _mapId; },

    openMap(id: string, name?: string){ _mapId = id; if (name) _mapName = name; },
    async createMap(id: string, name: string){ await put(prefixOf(id) + MAP_META_FILE, serializeMapMeta(name)); },
    async renameMap(id: string, name: string){
      await this.createMap(id, name);   // rename IS a meta rewrite
      if (id === _mapId) _mapName = name;
    },
    async deleteMap(id: string){
      // one readwrite cursor pass: delete the map's keys inside a single transaction
      const d = await db();
      await new Promise<void>((res, rej) => {
        const tx = d.transaction('files', 'readwrite');
        tx.objectStore('files').openCursor().onsuccess = e => {
          const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (c){ if (ownedBy(c.key as string, id)) c.delete(); c.continue(); }
        };
        tx.oncomplete = () => res(); tx.onerror = e => rej((e.target as IDBTransaction).error);
      });
    },
    async listMaps(){
      // every distinct key prefix is a map; any unprefixed key means the legacy vault exists
      const ids = new Set<string>(); const names = new Map<string, string>();
      await eachKey((k, v) => {
        const sep = k.indexOf('::');
        const id = sep >= 0 ? k.slice(0, sep) : 'vault';
        ids.add(id);
        if (k === prefixOf(id) + MAP_META_FILE && typeof v === 'string'){
          const name = parseMapMetaName(v);
          if (name) names.set(id, name);
        }
      });
      return [...ids].map(id => ({ id, name: names.get(id) ?? (id === 'vault' ? 'My map' : id) }));
    },

    async pick(): Promise<PickResult> { try { await db(); _opened = true; return 'ok'; } catch { return 'error'; } },
    async openRecent(): Promise<PickResult> { return this.pick(); },
    async list(): Promise<NoteFile[]> {
      const p = prefixOf(_mapId), out: NoteFile[] = [];
      await eachKey((k, v) => {
        if (!ownedBy(k, _mapId) || !k.endsWith('.md')) return;
        out.push({ path: k.slice(p.length), text: v as string });
      });
      return out;
    },
    async write(path: string, data: string | Blob): Promise<void> { return put(prefixOf(_mapId) + path, data); },
    async remove(path: string): Promise<void> { try { await del(prefixOf(_mapId) + path); } catch {} },
    async readBlob(path: string): Promise<Blob | null> {
      try {
        const v = await dbGet(await db(), 'files', prefixOf(_mapId) + path);
        return v ? new Blob([v], { type: 'text/plain' }) : null;
      } catch { return null; }
    },
    watch(){ },
  };
})();
idbStore satisfies DeviceStore;   // compile-time contract check
