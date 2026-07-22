// ---------- shared card-property controls (colour / tags / checklist / group background) ----------
// ONE implementation, used by both the canvas floating bar (#floatBar) and the branch-view bottom sheet
// (#branchProps). Given the control elements plus a "which cards am I editing" provider, it wires
// the swatch row, the tags input and the two toggles to the same undo / paint / save contract the
// sidebar always used. Title & body are edited elsewhere (inline editors / branch cards), so this
// deliberately owns only the sidebar-style properties. Layout chips stay in main.ts — they're
// canvas geometry with no meaning in the outline, so the branch sheet doesn't get them.
import { state } from '../core/state.js';
import { isLockedEffective } from '../utils/model.js';
import { record } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, SWATCH_BG, PALETTE } from '../main.js';
import { setTagOnNodes, tagPillHTML } from './tags.js';
import { openEmojiPicker } from './emoji-picker.js';

export interface PropEls {
  colors: HTMLElement;
  tagRow?: HTMLElement;   // omitted where there's no tags UI at all (this factory has no canvas caller — the canvas card renders its own tag row directly, see main.ts)
  checklist: HTMLInputElement;
  bg: HTMLInputElement;
}
export interface PropertyControls {
  sync(): void;            // reflect the current target(s) into the controls
  rebuildSwatches(): void; // re-read the palette hexes (theme switch) and rebuild the swatch row
}

// every live instance, so a theme switch can rebuild all their swatch rows at once (refreshSwatches)
const panels: PropertyControls[] = [];
// Re-read the palette hexes into every instance's swatch row. Called from main.refreshPalette after
// a light/dark switch (the --pal-* values differ per theme).
export function refreshSwatches(): void { for (const p of panels) p.rebuildSwatches(); }

// getIds returns the card ids the controls act on: the whole selection in the sidebar, the single
// active card in the branch sheet. Empty → the controls no-op (nothing selected).
export function createProperties(els: PropEls, getIds: () => string[]): PropertyControls {
  // ---- colour swatches: inherit ('') + palette + explicit none ----
  function rebuildSwatches(): void {
    let html = `<div class="swatch inherit" data-color="" title="inherit colour from parent (default)"></div>`;
    for (const c of PALETTE)
      html += `<div class="swatch" data-color="${c}" title="${c}" style="--sw:${SWATCH_BG[c]}"></div>`;
    html += `<div class="swatch nofill" data-color="none" title="no colour — don’t inherit"></div>`;
    els.colors.innerHTML = html;
    els.colors.querySelectorAll<HTMLElement>('.swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        const ids = getIds().filter(id => !isLockedEffective(state.nodes.get(id)!)); if (!ids.length) return;
        record(ids, () => {
          for (const id of ids){ const n = state.nodes.get(id); if (n){ n.color = sw.dataset.color ?? ''; n.dirty = true; } }
        });
        markSwatch();
        paintAll(); scheduleSave();
      });
    });
  }
  // active swatch = the value shared by every target; mixed (or nothing) → the inherit swatch.
  function markSwatch(): void {
    const colors = new Set(getIds().map(id => state.nodes.get(id)?.color || ''));
    const active = colors.size === 1 ? ([...colors][0] || '') : '';
    els.colors.querySelectorAll<HTMLElement>('.swatch').forEach(sw =>
      sw.classList.toggle('active', sw.dataset.color === active));
  }

  // ---- checklist / group-background toggles (set on every target; mixed → indeterminate) ----
  function setBool(key: 'checklist' | 'bg', on: boolean): void {
    const ids = getIds().filter(id => !isLockedEffective(state.nodes.get(id)!)); if (!ids.length) return;
    record(ids, () => {
      for (const id of ids){ const n = state.nodes.get(id); if (n){ n[key] = on; n.dirty = true; } }
    });
    markToggle(els[key === 'checklist' ? 'checklist' : 'bg'], key);
    paintAll(); scheduleSave();
  }
  function markToggle(el: HTMLInputElement, key: 'checklist' | 'bg'): void {
    const vals = new Set(getIds().map(id => !!state.nodes.get(id)?.[key]));
    el.indeterminate = vals.size > 1;
    el.checked = vals.size === 1 && [...vals][0];
  }
  els.checklist.addEventListener('change', () => setBool('checklist', els.checklist.checked));
  els.bg.addEventListener('change', () => setBool('bg', els.bg.checked));

  // ---- tags: emoji pills + a trailing "+" that opens the shared MRU picker (features/emoji-picker.ts).
  // Tags are per-card, so they only apply to a single target. Optional: this factory is only used
  // by the outline properties sheet — the canvas card renders its own tag row directly (main.ts),
  // matching how the card's own pill click removes a tag instead of going through a shared control.
  function renderTagRow(): void {
    if (!els.tagRow) return;
    const ids = getIds();
    const n = ids.length === 1 ? state.nodes.get(ids[0]) : undefined;
    const tags = n ? n.tags : [];
    els.tagRow.innerHTML = tags.map(t => tagPillHTML(t, ' data-removable')).join('') +
      `<button type="button" class="tag-add-btn" title="Add tag" aria-label="Add tag">+</button>`;
    els.tagRow.querySelectorAll<HTMLElement>('.tag-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        if (!n || isLockedEffective(n)) return;
        setTagOnNodes([n.id], pill.dataset.tag!, false);
        renderTagRow();
      });
    });
    const addBtn = els.tagRow.querySelector<HTMLButtonElement>('.tag-add-btn')!;
    addBtn.addEventListener('click', () => { if (n && !isLockedEffective(n)) openEmojiPicker(addBtn, [n.id], renderTagRow); });
  }

  function sync(): void {
    markSwatch();
    markToggle(els.checklist, 'checklist');
    markToggle(els.bg, 'bg');
    renderTagRow();
  }

  rebuildSwatches();
  const panel = { sync, rebuildSwatches };
  panels.push(panel);
  return panel;
}
