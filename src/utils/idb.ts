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

// Promise-wrapped single-op transactions over any db/store (shared with store/idb-store.ts).
export function dbPut(db: IDBDatabase, store: string, key: IDBValidKey, val: unknown): Promise<void> {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
export function dbGet(db: IDBDatabase, store: string, key: IDBValidKey): Promise<any> {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const g = tx.objectStore(store).get(key);
    g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error);
  });
}
export function dbDel(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

const IDB_DB = 'mindmap', IDB_STORE = 'handles';
const idb = (): Promise<IDBDatabase> => openDB(IDB_DB, IDB_STORE);
export async function idbPut(key: IDBValidKey, val: unknown): Promise<void> { return dbPut(await idb(), IDB_STORE, key, val); }
export async function idbGet(key: IDBValidKey): Promise<any> { return dbGet(await idb(), IDB_STORE, key); }
export async function idbDel(key: IDBValidKey): Promise<void> { return dbDel(await idb(), IDB_STORE, key); }
