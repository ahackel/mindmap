// IndexedDB fallback store — identical interface to opfsStore, used on Safari < 17.2 where
// OPFS lacks createWritable(). A flat key/value object store keyed by relative path.
import type { Store, PickResult, NoteFile } from './types.js';
import { openDB } from '../utils/idb.js';

export const idbStore = (() => {
  let _db: IDBDatabase | null = null, _opened = false;
  async function db(): Promise<IDBDatabase> {
    return _db ??= await openDB('mindmap-vault', 'files');
  }
  return {
    get isOpen(){ return _opened; },
    get name(){ return 'On-device storage'; },
    async pick(): Promise<PickResult> { try { await db(); _opened = true; return 'ok'; } catch { return 'error'; } },
    async openRecent(): Promise<PickResult> { return this.pick(); },
    async list(): Promise<NoteFile[]> {
      const d = await db();
      return new Promise<NoteFile[]>((res, rej) => {
        const tx = d.transaction('files','readonly'), out: NoteFile[] = [];
        tx.objectStore('files').openCursor().onsuccess = e => {
          const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (c){ if ((c.key as string).endsWith('.md')) out.push({ path: c.key as string, text: c.value }); c.continue(); }
          else res(out);
        };
        tx.onerror = e => rej((e.target as IDBTransaction).error);
      });
    },
    async write(path: string, data: string | Blob): Promise<void> {
      const d = await db();
      return new Promise<void>((res, rej) => {
        const tx = d.transaction('files','readwrite');
        tx.objectStore('files').put(data, path);
        tx.oncomplete = () => res(); tx.onerror = e => rej((e.target as IDBTransaction).error);
      });
    },
    async remove(path: string): Promise<void> {
      try {
        const d = await db();
        await new Promise<void>((res, rej) => {
          const tx = d.transaction('files','readwrite');
          tx.objectStore('files').delete(path);
          tx.oncomplete = () => res(); tx.onerror = e => rej((e.target as IDBTransaction).error);
        });
      } catch {}
    },
    async readBlob(path: string): Promise<Blob | null> {
      try {
        const d = await db();
        return new Promise<Blob | null>((res, rej) => {
          const tx = d.transaction('files','readonly');
          const r = tx.objectStore('files').get(path);
          r.onsuccess = e => { const v = (e.target as IDBRequest).result; res(v ? new Blob([v], { type:'text/plain' }) : null); };
          r.onerror = e => rej((e.target as IDBRequest).error);
        });
      } catch { return null; }
    },
    watch(){ },
    recents(){ return []; },
  };
})();
idbStore satisfies Store;   // compile-time contract check
