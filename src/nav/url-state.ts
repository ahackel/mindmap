// ============================================================
// URL hash reflects navigable state — right now just "which node is selected in the
// currently open map" — so browser back/forward, reload, and bookmarks restore the same
// view. Node identity in the hash is the note's FILE PATH (the real, stable identity per
// CLAUDE.md), never the in-memory id, which is re-minted on every load. The map segment
// is checked against the currently open map's name; opening a DIFFERENT map from a link
// isn't wired up yet (that needs boot.ts's map-switching flow) — a later slice.
// ============================================================
import { state } from '../core/state.js';
import { store } from '../data/persistence.js';
import { selectNode } from '../main.js';

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'map';
}
// Node identity: the note's relative file path, percent-encoded per path segment so it
// round-trips through a URL hash regardless of what characters are in the title/filename.
function encodeFilePath(file: string): string {
  return file.replace(/\.md$/i, '').split('/').map(encodeURIComponent).join('/');
}
function decodeFilePath(encoded: string): string {
  return encoded.split('/').map(decodeURIComponent).join('/') + '.md';
}

export function currentDocumentTitle(): string {
  const node = state.selId ? state.nodes.get(state.selId) : undefined;
  return node ? `${node.title} — ${store.name}` : `Mindmap - ${store.name}`;
}
export function updateDocumentTitle(): void {
  document.title = currentDocumentTitle();
}

function buildHash(): string {
  if (!store.isOpen) return '';
  const node = state.selId ? state.nodes.get(state.selId) : undefined;
  const parts = [slugify(store.name)];
  if (node?.file) parts.push(encodeFilePath(node.file));
  return '#/' + parts.join('/');
}

let applying = false;      // guards the re-entrant selectNode() call inside applyUrlFromHash
let lastHash: string | null = null;

// Called after any selection change; pushes a new history entry only when the resolvable
// state (map + node) actually changed, so repeated calls (e.g. during marquee drag) are
// no-ops rather than spamming browser history.
export function syncUrl(): void {
  if (applying) return;
  const hash = buildHash();
  if (!hash || hash === lastHash) return;
  lastHash = hash;
  history.pushState(null, '', hash);
}

// Read the current hash and select the node it points at. Safe to call on boot and on
// popstate; does nothing if the hash is absent, malformed, points at a map that isn't the
// one currently open, or names a node that doesn't exist in it.
export function applyUrlFromHash(): void {
  const hash = location.hash;
  if (!hash || hash.length < 2) return;
  const segs = hash.slice(2).split('/').filter(Boolean);   // drop the leading '#/'
  const [mapSlug, ...pathSegs] = segs;
  if (!mapSlug || !store.isOpen || slugify(store.name) !== mapSlug) return;
  if (!pathSegs.length) return;
  const file = decodeFilePath(pathSegs.join('/'));
  const target = [...state.nodes.values()].find(n => n.file === file);
  if (!target) return;
  applying = true;
  try { selectNode(target.id); } finally { applying = false; }
  lastHash = hash;
}

window.addEventListener('popstate', applyUrlFromHash);
