// ---------- find a card (toolbar search box + dropdown) ----------
// Filters on title OR body, dims non-matching cards via state.searchMatch (paintAll
// applies the dimming), and focuses the chosen hit. searchBox is exported so the global
// "/" shortcut can focus it.
import { state, type MindNode } from '../core/state.js';
import { esc } from '../utils/markdown.js';
import { paintAll, focusNode } from '../main.js';

export const searchBox = document.getElementById('searchBox') as HTMLInputElement;
const searchResults = document.getElementById('searchResults') as HTMLElement;
let searchHits: MindNode[] = [], searchActive = -1;
function runSearch(): void {
  const q = searchBox.value.trim().toLowerCase();
  if (!q){ clearSearch(); return; }
  // match on title OR body content; dim every visible card that doesn't match
  const matches = [...state.nodes.values()].filter(n =>
    n.title.toLowerCase().includes(q) || (n.body && n.body.toLowerCase().includes(q)));
  state.searchMatch = new Set(matches.map(n => n.id));
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
  paintAll();   // apply the dimming
}
function clearSearch(): void {
  searchResults.classList.remove('open'); searchResults.innerHTML = '';
  searchHits = [];
  if (state.searchMatch){ state.searchMatch = null; paintAll(); }   // un-dim
}
function gotoHit(id: string): void {
  const n = state.nodes.get(id); if (!n) return;
  searchBox.value = ''; clearSearch(); searchBox.blur();
  focusNode(n);
}
searchBox.addEventListener('input', runSearch);
searchBox.addEventListener('focus', () => { if (searchBox.value.trim()) runSearch(); });
searchBox.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    if (!searchHits.length) return;
    searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length;
    [...searchResults.children].forEach((el,i) => el.classList.toggle('active', i === searchActive));
  } else if (e.key === 'Enter'){
    e.preventDefault();
    const hit = searchHits[searchActive];
    if (hit) gotoHit(hit.id);
  } else if (e.key === 'Escape'){
    e.preventDefault();
    if (searchBox.value){ searchBox.value = ''; runSearch(); } else searchBox.blur();
  }
});
searchResults.addEventListener('click', (e: MouseEvent) => {
  const item = (e.target as Element).closest('.sr-item');
  if (item) gotoHit((item as HTMLElement).dataset.id!);
});
document.addEventListener('pointerdown', (e: PointerEvent) => {           // click-away closes the dropdown
  if (!(e.target as Element).closest('#searchWrap')) searchResults.classList.remove('open');
});
