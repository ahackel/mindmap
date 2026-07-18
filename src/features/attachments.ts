// ---------- image attachments ----------
// Images are real files in the vault's attachments/ folder; the note just gets ![alt](attachments/…).
// Added by pasting into the in-card body editor, dropping a file on a card (or the editor), or by
// typing the markdown. Importing this module registers the document-level drag/drop listeners.
import { state, setStatus, isImageCard } from '../core/state.js';
import { isLockedEffective } from '../utils/model.js';
import { ui, isTypingInField } from '../core/ui-state.js';
import { store, scheduleSave } from '../data/persistence.js';
import { applyLayouts } from '../view/layout.js';
import { screenToWorld } from '../view/camera.js';
import { paintAll, selectNode, IMAGE_W, IMAGE_H } from '../main.js';
import { createNode, uniqueTitle, newCardTitle } from './crud.js';
import { autosizeBody } from './inline-edit.js';
import { touch, record } from './history.js';
import { tryPasteCards, cardsToPayload } from './clipboard.js';
import { isFrame } from '../view/layout.js';

const IMG_EXT: Record<string, string> = { 'image/png':'.png', 'image/jpeg':'.jpg', 'image/gif':'.gif', 'image/webp':'.webp',
                  'image/svg+xml':'.svg', 'image/avif':'.avif', 'image/bmp':'.bmp' };
function imgExt(file: File): string {
  const m = (file.name || '').match(/\.[a-z0-9]+$/i);
  return m ? m[0].toLowerCase() : (IMG_EXT[file.type] || '.png');
}
const isImageFile = (f: File): boolean => !!f && !!f.type && f.type.startsWith('image/');
// Pull just the image files out of a FileList / array (paste, drop, drag all hand us a mix).
const imageFiles = (src: FileList | File[] | null | undefined): File[] => [...(src || [])].filter(isImageFile);
const addedMsg = (n: number): string => `Added ${n} image${n === 1 ? '' : 's'}`;
const dragHasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
// Write one image file into attachments/ under a collision-proof name; return its vault path.
async function storeImage(file: File): Promise<string> {
  const name = 'img-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + imgExt(file);
  const path = 'attachments/' + name;
  await store.write(path, file);          // a Blob writes straight through createWritable
  state.lastSelfWrite = Date.now();        // our own write — don't let focus-reload react to it
  return path;
}
// The image's natural pixel size, used to give a fresh image card the same aspect ratio as its
// image instead of the generic IMAGE_W×IMAGE_H box. Falls back to that default box if decoding fails
// (e.g. an unsupported format) — the card still gets created, just without a matched aspect ratio.
async function imageSize(file: File): Promise<{ w: number; h: number }> {
  try {
    const bmp = await createImageBitmap(file);
    const { width: w, height: h } = bmp;
    bmp.close();
    if (w > 0 && h > 0) return { w, h };
  } catch { /* fall through to default */ }
  return { w: IMAGE_W, h: IMAGE_H };
}
// Fit a natural image size into a card box: keep the image's aspect ratio, capped to IMAGE_W so a
// huge photo doesn't land as an oversized card (it can still be resized up afterwards).
function imageCardSize(size: { w: number; h: number }): { w: number; h: number } {
  const w = Math.min(IMAGE_W, size.w);
  const h = w * (size.h / size.w);
  return { w: Math.round(w), h: Math.round(h) };
}
// Strip the extension (and any path separators, for names that came in as a full path) from a
// file's name to use as markdown alt text / an image card's title. Shared by markdownForImages
// and createImageCards so the two paths can't drift.
function altFromFile(f: File): string {
  return (f.name || 'image').replace(/\.[^.]*$/, '').replace(/[/\\]/g, '-').trim() || 'image';
}
// Store each image, returning the markdown that references them (one per line).
async function markdownForImages(files: File[]): Promise<string> {
  const out: string[] = [];
  for (const f of files){
    const path = await storeImage(f);
    out.push(`![${altFromFile(f)}](${path})`);
  }
  return out.join('\n');
}
function canAttach(): boolean {
  if (state.readOnly){ setStatus('Read-only — can’t add images'); return false; }
  if (!store.isOpen){ setStatus('Open a folder to add images'); return false; }
  return true;
}
// Append images to the end of a card's body (used by drops onto a card).
async function appendImagesToNode(id: string, files: FileList | File[]): Promise<void> {
  const imgs = imageFiles(files);
  if (!imgs.length || !canAttach()) return;
  const n = state.nodes.get(id); if (!n) return;
  if (isLockedEffective(n)) { setStatus('Locked — can’t add images'); return; }
  setStatus('Adding image…');
  const md = await markdownForImages(imgs);
  record([id], () => {
    n.body = (n.body && n.body.trim()) ? n.body.replace(/\s*$/, '') + '\n\n' + md : md;
    n.dirty = true;
  });
  if (ui.bodyEdit && ui.bodyEdit.id === id) ui.bodyEdit.ta.value = n.body;   // sync an open in-card editor
  paintAll(); applyLayouts(); paintAll(); scheduleSave();
  setStatus(addedMsg(imgs.length));
}
// Insert images at the caret in the in-card body editor (used by paste / drop onto it).
async function insertImagesAtCursor(files: FileList | File[]): Promise<void> {
  const imgs = imageFiles(files);
  if (!imgs.length || !canAttach()) return;
  if (!ui.bodyEdit){ return; }                          // only meaningful while editing a body in place
  const n = state.nodes.get(ui.bodyEdit.id); if (!n) return;
  const ta = ui.bodyEdit.ta;
  touch(n.id);   // inside an open body-edit session — merges into (and commits with) that step
  setStatus('Adding image…');
  const md = await markdownForImages(imgs);
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const ins = (s > 0 && v[s-1] !== '\n' ? '\n' : '') + md + '\n';
  ta.value = v.slice(0, s) + ins + v.slice(e);
  ta.selectionStart = ta.selectionEnd = s + ins.length;
  autosizeBody(ta);
  n.body = ta.value; n.dirty = true;
  applyLayouts(); paintAll(); scheduleSave();        // reflow; the editing textarea is preserved
  setStatus(addedMsg(imgs.length));
}

// Make one IMAGE CARD per file — a resizable leaf that shows nothing but that image (see
// isImageBox in main.ts). No title/body UI, no rename prompt; its file is named after the image
// (deduped by uniqueTitle) purely so it has a valid, stable filename on disk — the name itself is
// never shown or editable. Shared by a canvas/card drop AND a clipboard paste (⌘V or the context
// menu's Paste) — both land an image as a card of its own rather than inline body markdown.
async function createImageCards(imgs: File[], sx: number | null, sy: number | null, parent: string | null): Promise<void> {
  if (!imgs.length || !canAttach()) return;
  setStatus('Adding image…');
  const p = sx != null && sy != null ? screenToWorld(sx, sy) : screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  let i = 0;
  for (const f of imgs){
    const [path, natural] = await Promise.all([storeImage(f), imageSize(f)]);
    const alt = altFromFile(f);
    const { w, h } = imageCardSize(natural);
    createNode({
      x: p.x - w / 2 + i * 24, y: p.y - h / 2 + i * 24,
      parent, title: uniqueTitle(alt), body: `![${alt}](${path})`,
      type: 'image', color: 'none', w, h, edit: false,
    });
    i++;
  }
  setStatus(addedMsg(imgs.length));
}
// Drop on empty canvas (or onto an existing image card): new image card(s) at the drop point.
async function createImageNode(sx: number, sy: number, files: File[]): Promise<void> {
  await createImageCards(imageFiles(files), sx, sy, null);
}

// Paste an image straight into the in-card body editor (bound per-textarea in startBodyEdit).
export function onBodyPaste(e: ClipboardEvent): void {
  const imgs = imageFiles(e.clipboardData?.files);
  if (imgs.length){ e.preventDefault(); insertImagesAtCursor(imgs); }
}

// ---------- file-picker fallback (iOS/iPadOS: no OS drag-drop, clipboard image-paste is flaky) ----------
// A hidden <input type="file"> is the one attach mechanism every mobile browser supports — on iOS it
// opens the Photos library / Camera / Files share sheet. Routes into the exact same storage/rendering
// pipeline as paste and drop; menu entries in float-bar.ts / context-menu.ts trigger it.
type PickTarget =
  | { kind: 'node'; id: string }
  | { kind: 'new'; sx: number | null; sy: number | null; parent: string | null };
let pickTarget: PickTarget | null = null;
const filePicker = document.createElement('input');
filePicker.type = 'file'; filePicker.accept = 'image/*'; filePicker.multiple = true;
filePicker.style.display = 'none';
document.body.appendChild(filePicker);
filePicker.addEventListener('change', () => {
  const files = imageFiles(filePicker.files);
  filePicker.value = '';                              // allow re-picking the same file next time
  const req = pickTarget; pickTarget = null;
  if (!req || !files.length) return;
  if (req.kind === 'node'){
    // mirrors the drop-on-editor vs drop-on-card branching in the drop listener below
    void (ui.bodyEdit && ui.bodyEdit.id === req.id ? insertImagesAtCursor(files) : appendImagesToNode(req.id, files));
  } else {
    void createImageCards(files, req.sx, req.sy, req.parent);
  }
});
// Insert into (if its body editor is open) or append to an existing card.
export function pickImagesForNode(id: string): void {
  if (!canAttach()) return;
  pickTarget = { kind: 'node', id };
  filePicker.click();                                 // must fire synchronously from the user gesture (Safari)
}
// Drop a new image card at a canvas point.
export function pickImagesAt(sx: number | null, sy: number | null, parent: string | null): void {
  if (!canAttach()) return;
  pickTarget = { kind: 'new', sx, sy, parent };
  filePicker.click();
}

// ---------- global paste = new card ----------
// ⌘V outside any text field (or the context menu's Paste) makes a card from the clipboard — text
// (first non-empty line becomes the title, the rest the body) or image files. It lands at the
// given screen point (⌘V: the mouse position, viewport centre before the mouse ever moved); with
// a parent it becomes that card's CHILD. Created as-is — no rename editor opens.
function cardOptsAt(sx: number | null, sy: number | null, parent: string | null):
    { x?: number; y?: number; parent: string | null; edit: false } {
  if (parent){
    const pn = state.nodes.get(parent);
    if (pn?.collapsed){ touch(parent); pn.collapsed = false; }   // reveal so the new child is visible
  }
  const p = sx != null && sy != null ? screenToWorld(sx, sy) : null;
  return { ...(p ? { x: p.x - 100, y: p.y - 32 } : {}), parent, edit: false };
}
// Does this URL load as an image? <img> load/error fires cross-origin without CORS headers.
function probeImage(url: string): Promise<boolean> {
  return new Promise(res => {
    const im = new Image();
    const done = (ok: boolean) => { clearTimeout(t); res(ok); };
    const t = setTimeout(() => done(false), 8000);   // offline/hanging host → stay a link
    im.onload = () => done(true);
    im.onerror = () => done(false);
    im.src = url;
  });
}
// Make the card from whatever the clipboard held. Titles are filenames: no slashes, kept short, unique.
// `sx`/`sy` are the raw screen point (same one `opts` was built from) — images want it centred on
// an image-card-sized box, not the text-card offset baked into `opts.x`/`opts.y`.
function createCardFromClipboard(imgs: File[], text: string, sx: number | null, sy: number | null, opts: ReturnType<typeof cardOptsAt>): void {
  if (imgs.length){ void createImageCards(imgs, sx, sy, opts.parent); return; }
  // A lone URL isn't a name — it goes into the BODY (image URLs as an inline image, others as a
  // link, both handled by the markdown renderer) and the card gets a standard fresh-card title.
  // Many image URLs carry no file extension (CDNs), so those are pasted as a link first and
  // probed in the background: if the URL actually loads as an image, the link upgrades to ![](…).
  if (/^https?:\/\/\S+$/i.test(text)){
    const isImg = /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?\S*)?$/i.test(text);
    const n = createNode({ ...opts, title: newCardTitle(), body: isImg ? `![](${text})` : text });
    if (n) setStatus(isImg ? 'Pasted image link' : 'Pasted link');
    if (n && !isImg) void probeImage(text).then(ok => {
      const cur = state.nodes.get(n.id);
      if (!ok || !cur || cur.body !== text) return;   // gone or edited meanwhile → leave it alone
      record([cur.id], () => { cur.body = `![](${text})`; cur.dirty = true; });
      applyLayouts(); paintAll(); scheduleSave();
      setStatus('Pasted image link');
    });
    return;
  }
  const lines = text.split('\n');
  let ti = lines.findIndex(l => l.trim()); if (ti < 0) ti = 0;
  const title = lines[ti].replace(/^\s*(#{1,6}|[-*+]|>|\d+\.)\s*/, '').replace(/[/\\]/g, '-').trim().slice(0, 80);
  const body = lines.slice(ti + 1).join('\n').trim();
  const n = createNode({ ...opts, title: title ? uniqueTitle(title) : newCardTitle(), body });
  if (n) setStatus(`Pasted “${n.title}”`);
}
document.addEventListener('paste', (e) => {
  if (isTypingInField()) return;                 // field/editor pastes keep their native behaviour
  if (state.readOnly){ setStatus('Read-only — can’t paste'); return; }
  const cd = e.clipboardData; if (!cd) return;
  const imgs = imageFiles(cd.files);
  const text = cd.getData('text/plain').trim();
  if (!imgs.length && !text) return;
  e.preventDefault();
  // copied CARDS (our own marker format) reconstruct as cards; anything else becomes a new card
  if (text && tryPasteCards(text, { sx: ui.lastMouse?.x ?? null, sy: ui.lastMouse?.y ?? null, parent: state.selId })) return;
  const mx = ui.lastMouse?.x ?? null, my = ui.lastMouse?.y ?? null;
  createCardFromClipboard(imgs, text, mx, my, cardOptsAt(mx, my, state.selId));
});
// Context-menu Paste: no ClipboardEvent to read from, so ask the async clipboard API (may prompt
// for permission; Safari requires it be called directly in the user gesture — a menu click is one).
export async function pasteFromClipboard(sx: number, sy: number, parent: string | null): Promise<void> {
  if (state.readOnly){ setStatus('Read-only — can’t paste'); return; }
  const imgs: File[] = []; let text = '';
  try {
    const items = await navigator.clipboard.read();
    for (const it of items){
      const imgType = it.types.find(t => t.startsWith('image/'));
      if (imgType) imgs.push(new File([await it.getType(imgType)], 'pasted' + (IMG_EXT[imgType] || '.png'), { type: imgType }));
      else if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
    }
  } catch {
    try { text = await navigator.clipboard.readText(); }        // read() unsupported → text-only fallback
    catch { setStatus('Clipboard not available'); return; }
  }
  text = text.trim();
  if (!imgs.length && !text){ setStatus('Clipboard is empty'); return; }
  if (text && tryPasteCards(text, { sx, sy, parent })) return;   // copied cards reconstruct as cards
  createCardFromClipboard(imgs, text, sx, sy, cardOptsAt(sx, sy, parent));
}

// Drag an image file from the OS onto a card (or the body editor). We handle this at the document
// level so we can both highlight the target and stop the browser from navigating to the dropped file.
let imgDropTarget: Element | null = null;   // the element currently showing the .img-drop hint
function setImgDropTarget(el: Element | null): void {
  if (imgDropTarget === el) return;
  imgDropTarget?.classList.remove('img-drop');
  imgDropTarget = el;
  imgDropTarget?.classList.add('img-drop');
}
document.addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  if (state.readOnly){ setImgDropTarget(null); return; }
  const t = e.target as HTMLElement;
  const cardEl = t.closest?.('#world [data-id]') as HTMLElement | null;
  const cardNode = cardEl ? state.nodes.get(cardEl.dataset.id ?? '') : null;
  if (cardNode && isLockedEffective(cardNode)) { setImgDropTarget(null); return; }   // locked: no drop hint
  setImgDropTarget(t.closest?.('.body-edit') || cardEl || null);
});
document.addEventListener('dragleave', (e) => { if (e.relatedTarget == null) setImgDropTarget(null); });
document.addEventListener('drop', async (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  const t = e.target as HTMLElement;
  const onEditor = !!t.closest?.('.body-edit');
  const cardEl   = t.closest?.('#world [data-id]') as HTMLElement | null;
  const cardId   = cardEl?.dataset.id ?? null;
  // an image card is a leaf — it can't adopt children or gain a second image in its body
  const cardNode = cardId ? state.nodes.get(cardId) : null;
  const cardIsImage = !!cardNode && isImageCard(cardNode);
  const cardIsFrame = !!cardNode && isFrame(cardNode);
  const cardIsLocked = !!cardNode && isLockedEffective(cardNode);
  setImgDropTarget(null);
  // dropped .md notes reconstruct as cards (parent links WITHIN the dropped set are kept);
  // a dropped-on card adopts them as children, the canvas takes them at the drop point — never a
  // locked one (createNode itself also refuses a locked parent, this just skips the attempt).
  const mds = [...e.dataTransfer!.files].filter(f => /\.md$/i.test(f.name));
  if (mds.length){
    const cards = await Promise.all(mds.map(async f => ({ name: f.name, text: await f.text() })));
    tryPasteCards(cardsToPayload(cards), { sx: e.clientX, sy: e.clientY, parent: (cardIsImage || cardIsLocked) ? null : cardId });
  }
  const imgs = imageFiles(e.dataTransfer!.files);
  if (!imgs.length) return;
  if (onEditor && ui.bodyEdit){ await insertImagesAtCursor(imgs); }   // drop on the open editor → at the caret
  // a frame is a container, not a text card — its body never renders, so dropped images become
  // new image-card CHILDREN of the frame instead of (invisibly) appending to its hidden body
  else if (cardEl && cardIsFrame && !cardIsLocked){ selectNode(cardId); await createImageCards(imgs, e.clientX, e.clientY, cardId); }
  else if (cardEl && !cardIsImage && !cardIsLocked){ selectNode(cardId); await appendImagesToNode(cardId!, imgs); }
  else if (!cardEl || !cardIsLocked) await createImageNode(e.clientX, e.clientY, imgs);   // empty canvas (or onto an image card) → new card(s) at the drop point
});
