// ============================================================
// The store adapter — the single swappable I/O boundary. All disk access goes through one
// of the adapters below, which share the same handle-based interface:
//   opfsStore — local-first default (OPFS), works on every browser incl. iPad.
//   fsaStore  — File System Access API (Chrome/Edge): a real local folder.
//   idbStore  — IndexedDB fallback for Safari < 17.2 (no OPFS createWritable).
// Retargeting the app (Obsidian vault, Tauri, …) means replacing only this folder. This
// barrel re-exports the adapters + recents helpers and resolves which on-device store to use.
// ============================================================
import { opfsStore } from './opfs.js';
import { idbStore } from './idb-store.js';
import type { Store } from './types.js';

export type { Store, NoteFile, RecentFolder, PickResult } from './types.js';
export { opfsStore } from './opfs.js';
export { fsaStore } from './fsa.js';
export { readRecents, writeRecents, forgetRecent, seenFolders, markFolderSeen, setOnRecentsChanged } from './recents.js';

// OPFS write requires FileSystemWritableFileStream (createWritable), which Safari added in 17.2.
// On iOS ≤16 we fall back to an IndexedDB store with the same interface.
async function opfsCanWrite(): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('__writetest__', { create: true });
    const w = await fh.createWritable();
    await w.close();
    await root.removeEntry('__writetest__');
    return true;
  } catch { return false; }
}

// Pick the on-device store once: the real OPFS where writes work, else the IndexedDB
// fallback (Safari < 17.2). Cached so the capability probe runs at most once.
let _onDeviceStore: Store | null = null;
export async function resolveOnDeviceStore(): Promise<Store> {
  if (_onDeviceStore) return _onDeviceStore;
  _onDeviceStore = await opfsCanWrite() ? opfsStore : idbStore;
  return _onDeviceStore;
}
