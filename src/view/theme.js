// ---------- theme (light / dark) ----------
// Persisted in localStorage, driven by CSS variables defined at the top of <style>.
const THEME_KEY = 'mindmap.theme';
const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
const ICON_SUN  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
function applyTheme(theme){
  const light = theme === 'light';
  document.body.classList.toggle('light', light);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerHTML = light ? ICON_MOON : ICON_SUN;   // icon = the mode you'd switch TO
}
function initTheme(){
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  // fall back to the OS preference the first time
  if (!saved) saved = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(saved);
}
function toggleTheme(){
  const next = document.body.classList.contains('light') ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch {}
}
// Wire the toolbar button and apply the saved/OS theme. Called once at startup.
export function setupTheme(){
  document.getElementById('themeBtn').onclick = toggleTheme;
  initTheme();
}
