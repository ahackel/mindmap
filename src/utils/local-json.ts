// Read/write a JSON value in localStorage, tolerating absent/corrupt entries and a missing API.
export function readJSON<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
export function writeJSON(key: string, val: unknown): void { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
