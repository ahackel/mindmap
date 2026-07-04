// ---------- inline image resolution ----------
// Cards re-render their whole body on every paint, so the <img>s are recreated constantly.
// We resolve each referenced path to a URL ONCE and cache it: vault paths become blob URLs read
// from the active store, remote/data URLs map to themselves. A card that grows when an image
// finally loads triggers a single debounced relayout so siblings/edges re-settle.
// (store/applyLayouts/paintAll come from main.js — a runtime-only cycle.)
import { paintAll } from '../main.js';
import { applyLayouts } from '../view/layout.js';
import { store } from '../data/persistence.js';

const imgUrlCache = new Map<string, string>();    // src path -> resolved URL (blob:… or the original remote/data URL)
const imgInflight = new Map<string, Promise<string | null>>();    // src path -> in-flight read (de-dupes concurrent reads)
export function resetImageCache(): void {
  for (const url of imgUrlCache.values()) if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
  imgUrlCache.clear(); imgInflight.clear();
}
// Store blobs often come back untyped (OPFS getFile() has no MIME) — give them their real image
// type from the extension, so the blob URL renders as an image when opened in its own tab too.
const EXT_MIME: Record<string, string> = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
  webp:'image/webp', svg:'image/svg+xml', avif:'image/avif', bmp:'image/bmp' };
export function typedImageBlob(blob: Blob, path: string): Blob {
  if (blob.type && blob.type !== 'application/octet-stream') return blob;
  const mime = EXT_MIME[(path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()];
  return mime ? new Blob([blob], { type: mime }) : blob;
}
function loadImgUrl(path: string): Promise<string | null> {
  if (imgUrlCache.has(path)) return Promise.resolve(imgUrlCache.get(path)!);
  if (/^(https?:|data:)/i.test(path)){ imgUrlCache.set(path, path); return Promise.resolve(path); }
  if (imgInflight.has(path)) return imgInflight.get(path)!;
  const p = (async () => {
    const raw = store.readBlob ? await store.readBlob(path) : null;
    const blob = raw ? typedImageBlob(raw, path) : null;
    const url = blob ? URL.createObjectURL(blob) : null;
    if (url) imgUrlCache.set(path, url);
    imgInflight.delete(path);
    return url;
  })();
  imgInflight.set(path, p);
  return p;
}
let imgRelayoutTimer: number | undefined;
function scheduleImgRelayout(): void {
  clearTimeout(imgRelayoutTimer);
  imgRelayoutTimer = setTimeout(() => { applyLayouts(); paintAll(); }, 60);
}
export function hydrateImages(el: ParentNode): void {
  el.querySelectorAll<HTMLImageElement>('img.md-img[data-img-src]').forEach(img => {
    const path = img.getAttribute('data-img-src');
    if (!path) return;
    img.removeAttribute('data-img-src');                 // claim it so repaints don't re-trigger
    if (imgUrlCache.has(path)){ img.src = imgUrlCache.get(path)!; return; }   // known → set, no relayout
    loadImgUrl(path).then(url => {
      if (!url){ img.classList.add('md-img-missing'); img.alt = '⚠ ' + (img.alt || path); return; }
      img.addEventListener('load',  scheduleImgRelayout, { once:true });     // first real load reflows once
      img.addEventListener('error', () => img.classList.add('md-img-missing'), { once:true });
      img.src = url;
    });
  });
}
