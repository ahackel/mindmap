// ---------- background grid (none / dot / line) ----------
// A cosmetic overlay behind the cards — see index.html: an SVG <rect> filled with a <pattern>
// that lives INSIDE #world, so it inherits the same pan/zoom transform as everything else and
// never needs its own position/scale math. The pattern cell is 20 world units (GRID_SNAP in
// main.ts), so it lines up with where dragged cards snap to.
// Persisted per-map in settings.json (data/persistence.ts) — not localStorage, since it's a
// property of the map/vault, like the sketch layer, and should travel with it.
import gridOffIcon from '../assets/icons/grid-off.svg?raw';
import gridDotIcon from '../assets/icons/grid-dot.svg?raw';
import gridLineIcon from '../assets/icons/grid-line.svg?raw';
import { state, type GridStyle } from '../core/state.js';
import { scheduleSaveSettings } from '../data/persistence.js';

const GRID_STYLES: GridStyle[] = ['none', 'dot', 'line'];
const GRID_ICONS: Record<GridStyle, string> = { none: gridOffIcon, dot: gridDotIcon, line: gridLineIcon };

let gridBtn: HTMLElement | null = null;

// Reflects state.gridStyle onto the toolbar button (icon + title) and the SVG rect's fill.
// Called after a fresh map load (settings.json may have just changed it) and after each toggle.
export function refreshGrid(): void {
  if (gridBtn) { gridBtn.innerHTML = GRID_ICONS[state.gridStyle]; gridBtn.title = `Background grid: ${state.gridStyle} — click to cycle`; }
  const rect = document.getElementById('gridRect');
  if (rect) rect.setAttribute('fill', state.gridStyle === 'none' ? 'none' : `url(#grid${state.gridStyle === 'dot' ? 'Dot' : 'Line'}Pat)`);
}

function cycleGridStyle(): void {
  const i = GRID_STYLES.indexOf(state.gridStyle);
  state.gridStyle = GRID_STYLES[(i + 1) % GRID_STYLES.length];
  refreshGrid();
  scheduleSaveSettings();
}

// Wires the toolbar button. Called once at startup; the initial paint happens once the first
// map's settings.json has loaded (loadFromDir calls refreshGrid()).
export function setupGrid(): void {
  gridBtn = document.getElementById('gridBtn');
  if (gridBtn) gridBtn.onclick = cycleGridStyle;
}
