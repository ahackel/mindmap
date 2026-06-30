// The contract every storage backend implements — the single swappable I/O boundary.
// opfsStore / fsaStore / idbStore all satisfy this; main.js holds the active `store`.

// A note read from / written to disk: relative '/'-separated path + its text.
export interface NoteFile { path: string; text: string; }

// A remembered FSA folder: its IndexedDB handle key + display name + last-opened time.
export interface RecentFolder { key: string; name: string; when: number; }

// Outcome of an open attempt. Different backends use different subsets.
export type PickResult = 'ok' | 'cancel' | 'denied' | 'unsupported' | 'error' | 'gone';

export interface Store {
  readonly isOpen: boolean;
  readonly name: string;
  pick(): Promise<PickResult>;
  openRecent(key?: string): Promise<PickResult>;
  resume?(key: string): Promise<boolean>;   // FSA only: silent reopen if permission persists
  list(): Promise<NoteFile[]>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  readBlob(path: string): Promise<Blob | null>;
  watch(cb: () => void): void;
  recents(): RecentFolder[];
}
