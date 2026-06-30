// ---------- theme (light / dark) ----------
// Persisted in localStorage, driven by CSS variables defined at the top of <style>.
// Icons are .svg assets imported as raw strings (Vite inlines them in the single-file build).
import moonIcon from '../assets/icons/moon.svg?raw';
import sunIcon from '../assets/icons/sun.svg?raw';

const THEME_KEY = 'mindmap.theme';
let themeBtn: HTMLElement | null = null;   // cached at setupTheme; applyTheme only runs after that
function applyTheme(theme: string): void {
  const light = theme === 'light';
  document.body.classList.toggle('light', light);
  if (themeBtn) themeBtn.innerHTML = light ? moonIcon : sunIcon;   // icon = the mode you'd switch TO
}
function initTheme(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  // fall back to the OS preference the first time
  if (!saved) saved = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(saved);
}
function toggleTheme(): void {
  const next = document.body.classList.contains('light') ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch {}
}
// Wire the toolbar button and apply the saved/OS theme. Called once at startup.
export function setupTheme(): void {
  themeBtn = document.getElementById('themeBtn');
  if (themeBtn) themeBtn.onclick = toggleTheme;
  initTheme();
}
