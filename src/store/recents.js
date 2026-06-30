// Recent folders backing store: directory handles live in IndexedDB (not serializable to
// JSON), a small display list lives in localStorage. Plus the one-time "seen folders" set
// (so the first-open auto-arrange never fires twice).
import { idbDel } from '../utils/idb.js';

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

// The store layer must not render UI. main wires this to renderRecents so the FSA adapter
// can signal "the recents list changed" without reaching into the view layer.
let _onChanged = () => {};
export function setOnRecentsChanged(fn){ _onChanged = fn; }
export function notifyRecentsChanged(){ _onChanged(); }
