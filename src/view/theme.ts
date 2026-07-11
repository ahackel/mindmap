// ---------- theme (light / dark) ----------
// Persisted in localStorage, driven by CSS variables defined at the top of <style>.
// Icons are .svg assets imported as raw strings (Vite inlines them in the single-file build).
import moonIcon from '../assets/icons/moon.svg?raw';
import sunIcon from '../assets/icons/sun.svg?raw';
import { refreshPalette } from '../main.js';

const THEME_KEY = 'mindmap.theme';
let themeBtn: HTMLElement | null = null;   // cached at setupTheme; applyTheme only runs after that
// iOS Safari colours the status-bar / URL-bar area from <meta name="theme-color">, not from any
// CSS — without this it stays whatever was in index.html regardless of theme, a visible mismatch
// with the canvas behind it. Read --bg straight off the (already-toggled) body so this can never
// drift from the actual canvas colour defined in styles.css.
function syncThemeColorMeta(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  if (meta && bg) meta.setAttribute('content', bg);
}
function applyTheme(theme: string): void {
  const light = theme === 'light';
  document.body.classList.toggle('light', light);
  if (themeBtn) themeBtn.innerHTML = light ? sunIcon : moonIcon;   // icon = the ACTIVE theme
  syncThemeColorMeta();
}
function initTheme(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  // fall back to the OS preference the first time
  if (!saved) saved = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(saved);   // runs before main.ts's own top-level code (PALETTE etc.), so it must NOT
                        // touch refreshPalette — SWATCH_BG picks up the class via document.body anyway
}
function toggleTheme(): void {
  const next = document.body.classList.contains('light') ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  refreshPalette();   // --pal-* differ between themes; re-read the hexes and repaint (safe post-boot)
}
// Wire the toolbar button and apply the saved/OS theme. Called once at startup.
export function setupTheme(): void {
  themeBtn = document.getElementById('themeBtn');
  if (themeBtn) themeBtn.onclick = toggleTheme;
  initTheme();
}
