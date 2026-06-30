// IndexedDB fallback store — identical interface to opfsStore, used on Safari < 17.2 where
// OPFS lacks createWritable(). A flat key/value object store keyed by relative path.
export const idbStore = (() => {
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
