// ---------- shared emoji-tag popover: Slack-reaction-style "add a tag" picker ----------
// Opened from a trigger button — the selected card's own ".tag-add-btn" (main.ts), or the outline
// properties sheet's tag-row "+" (properties.ts) — anchored next to it (same anchor-rect +
// viewport-clamp math as float-bar.ts's own colour/type/layout popovers — an independently-owned
// copy, same style as that module's own relationship to context-menu.ts's openMenu, per CLAUDE.md's
// note on these small UI modules each owning their own positioning rather than sharing one
// abstraction).
// Primary path is clicking a pill: recently-used emoji first (persisted in localStorage — a UI
// convenience, not vault data), then a curated set of common "tag-like" emoji, then any other
// distinct emoji already used somewhere in the vault (so a tag used only once isn't hard to find
// again) — covers the overwhelming majority of picks without ever needing to type. A trailing text
// input is the fallback for anything outside that set (there's no embeddable browser emoji-picker
// API, so it leans on the OS picker — Cmd+Ctrl+Space / Win+. — or paste) and takes its first
// grapheme cluster as the tag.
import { state } from '../core/state.js';
import { setTagOnNodes, tagPillHTML } from './tags.js';

const MRU_KEY = 'mindmap.tagMru';
const MRU_MAX = 16;
const GRID_MAX = 56;

// A hand-picked set covering common "status / priority / type" reactions — chosen so clicking is
// the normal path and the type-your-own input becomes the rare fallback, not the primary flow.
const CURATED = [
  '🔥','⭐','📌','✅','❌','⚠️','💡','🐛','🚀','📅',
  '🔒','👍','👎','❤️','🎉','📝','🔗','🔍','🛠️','🚧',
  '🔔','💬','🎯','📊','🧠','📚','🧩','⏰','💰','🏆',
  '🚩','🌟','🧪','📎','🗂️','😀','😢','🤔','👀','💤',
];

function loadMru(): string[] {
  try { const raw = JSON.parse(localStorage.getItem(MRU_KEY) ?? '[]'); return Array.isArray(raw) ? raw.filter(t => typeof t === 'string') : []; }
  catch { return []; }
}
function pushMru(tag: string): void {
  const mru = loadMru().filter(t => t !== tag);
  mru.unshift(tag);
  localStorage.setItem(MRU_KEY, JSON.stringify(mru.slice(0, MRU_MAX)));
}

// Every distinct tag currently in use anywhere in the vault, in first-seen order.
function vaultTags(): string[] {
  const seen = new Set<string>();
  for (const n of state.nodes.values()) for (const t of n.tags) seen.add(t);
  return [...seen];
}

// First grapheme cluster of the (trimmed) input — guards against pasting a whole sentence or a
// multi-emoji string while still handling multi-codepoint emoji (flags, ZWJ sequences) correctly.
function firstGrapheme(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const Seg = (Intl as unknown as { Segmenter?: new (locale?: string, opts?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) { const it = new Seg(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator](); const first = it.next(); return first.done ? '' : first.value.segment; }
  return [...s][0] ?? '';
}

const pop = document.createElement('div');
pop.id = 'emojiPop';
document.body.appendChild(pop);

let closeOnOutside: ((e: PointerEvent) => void) | null = null;
let openAnchor: HTMLElement | null = null;
function close(): void {
  pop.classList.remove('open');
  openAnchor = null;
  if (closeOnOutside) { document.removeEventListener('pointerdown', closeOnOutside, true); closeOnOutside = null; }
  document.removeEventListener('keydown', onKey, true);
}
function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') close(); }

function position(anchor: HTMLElement): void {
  const ar = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = ar.left + ar.width / 2 - pw / 2;
  let top = ar.top - ph - 8;
  if (top < 4) top = ar.bottom + 8;
  left = Math.min(Math.max(left, 4), window.innerWidth - pw - 4);
  top = Math.min(Math.max(top, 4), window.innerHeight - ph - 4);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

export function openEmojiPicker(anchor: HTMLElement, targetIds: string[], onChange?: () => void): void {
  const wasOpenForSameAnchor = pop.classList.contains('open') && openAnchor === anchor;
  close();
  if (wasOpenForSameAnchor) return;
  const ids = targetIds.filter(id => state.nodes.has(id));
  if (!ids.length) return;
  const current = (tag: string): boolean => ids.every(id => state.nodes.get(id)!.tags.includes(tag));
  const mru = loadMru();
  const suggested: string[] = [];
  for (const t of [...CURATED, ...vaultTags()]) { if (suggested.length >= GRID_MAX) break; if (!mru.includes(t) && !suggested.includes(t)) suggested.push(t); }

  const pick = (tag: string): void => {
    setTagOnNodes(ids, tag, !current(tag));
    pushMru(tag);
    close();
    onChange?.();
  };
  const grid = (label: string, tags: string[]): string => tags.length
    ? `<div class="emoji-label">${label}</div><div class="emoji-grid">${tags.map(t => tagPillHTML(t, current(t) ? ' class="tag-pill active"' : '')).join('')}</div>`
    : '';

  pop.innerHTML = grid('Recent', mru) + grid('Suggestions', suggested) +
    `<input type="text" class="emoji-input" placeholder="Or type/paste your own, then Enter" autocomplete="off" spellcheck="false">`;
  pop.querySelectorAll<HTMLElement>('.emoji-grid .tag-pill').forEach(el => {
    el.addEventListener('click', () => pick(el.dataset.tag!));
  });
  const input = pop.querySelector<HTMLInputElement>('.emoji-input')!;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); const g = firstGrapheme(input.value); if (g) pick(g); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  pop.classList.add('open');
  openAnchor = anchor;
  position(anchor);
  document.addEventListener('keydown', onKey, true);
  closeOnOutside = (e: PointerEvent) => { if (!pop.contains(e.target as Node) && e.target !== anchor) close(); };
  document.addEventListener('pointerdown', closeOnOutside, true);
}
