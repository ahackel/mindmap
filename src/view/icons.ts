// ---------- UI icons ----------
// All icons live as .svg files under assets/icons and are loaded as raw strings (Vite
// inlines them in the single-file build). Markup in index.html carries a placeholder
// `<span class="ic" data-icon="NAME">`; mountIcons() fills each with its SVG. Adding an
// icon = drop a NAME.svg in assets/icons + a data-icon="NAME" placeholder. (The theme
// toggle swaps its own moon/sun icon dynamically — see theme.ts — so it has no placeholder.)
const modules = import.meta.glob('../assets/icons/*.svg', { query: '?raw', eager: true, import: 'default' });

const ICONS: Record<string, string> = {};
for (const [path, svg] of Object.entries(modules)) {
  const name = path.split('/').pop()!.replace(/\.svg$/, '');
  ICONS[name] = svg as string;
}

export function mountIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (name && ICONS[name]) el.innerHTML = ICONS[name];
  });
}
