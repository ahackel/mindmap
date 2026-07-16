// ---------- alt-drag an inline image OUT of a card ----------
// Body images are pointer-events:none (clicks/drags fall through to the card), so extraction is
// initiated by bindNodeDrag: an Alt-press whose point sits over a body image on a NON-image card
// starts this gesture instead of a card drag. A floating preview rides the cursor; on drop the
// image either MOVES into the card released on (dashed .drop-merge highlight) or becomes a fresh
// image-only card on empty canvas. Escape / released-nowhere-valid still creates the card at the
// drop point (a canvas drop); pointercancel or a no-move press leaves the card untouched.
import { state, isImageCard, isAnnotation, type MindNode } from '../core/state.js';
import { isFrame } from '../view/layout.js';
import { isLockedEffective } from '../utils/model.js';
import { screenToWorld } from '../view/camera.js';
import { extractImage } from './crud.js';
import { IMAGE_W, IMAGE_H } from '../main.js';

// True while an image-extract gesture is live. A card is natively `draggable` (⌥-drag exports it
// as a .md file, see clipboard.ts bindCardFileDrag) — that native dragstart would otherwise hijack
// this pointer gesture, so the export handler bails while this is set.
let extracting = false;
export function imageExtractInProgress(): boolean { return extracting; }

let hoverEl: Element | null = null;
function setHover(el: Element | null): void {
  if (hoverEl === el) return;
  hoverEl?.classList.remove('drop-merge');
  hoverEl = el;
  hoverEl?.classList.add('drop-merge');
}
// The card under a screen point that this image can MOVE into: a plain body card, never the source,
// an image card, a frame, or an annotation. The floating preview is hidden for the hit-test so it
// never shadows the card beneath it.
function moveTargetAt(x: number, y: number, sourceId: string, preview: HTMLElement): { el: HTMLElement; id: string } | null {
  preview.style.display = 'none';
  const under = document.elementFromPoint(x, y) as HTMLElement | null;
  preview.style.display = '';
  const cardEl = under?.closest('#world [data-id]') as HTMLElement | null;
  const id = cardEl?.dataset.id;
  if (!cardEl || !id || id === sourceId) return null;
  const node = state.nodes.get(id);
  if (!node || isImageCard(node) || isFrame(node) || isAnnotation(node) || isLockedEffective(node)) return null;
  return { el: cardEl, id };
}
export function startImageExtractDrag(source: MindNode, img: HTMLImageElement, sx: number, sy: number): void {
  if (state.readOnly) return;
  const path = img.dataset.path; if (!path) return;
  extracting = true;
  const alt = img.alt || '';
  const nw = img.naturalWidth || IMAGE_W, nh = img.naturalHeight || IMAGE_H;
  const cardW = Math.round(Math.min(IMAGE_W, nw));
  const cardH = Math.round(cardW * (nh / nw)) || IMAGE_H;
  // floating cursor preview (a small thumbnail of the grabbed image)
  const pw = 140, ph = Math.max(40, Math.round(pw * (nh / nw)));
  const preview = document.createElement('div');
  preview.className = 'image-extract-preview';
  preview.style.width = pw + 'px'; preview.style.height = ph + 'px';
  const pimg = document.createElement('img'); pimg.src = img.src; preview.appendChild(pimg);
  document.body.appendChild(preview);
  const place = (x: number, y: number): void => { preview.style.left = (x - pw / 2) + 'px'; preview.style.top = (y - ph / 2) + 'px'; };
  place(sx, sy);
  document.body.classList.add('grabbing');
  let moved = false;
  const cleanup = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey);
    setHover(null); preview.remove();
    document.body.classList.remove('grabbing');
    extracting = false;
  };
  const onMove = (ev: PointerEvent): void => {
    if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true;
    place(ev.clientX, ev.clientY);
    setHover(moveTargetAt(ev.clientX, ev.clientY, source.id, preview)?.el ?? null);
  };
  const onUp = (ev: PointerEvent): void => {
    const t = moveTargetAt(ev.clientX, ev.clientY, source.id, preview);
    cleanup();
    if (!moved) return;                                   // a plain Alt-click on the image: no change
    if (t) extractImage(source.id, path, alt, { toCardId: t.id });
    else { const p = screenToWorld(ev.clientX, ev.clientY); extractImage(source.id, path, alt, { x: p.x - cardW / 2, y: p.y - cardH / 2, w: cardW, h: cardH }); }
  };
  const onCancel = (): void => { cleanup(); };            // interrupted (tab switch, etc.): leave the card as-is
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') cleanup(); };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey);
}
