// Recent folders backing store: directory handles live in IndexedDB (not serializable to
// JSON), a small display list lives in localStorage. Plus the one-time "seen folders" set
// (so the first-open auto-arrange never fires twice).
import { idbDel } from '../utils/idb.js';
import type { RecentFolder } from './types.js';

// Read/write a JSON value in localStorage, tolerating absent/corrupt entries and a missing API.
function readJSON<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
function writeJSON(key: string, val: unknown): void { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

const RECENT_KEY = 'mindmap.recentFolders';   // [{key, name, when}]  (localStorage)
export function readRecents(): RecentFolder[] { return readJSON<RecentFolder[]>(RECENT_KEY, []); }
export function writeRecents(list: RecentFolder[]): void { writeJSON(RECENT_KEY, list.slice(0, 5)); }
// Drop a recent folder by its key (display list + its stored handle) when it can no longer be opened.
export async function forgetRecent(key: string): Promise<void> {
  writeRecents(readRecents().filter(r => r.key !== key));
  try { await idbDel(key); } catch {}
}

// Folders we've already auto-arranged once. Used so the one-time auto-collapse never
// fires again — every later open restores the saved frontmatter state verbatim.
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
