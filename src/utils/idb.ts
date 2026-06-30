// ---- IndexedDB key/value (persists FSA directory handles across sessions) ----
// The File System Access store stows real directory handles here so resume() can
// silently reopen the folder at boot. Plain get/put/del over a single object store.
// Open a single-object-store IndexedDB database, creating the store on first run. Shared by this
// key/value helper and the on-device file vault (store/idb-store.ts) so the open boilerplate lives once.
export function openDB(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(store);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

const IDB_DB = 'mindmap', IDB_STORE = 'handles';
const idb = (): Promise<IDBDatabase> => openDB(IDB_DB, IDB_STORE);
export async function idbPut(key: IDBValidKey, val: unknown): Promise<void> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
export async function idbGet(key: IDBValidKey): Promise<any> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const g = tx.objectStore(IDB_STORE).get(key);
    g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error);
  });
}
export async function idbDel(key: IDBValidKey): Promise<void> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
