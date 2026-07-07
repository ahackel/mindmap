// ---------- find a card (toolbar search box + dropdown) ----------
// Filters on title OR body. Every match is highlighted by dimming the non-matching cards
// (state.searchMatch, applied in paintAll); a match buried in a collapsed branch highlights
// the first visible parent containing it instead. The active dropdown option's card gets an
// extra white outline (state.searchActiveId). searchBox is exported so the global "/"
// shortcut can focus it.
import { state, type MindNode } from '../core/state.js';
import { esc } from '../utils/markdown.js';
import { firstVisible } from '../utils/model.js';
import { paintAll, focusNode } from '../main.js';
import { outlineActive, revealInOutline } from './outline.js';

export const searchBox = document.getElementById('searchBox') as HTMLInputElement;
const searchWrap = document.getElementById('searchWrap') as HTMLElement;
const searchBtn = document.getElementById('searchBtn') as HTMLButtonElement;
const searchResults = document.getElementById('searchResults') as HTMLElement;
const searchClear = document.getElementById('searchClear') as HTMLButtonElement;
let searchHits: MindNode[] = [], searchActive = -1;
// Open the floating search bar and focus the box (also the "/" shortcut entry point).
export function openSearch(): void {
  searchWrap.classList.add('open');
  searchBtn.classList.add('active');
  searchBox.focus(); searchBox.select();
}
// Close the bar and drop any active highlight.
function closeSearch(): void {
  searchBox.value = ''; clearSearch();
  searchWrap.classList.remove('open');
  searchBtn.classList.remove('active');
}
function runSearch(): void {
  const q = searchBox.value.trim().toLowerCase();
  searchBox.classList.toggle('has-value', !!searchBox.value);
  if (!q){ clearSearch(); return; }
  // match on title OR body content
  const matches = [...state.nodes.values()].filter(n =>
    n.title.toLowerCase().includes(q) || (n.body && n.body.toLowerCase().includes(q)));
  // highlight every match — surfacing a hidden match through its first visible parent
  state.searchMatch = new Set(matches.map(n => firstVisible(n).id));
  // dropdown: title matches first, then body-only matches, alphabetical within each
  searchHits = matches.sort((a,b) => {
    const at = a.title.toLowerCase().includes(q), bt = b.title.toLowerCase().includes(q);
    return at !== bt ? (at ? -1 : 1) : a.title.localeCompare(b.title);
  }).slice(0, 12);
  searchActive = searchHits.length ? 0 : -1;
  searchResults.innerHTML = searchHits.length
    ? searchHits.map((n,i) => `<button class="sr-item${i===searchActive?' active':''}" data-id="${n.id}">${esc(n.title)}</button>`).join('')
    : '<div class="sr-none">No card matches</div>';
  searchResults.classList.add('open');
  markActive();   // white outline on the active option's (visible) card
  paintAll();
}
// Point state.searchActiveId at the active dropdown option's card (or the first visible
// parent containing it when it's collapsed away) so paintNode gives it a white outline.
function markActive(): void {
  const hit = searchHits[searchActive];
  state.searchActiveId = hit ? firstVisible(hit).id : null;
}
function clearSearch(): void {
  searchResults.classList.remove('open'); searchResults.innerHTML = '';
  searchHits = [];
  searchBox.classList.toggle('has-value', !!searchBox.value);
  if (state.searchMatch){ state.searchMatch = null; state.searchActiveId = null; paintAll(); }   // un-dim
}
function gotoHit(id: string): void {
  const n = state.nodes.get(id); if (!n) return;
  closeSearch();   // jumping to a card dismisses the search bar
  if (outlineActive()) revealInOutline(id);   // unfold ancestors + scroll the row into view
  else focusNode(n, true);   // reveal ancestors level by level AND open the hit itself
}
searchBox.addEventListener('input', runSearch);
searchBox.addEventListener('focus', () => { if (searchBox.value.trim()) runSearch(); });
searchBox.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    if (!searchHits.length) return;
    searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length;
    [...searchResults.children].forEach((el,i) => el.classList.toggle('active', i === searchActive));
    markActive(); paintAll();   // move the white outline to the newly-active option
  } else if (e.key === 'Enter'){
    e.preventDefault();
    e.stopPropagation();   // gotoHit blurs the box, so don't let Enter reach the window handler (it would create a sibling)
    const hit = searchHits[searchActive];
    if (hit) gotoHit(hit.id);
  } else if (e.key === 'Escape'){
    e.preventDefault();
    if (searchBox.value){ searchBox.value = ''; runSearch(); } else closeSearch();
  }
});
searchResults.addEventListener('click', (e: MouseEvent) => {
  const item = (e.target as Element).closest('.sr-item');
  if (item) gotoHit((item as HTMLElement).dataset.id!);
});
searchClear.addEventListener('click', () => { searchBox.value = ''; runSearch(); searchBox.focus(); });
searchBtn.addEventListener('click', () => {   // toolbar icon toggles the floating bar
  if (searchWrap.classList.contains('open')) closeSearch(); else openSearch();
});
document.addEventListener('pointerdown', (e: PointerEvent) => {           // click-away closes the bar
  if (!searchWrap.classList.contains('open')) return;
  const t = e.target as Element;
  if (!t.closest('#searchWrap') && !t.closest('#searchBtn')) closeSearch();
});
