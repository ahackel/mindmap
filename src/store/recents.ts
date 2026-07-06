// Recent FSA folders — now a thin view over the unified map registry (maps.ts): folder-kind
// MapRefs ARE the recents list. Directory handles still live in IndexedDB (not serializable
// to JSON) under the ref's id. Plus the one-time "seen" set (so the first-open auto-arrange
// never fires twice).
import { idbDel } from '../utils/idb.js';
import { readMaps, upsertMap, removeMapRef } from './maps.js';
import { readJSON, writeJSON } from '../utils/local-json.js';

// Record a (re)opened FSA folder: de-dupe by folder name (a reopen mints a fresh handle key),
// dropping the superseded refs' stored handles so they don't strand in IndexedDB.
export function rememberFolder(key: string, name: string): void {
  for (const m of readMaps()) if (m.kind === 'folder' && m.name === name && m.id !== key) {
    removeMapRef(m.id);
    void idbDel(m.id).catch(() => {});
  }
  upsertMap({ id: key, kind: 'folder', name, when: Date.now() });
}
// Drop a recent folder by its key (registry entry + its stored handle) when it can no longer be opened.
export async function forgetRecent(key: string): Promise<void> {
  removeMapRef(key);
  try { await idbDel(key); } catch {}
}

// Maps we've already auto-arranged once (keyed by store.seenKey). Used so the
// one-time auto-collapse never fires again — every later open restores the saved state verbatim.
const SEEN_KEY = 'mindmap.seenFolders';
export function seenFolders(): string[] { return readJSON<string[]>(SEEN_KEY, []); }
export function markFolderSeen(name: string): void {
  const s = seenFolders();
  if (!s.includes(name)) { s.push(name); writeJSON(SEEN_KEY, s); }
}

// The store layer must not render UI. main wires this to renderRecents so the FSA adapter
// can signal "the recents list changed" without reaching into the view layer.
let _onChanged: () => void = () => {};
export function setOnRecentsChanged(fn: () => void): void { _onChanged = fn; }
export function notifyRecentsChanged(): void { _onChanged(); }
