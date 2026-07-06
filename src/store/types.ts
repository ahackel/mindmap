// The contract every storage backend implements — the single swappable I/O boundary.
// opfsStore / fsaStore / idbStore all satisfy this; main.js holds the active `store`.

// A note read from / written to disk: relative '/'-separated path + its text.
export interface NoteFile { path: string; text: string; }

// Outcome of an open attempt. Different backends use different subsets.
export type PickResult = 'ok' | 'cancel' | 'denied' | 'unsupported' | 'error' | 'gone';

export interface Store {
  readonly isOpen: boolean;
  readonly name: string;
  readonly seenKey: string;                 // stable first-open key (name can be renamed / collide)
  pick(): Promise<PickResult>;
  openRecent(key?: string): Promise<PickResult>;
  resume?(key: string): Promise<boolean>;   // FSA only: silent reopen if permission persists
  list(): Promise<NoteFile[]>;
  write(path: string, data: string | Blob): Promise<void>;
  remove(path: string): Promise<void>;
  readBlob(path: string): Promise<Blob | null>;
  watch(cb: () => void): void;
}

// On-device backends (OPFS / the IndexedDB fallback) additionally host MULTIPLE maps and
// manage their disk lifecycle. FSA folders are one map each, chosen by the user, so the
// plain Store contract has none of this.
export interface DeviceStore extends Store {
  openMap(id: string, name?: string): void;
  createMap(id: string, name: string): Promise<void>;
  deleteMap(id: string): Promise<void>;
  renameMap(id: string, name: string): Promise<void>;
  listMaps(): Promise<{ id: string; name: string }[]>;
}
