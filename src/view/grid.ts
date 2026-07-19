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
import { state, type GridStyle, type GridSize } from '../core/state.js';
import { scheduleSaveSettings } from '../data/persistence.js';
import { openMenu } from '../features/context-menu.js';

const GRID_STYLES: GridStyle[] = ['none', 'dot', 'line'];
const GRID_ICONS: Record<GridStyle, string> = { none: gridOffIcon, dot: gridDotIcon, line: gridLineIcon };
const GRID_SIZES: GridSize[] = [0, 20, 40, 80, 160, 320];

let gridBtn: HTMLElement | null = null;
let gridSizeBtn: HTMLElement | null = null;
const svgGrid = document.getElementById('grid');

// Below this on-screen cell size (px) the grid is fully hidden; at/above the upper bound it's
// fully opaque, with a linear fade between. This is what keeps a dense/zoomed-out grid from ever
// getting fine enough to moiré/shimmer in the first place, and doubles as "fade out far out".
const GRID_FADE_MIN = 6, GRID_FADE_MAX = 16;
// Called on every pan/zoom (view/camera.ts applyView) as well as after a style/size change —
// cheap (one opacity write, no layout) so it's fine to run on every frame of a zoom gesture.
export function updateGridZoom(): void {
  if (!svgGrid || !state.gridSize) return;
  const cellPx = state.gridSize * state.view.k;
  const t = (cellPx - GRID_FADE_MIN) / (GRID_FADE_MAX - GRID_FADE_MIN);
  svgGrid.style.opacity = String(Math.max(0, Math.min(1, t)));
}

// Reflects state.gridStyle/gridSize onto the toolbar buttons (icon + title/label) and the SVG
// pattern's fill/cell size. Called after a fresh map load (settings.json may have just changed
// it) and after each toggle/pick.
export function refreshGrid(): void {
  if (gridBtn) { gridBtn.innerHTML = GRID_ICONS[state.gridStyle]; gridBtn.title = `Background grid: ${state.gridStyle} — click to cycle`; }
  if (gridSizeBtn) { gridSizeBtn.textContent = String(state.gridSize); gridSizeBtn.title = `Grid size: ${state.gridSize} — click to choose`; }
  const rect = document.getElementById('gridRect');
  const showGrid = state.gridStyle !== 'none' && state.gridSize > 0;
  if (rect) rect.setAttribute('fill', showGrid ? `url(#grid${state.gridStyle === 'dot' ? 'Dot' : 'Line'}Pat)` : 'none');
  for (const id of ['gridDotPat', 'gridLinePat']){
    const pat = document.getElementById(id);
    if (pat) { pat.setAttribute('width', String(state.gridSize || 20)); pat.setAttribute('height', String(state.gridSize || 20)); }
  }
  const linePath = document.querySelector('#gridLinePat path');
  if (linePath) linePath.setAttribute('d', `M ${state.gridSize || 20} 0 L 0 0 0 ${state.gridSize || 20}`);
  updateGridZoom();
}

function cycleGridStyle(): void {
  const i = GRID_STYLES.indexOf(state.gridStyle);
  state.gridStyle = GRID_STYLES[(i + 1) % GRID_STYLES.length];
  refreshGrid();
  scheduleSaveSettings();
}

function pickGridSize(size: GridSize): void {
  state.gridSize = size;
  refreshGrid();
  scheduleSaveSettings();
}

// Wires the toolbar buttons. Called once at startup; the initial paint happens once the first
// map's settings.json has loaded (loadFromDir calls refreshGrid()).
export function setupGrid(): void {
  gridBtn = document.getElementById('gridBtn');
  if (gridBtn) gridBtn.onclick = cycleGridStyle;
  gridSizeBtn = document.getElementById('gridSizeBtn');
  if (gridSizeBtn){
    gridSizeBtn.onclick = (e) => {
      e.stopPropagation();
      const r = gridSizeBtn!.getBoundingClientRect();
      // sy is clamped to fit above the viewport bottom (see openMenuAt in context-menu.ts), so
      // passing the button's own top edge naturally pushes the menu up from this bottom-corner button.
      openMenu(GRID_SIZES.map(size => ({
        label: String(size), run: () => pickGridSize(size),
      })), r.left, r.top);
    };
  }
}
