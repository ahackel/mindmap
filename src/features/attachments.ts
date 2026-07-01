// ---------- image attachments ----------
// Images are real files in the vault's attachments/ folder; the note just gets ![alt](attachments/…).
// Added by pasting into the in-card body editor, dropping a file on a card (or the editor), or by
// typing the markdown. Importing this module registers the document-level drag/drop listeners.
import { state, setStatus } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { store, scheduleSave } from '../data/persistence.js';
import { applyLayouts } from '../view/layout.js';
import { paintAll, selectNode } from '../main.js';
import { autosizeBody } from './inline-edit.js';
import { touch, record } from './history.js';

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
// Store each image, returning the markdown that references them (one per line).
async function markdownForImages(files: File[]): Promise<string> {
  const out: string[] = [];
  for (const f of files){
    const path = await storeImage(f);
    const alt = (f.name || 'image').replace(/\.[^.]*$/, '') || 'image';
    out.push(`![${alt}](${path})`);
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

// Paste an image straight into the in-card body editor (bound per-textarea in startBodyEdit).
export function onBodyPaste(e: ClipboardEvent): void {
  const imgs = imageFiles(e.clipboardData?.files);
  if (imgs.length){ e.preventDefault(); insertImagesAtCursor(imgs); }
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
  setImgDropTarget(t.closest?.('.body-edit') || t.closest?.('#world [data-id]') || null);
});
document.addEventListener('dragleave', (e) => { if (e.relatedTarget == null) setImgDropTarget(null); });
document.addEventListener('drop', async (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  const t = e.target as HTMLElement;
  const onEditor = !!t.closest?.('.body-edit');
  const cardEl   = t.closest?.('#world [data-id]') as HTMLElement | null;
  setImgDropTarget(null);
  const imgs = imageFiles(e.dataTransfer!.files);
  if (!imgs.length) return;
  if (onEditor && ui.bodyEdit){ await insertImagesAtCursor(imgs); }   // drop on the open editor → at the caret
  else if (cardEl){ selectNode(cardEl.dataset.id ?? null); await appendImagesToNode(cardEl.dataset.id!, imgs); }
  else if (state.selId){ await appendImagesToNode(state.selId, imgs); }
  else setStatus('Drop an image onto a card to attach it');
});
