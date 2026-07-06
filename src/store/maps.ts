// ============================================================
// The unified map registry — ONE localStorage list of every map the user has, on-device
// (OPFS) and local-folder (FSA) alike, so both kinds look the same to the UI. Each entry
// is a MapRef: `kind` says where the files live, `id` is the OPFS dir name (kind 'device')
// or the FSA handle key in IndexedDB (kind 'folder'). Disk lifecycle of on-device maps
// (create/delete/rename) is delegated to the store adapter's map ops; this module
// owns only the registry + last-map bookkeeping and the one-time legacy migration.
// ============================================================
import { readJSON, writeJSON } from '../utils/local-json.js';
import type { DeviceStore } from './types.js';

export interface MapRef {
  id: string;                    // device: OPFS dir name ('vault' = the legacy pre-multi-map dir); folder: FSA handle key
  kind: 'device' | 'folder';
  name: string;                  // display name (folder kind: the real directory name)
  when: number;                  // last opened / created (ms since epoch)
}
export type MapKind = MapRef['kind'];

const MAPS_KEY = 'mindmap.maps';        // MapRef[] — the registry
const LAST_MAP_KEY = 'mindmap.lastMap'; // {kind, id} — what boot() reopens

export function readMaps(): MapRef[] { return readJSON<MapRef[]>(MAPS_KEY, []); }
function writeMaps(list: MapRef[]): void {
  writeJSON(MAPS_KEY, [...list].sort((a, b) => b.when - a.when));   // most recent first
}
export function upsertMap(ref: MapRef): void {
  writeMaps([ref, ...readMaps().filter(m => m.id !== ref.id)]);
}
export function removeMapRef(id: string): void { writeMaps(readMaps().filter(m => m.id !== id)); }
export function touchMap(id: string): void {
  const m = readMaps().find(m => m.id === id);
  if (m) upsertMap({ ...m, when: Date.now() });
}

export function getLastMap(): { kind: MapKind; id: string } | null {
  return readJSON<{ kind: MapKind; id: string } | null>(LAST_MAP_KEY, null);
}
export function setLastMap(kind: MapKind, id: string): void { writeJSON(LAST_MAP_KEY, { kind, id }); }

// Each on-device map dir/prefix carries a map.json ({name}) so the registry can be rebuilt
// from disk if localStorage is ever cleared. App-owned, non-.md → invisible to the note walk.
export const MAP_META_FILE = 'map.json';
export function serializeMapMeta(name: string): string { return JSON.stringify({ name }); }
export function parseMapMetaName(text: string): string | null {
  try { const j = JSON.parse(text); if (typeof j?.name === 'string' && j.name) return j.name; } catch {}
  return null;
}

// Mint a new on-device map id (also its OPFS dir name under maps/).
export function newMapId(): string {
  return 'm' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
// "Untitled", "Untitled 2", … — auto-number against the given names (default: the registry).
export function uniqueMapName(base: string, names = new Set(readMaps().map(m => m.name))): string {
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

// ---- on-device map lifecycle: registry entry + the adapter's disk op ----
export async function createDeviceMap(s: DeviceStore, name?: string): Promise<MapRef> {
  const id = newMapId();
  const finalName = uniqueMapName((name || 'Untitled').trim() || 'Untitled');
  await s.createMap(id, finalName);
  const ref: MapRef = { id, kind: 'device', name: finalName, when: Date.now() };
  upsertMap(ref);
  return ref;
}
export async function deleteDeviceMap(s: DeviceStore, id: string): Promise<void> {
  await s.deleteMap(id);
  removeMapRef(id);
}
export async function renameDeviceMap(s: DeviceStore, id: string, name: string): Promise<void> {
  const finalName = name.trim();
  if (!finalName) return;
  await s.renameMap(id, finalName);
  const m = readMaps().find(m => m.id === id);
  if (m) upsertMap({ ...m, name: finalName });
}

// ---- one-time migration + rebuild ----
// Populates an empty registry from what exists already: the legacy FSA recents list, and
// whatever on-device maps the adapter can enumerate (incl. the legacy vault/ dir, which
// simply BECOMES the first map — no files are moved). Also derives the last-map ref from
// the legacy last-store key so the first boot after the update reopens the same map.
const LEGACY_RECENTS_KEY = 'mindmap.recentFolders';
const LEGACY_LAST_STORE_KEY = 'mindmap.lastStore';
const SEEN_KEY = 'mindmap.seenFolders';

export async function ensureMapRegistry(s: DeviceStore): Promise<void> {
  if (readMaps().length) return;
  const refs: MapRef[] = [];
  // legacy FSA recents → folder refs (handle keys unchanged, so resume keeps working)
  for (const r of readJSON<{ key: string; name: string; when: number }[]>(LEGACY_RECENTS_KEY, []))
    refs.push({ id: r.key, kind: 'folder', name: r.name, when: r.when });
  // on-device maps found on disk (legacy vault/ included)
  for (const m of await s.listMaps())
    refs.push({ id: m.id, kind: 'device', name: uniqueMapName(m.name, new Set(refs.map(r => r.name))), when: 0 });
  if (!refs.length) return;
  writeMaps(refs);
  try { localStorage.removeItem(LEGACY_RECENTS_KEY); } catch {}
  // carry the vault's "seen" mark to its new key, so the one-time auto-collapse never re-fires
  const seen = readJSON<string[]>(SEEN_KEY, []);
  if (seen.includes('On-device storage') && !seen.includes('device:vault'))
    writeJSON(SEEN_KEY, [...seen, 'device:vault']);
  // legacy last-store → last-map, so boot() reopens what the user last had open
  if (!getLastMap()) {
    let legacy: string | null = null;
    try { legacy = localStorage.getItem(LEGACY_LAST_STORE_KEY); } catch {}
    const first = (kind: MapKind) => refs.find(m => m.kind === kind);
    const pick = legacy === 'folder' ? (first('folder') ?? first('device')) : (first('device') ?? null);
    if (pick) setLastMap(pick.kind, pick.id);
  }
}
