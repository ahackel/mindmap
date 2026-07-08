// ---------- custom right-click context menu ----------
// Replaces the browser menu on the canvas with node / canvas actions (desktop right-click;
// on touch browsers that synthesize `contextmenu` from a long-press it works for free —
// there is deliberately NO custom long-press handling). The native menu is intentionally
// let through inside an active title/body editor so spellcheck & copy/paste keep working.
// Menu items only call the existing crud / camera / main kernels — no logic of its own.
import { state, stage, setStatus, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { screenToWorld, fit } from '../view/camera.js';
import { createNode } from './crud.js';
import { pasteFromClipboard } from './attachments.js';
import { record } from './history.js';
import { typedImageBlob } from './images.js';
import { esc } from '../utils/markdown.js';
import { scheduleSave } from '../data/persistence.js';
import { applyLayouts } from '../view/layout.js';
import { paintAll } from '../main.js';
// buildCardMenu lives in float-bar.ts (it also owns the kebab button that shares this same menu)
// — this creates a deliberate two-way import cycle with float-bar.ts (which imports openMenu /
// copyFilePath from here), same style as the main↔features cycle documented in CLAUDE.md; both
// sides only touch it inside event handlers, never at module-eval time, so it's safe.
import { buildCardMenu } from './float-bar.js';

const menu = document.createElement('div');
menu.id = 'ctxMenu';
document.body.appendChild(menu);

function closeMenu(): void { menu.classList.remove('open'); }

interface ItemOpts { disabled?: boolean; danger?: boolean }
function addItem(label: string, shortcut: string, run: () => void, opts: ItemOpts = {}): void {
  const b = document.createElement('button');
  b.className = 'cm-item' + (opts.danger ? ' cm-danger' : ''); b.type = 'button';
  const l = document.createElement('span'); l.textContent = label; b.appendChild(l);
  if (shortcut){ const k = document.createElement('kbd'); k.textContent = shortcut; b.appendChild(k); }
  if (opts.disabled) b.disabled = true;
  b.addEventListener('click', () => { closeMenu(); run(); });
  menu.appendChild(b);
}

// ---- generic API: other UI (the home sidebar's ⋮ / right-click) reuses this menu ----
export type MenuEntry = 'sep' | { label: string; shortcut?: string; run: () => void; disabled?: boolean; danger?: boolean };
export function openMenu(entries: MenuEntry[], x: number, y: number): void {
  menu.innerHTML = '';
  for (const e of entries){
    if (e === 'sep') addSep();
    else addItem(e.label, e.shortcut ?? '', e.run, e);
  }
  if (menu.childElementCount) openMenuAt(x, y);
}
function addSep(): void {
  if (!menu.lastElementChild || menu.lastElementChild.className === 'cm-sep') return;
  const s = document.createElement('div'); s.className = 'cm-sep'; menu.appendChild(s);
}

// Copy the card's on-disk relative path (its .md file). The closest a browser app can get to
// "reveal in Finder" — neither FSA handles nor OPFS expose absolute paths. Exported for
// buildCardMenu (float-bar.ts), shared by the kebab menu and this file's own right-click menu.
export function copyFilePath(n: MindNode): void {
  const path = n.file; if (!path) return;
  navigator.clipboard.writeText(path)
    .then(() => setStatus(`Copied “${path}”`))
    .catch(() => setStatus('Couldn’t copy path'));
}

// The right-click itself never changes the selection or opens an editor — the clicked card is
// only the menu's TARGET; buildCardMenu (float-bar.ts) handles single-vs-multi/read-only itself
// and is shared verbatim with the kebab menu so the two never drift apart.

// ---------- image entries (right-click on an <img> inside a card body) ----------
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Remove the image's markdown reference from the card body; if that was the last reference to a
// vault-local attachment anywhere in the map, queue the file itself for deletion on the next save
// (same mechanism deleting a whole card uses for its file).
function removeImage(n: MindNode, path: string): void {
  if (state.readOnly || !path) return;
  const re = new RegExp(`[ \\t]*!\\[[^\\]]*\\]\\(\\s*${escRe(path)}\\s*\\)[ \\t]*\\n?`);
  record([n.id], () => {
    n.body = n.body.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
    n.dirty = true;
  });
  if (ui.bodyEdit && ui.bodyEdit.id === n.id) ui.bodyEdit.ta.value = n.body;   // sync an open in-card editor
  if (path.startsWith('attachments/') && ![...state.nodes.values()].some(m => m.body.includes(path)))
    state.toDelete.push(path);
  applyLayouts(); paintAll(); scheduleSave();
  setStatus('Image removed');
}
// Copy the bitmap to the clipboard. Browsers only accept PNG ClipboardItems, so anything else is
// re-encoded via a canvas first. Remote CORS-tainted images fail → status message.
async function copyImage(img: HTMLImageElement): Promise<void> {
  try {
    let blob = await (await fetch(img.src)).blob();
    if (blob.type !== 'image/png'){
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d')!.drawImage(bmp, 0, 0);
      blob = await new Promise<Blob>((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('encode failed')), 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus('Image copied');
  } catch { setStatus('Couldn’t copy image'); }
}
// Body images are pointer-events:none (clicks/drags fall through to the card), so a right-click
// never has the <img> as its target — find the image under the cursor geometrically instead.
function imageAt(cardEl: HTMLElement, x: number, y: number): HTMLImageElement | null {
  for (const img of cardEl.querySelectorAll<HTMLImageElement>('img.md-img')){
    const r = img.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return img;
  }
  return null;
}
// Open the image in its own tab. Navigating straight to the blob URL shows raw bytes when the
// page runs in a null-origin context (blob:null), so instead we open a blank tab and embed the
// image as a data: URL — data URLs render in an <img> regardless of origin. The tab must be
// opened SYNCHRONOUSLY in the click (pop-up blockers), the data URL streams in afterwards.
function showImageInTab(img: HTMLImageElement): void {
  const w = window.open('', '_blank');
  if (!w){ setStatus('Pop-up blocked'); return; }
  (async () => {
    const blob = typedImageBlob(await (await fetch(img.src)).blob(), img.dataset.path ?? '');
    const dataUrl = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string); fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
    w.document.write(`<!doctype html><title>${esc(img.alt || img.dataset.path || 'Image')}</title>` +
      `<style>html,body{margin:0;height:100%;background:#111;display:grid;place-items:center}` +
      `img{max-width:100%;max-height:100%}</style><img src="${dataUrl}">`);
    w.document.close();
  })().catch(() => { w.close(); setStatus('Couldn’t open image'); });
}
function openMenuAt(sx: number, sy: number): void {
  menu.classList.add('open');
  // clamp inside the viewport (measure only after .open makes it displayable)
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(sx, window.innerWidth - mw - 4) + 'px';
  menu.style.top  = Math.min(sy, window.innerHeight - mh - 4) + 'px';
}

function imageMenuEntries(n: MindNode, img: HTMLImageElement): MenuEntry[] {
  const path = img.dataset.path ?? '';
  const loaded = !!img.src && !img.classList.contains('md-img-missing');
  const entries: MenuEntry[] = [];
  if (!state.readOnly) entries.push({ label:'Remove image', run: () => removeImage(n, path), disabled: !path });
  entries.push({ label:'Copy image', run: () => { void copyImage(img); }, disabled: !loaded });
  entries.push({ label:'Show image in new tab', run: () => showImageInTab(img), disabled: !loaded });
  entries.push('sep');
  return entries;
}

function canvasMenuEntries(sx: number, sy: number): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (!state.readOnly){
    const p = screenToWorld(sx, sy);
    entries.push({ label:'New card here', shortcut:'Space', run: () => createNode({ x: p.x - 100, y: p.y - 32 }) });
    entries.push({ label:'Paste', shortcut:'⌘V', run: () => { void pasteFromClipboard(sx, sy, null); } });
    entries.push('sep');
  }
  entries.push({ label:'Fit view', shortcut:'F', run: () => fit(), disabled: !state.nodes.size });
  return entries;
}

document.addEventListener('contextmenu', (e: MouseEvent) => {
  const t = e.target as Element | null;
  closeMenu();
  if (!t || !t.closest('#stage')) return;                 // toolbar / sidebar / dialogs: native menu
  // an active in-place editor keeps the native menu (spellcheck, copy/paste)
  if (ui.inlineEdit && t.closest('.title.editing')) return;
  if (ui.bodyEdit && (t === ui.bodyEdit.ta || ui.bodyEdit.ta.contains(t))) return;
  e.preventDefault();
  const nodeEl = t.closest('.node[data-id]') as HTMLElement | null;
  const id = nodeEl?.dataset.id;
  const n = id ? state.nodes.get(id) : undefined;
  let entries: MenuEntry[];
  if (n){
    const img = imageAt(nodeEl!, e.clientX, e.clientY);
    // image entries above the card's own; same list the kebab menu shows for this card
    entries = [...(img ? imageMenuEntries(n, img) : []), ...buildCardMenu(n, e.clientX, e.clientY)];
  } else {
    entries = canvasMenuEntries(e.clientX, e.clientY);
  }
  openMenu(entries, e.clientX, e.clientY);
});

// dismiss: click/tap anywhere outside, Escape (before the global deselect handler), scroll/zoom, blur
document.addEventListener('pointerdown', (e) => {
  if (menu.classList.contains('open') && !menu.contains(e.target as Node)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menu.classList.contains('open')){
    e.preventDefault(); e.stopPropagation(); closeMenu();
  }
}, true);
stage.addEventListener('wheel', closeMenu, { passive: true });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
