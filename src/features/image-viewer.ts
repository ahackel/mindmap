// ---------- full-screen image viewer ----------
// Opened by the magnifier button shown over each image on a selected card (see main.ts nodeEl /
// utils/markdown.ts imgTag). Shows the already-resolved image (its blob/remote URL) centred on a
// dark backdrop; closes on the × button, Escape, or a click on the backdrop outside the image.
let overlay: HTMLElement | null = null;
let imgEl: HTMLImageElement | null = null;

function build(): void {
  overlay = document.createElement('div');
  overlay.id = 'imgViewer';
  overlay.innerHTML = `<button type="button" class="iv-close" aria-label="Close">&times;</button><img class="iv-img" alt="">`;
  imgEl = overlay.querySelector('.iv-img');
  overlay.addEventListener('click', (e) => {
    // click on the backdrop (not the image itself) closes
    if (e.target === overlay || (e.target as HTMLElement).classList.contains('iv-close')) closeImageViewer();
  });
  document.body.appendChild(overlay);
}
function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') closeImageViewer(); }

export function openImageViewer(src: string, alt = ''): void {
  if (!src) return;
  if (!overlay) build();
  imgEl!.src = src; imgEl!.alt = alt;
  overlay!.classList.add('open');
  window.addEventListener('keydown', onKey, true);
}
export function closeImageViewer(): void {
  if (!overlay) return;
  overlay.classList.remove('open');
  if (imgEl) imgEl.removeAttribute('src');
  window.removeEventListener('keydown', onKey, true);
}
