// ---------- tag panel: browse / assign / rename / delete / colour tags ----------
// Tags aren't a first-class entity — there's no registry, just MindNode.tags: string[] round-tripped
// through frontmatter (utils/frontmatter.ts). "All tags" is always a derived scan of state.nodes,
// plus any "phantom" tags typed via the ghost row before a card was selected (see phantomTags
// below) — those live only in memory and are never written to disk.
// A tag's colour (one of the card PALETTE names, main.ts) is encoded directly in the stored
// string as a "-colorName" suffix (e.g. "priority-red") — see parseTag/encodeTag. The suffix is
// stripped everywhere a tag is displayed or matched; only raw reads/writes of MindNode.tags see it.
// This module owns: the corner toggle button + panel (mutually exclusive with sketch mode — see
// setTagPanelOpen / features/sketch.ts's own hook back into it), the panel's tag rows (pill + count
// + kebab-menu rename/colour/delete), the click-toggle-on-selection assignment path (the touch/
// keyboard-friendly primary path), and pointer-based drag-and-drop (assign a panel pill onto a
// card or query card, remove a card's own pill by dragging it onto empty canvas) — modeled on
// features/outline.ts's row drag (startRowDrag) since native HTML5 drag-and-drop doesn't work
// reliably on touch/iPad, and this app's other drag interactions are all pointer-based for exactly
// that reason.
import { state, isQueryCard, setStatus, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { isLockedEffective } from '../utils/model.js';
import { record, touch, commitStep } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { applyLayouts } from '../view/layout.js';
import { paintAll, selectedIds, appendQueryToken, PALETTE } from '../main.js';
import { openMenu } from './context-menu.js';
import { esc } from '../utils/markdown.js';
import { setSketchMode } from './sketch.js';

function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }

// ---- colour encoding: "name-colorName" (colorName must be one of main.ts's PALETTE) ----
// Split on the LAST hyphen so a base name containing its own hyphens (e.g. "in-progress") still
// round-trips correctly; only treated as a colour suffix when it's an exact PALETTE match.
export function parseTag(raw: string): { name: string; color: string | null } {
  const i = raw.lastIndexOf('-');
  if (i > 0) {
    const maybe = raw.slice(i + 1);
    if (PALETTE.includes(maybe)) return { name: raw.slice(0, i), color: maybe };
  }
  return { name: raw, color: null };
}
function encodeTag(name: string, color: string | null): string {
  return color ? `${name}-${color}` : name;
}
// Shared pill markup for both the card-rendered row (main.ts) and this panel's own rows — one
// place owns "how does a tag pill look", so the two can never drift apart. No special-casing for
// short names — .tag-pill's own tight horizontal padding (styles.css) already makes a single
// letter read close to a circle without a separate code path.
export function tagPillHTML(raw: string, extraAttrs = ''): string {
  const { name, color } = parseTag(raw);
  const colored = color ? ` data-color="${color}" style="--sw:var(--pal-${color})"` : '';
  return `<span class="tag-pill" data-tag="${esc(name)}"${colored}${extraAttrs}>${esc(name)}</span>`;
}

// ---- tags with no backing node yet, typed via the ghost row before a card was selected ----
// Purely in-memory (never serialized — a page reload naturally clears it); name -> colour.
// Merged into allTags() below so they show up (count 0) and can be dragged/clicked onto a card
// like any other tag. Dropped once a real node actually carries the name.
const phantomTags = new Map<string, string | null>();

// The colour currently associated with a tag name: a phantom entry if that's all there is,
// otherwise the colour of the first occurrence found among real nodes (occurrences are kept
// consistent by every mutation path in this file, so in practice there's only ever one).
function colorOfName(name: string): string | null {
  const p = phantomTags.get(name);
  if (p) return p;
  for (const n of state.nodes.values())
    for (const raw of n.tags) { const t = parseTag(raw); if (t.name === name && t.color) return t.color; }
  return null;
}

// ---- derived "all tags in use" (scan + phantoms), sorted alphabetically ----
export interface TagInfo { name: string; color: string | null; count: number; }
export function allTags(): TagInfo[] {
  const map = new Map<string, { color: string | null; count: number }>();
  for (const [name, color] of phantomTags) map.set(name, { color, count: 0 });
  for (const n of state.nodes.values()) {
    const namesHere = new Set<string>();
    for (const raw of n.tags) {
      const { name, color } = parseTag(raw);
      namesHere.add(name);
      const cur = map.get(name);
      if (cur) { if (!cur.color && color) cur.color = color; }
      else map.set(name, { color, count: 0 });
    }
    for (const name of namesHere) map.get(name)!.count++;
  }
  return [...map.entries()].map(([name, v]) => ({ name, color: v.color, count: v.count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- open / close, mutually exclusive with sketch mode ----
// Called both from #tagBtn's own click and (symmetrically) from features/sketch.ts's
// setSketchMode when sketch mode is turned on while the tag panel is open — a deliberate two-way
// runtime import cycle between the two modules, evaluated only inside these event handlers, never
// at module-eval time (same style as the main.ts<->feature cycles CLAUDE.md documents).
export function setTagPanelOpen(on: boolean): void {
  ui.tagPanelOn = on;
  document.body.classList.toggle('tagging', on);
  byId('tagBtn').classList.toggle('active', on);
  if (on && ui.sketchOn) setSketchMode(false);
  if (on) renderTagPanel();
}
export function toggleTagPanel(): void { setTagPanelOpen(!ui.tagPanelOn); }

// ---- create a brand-new tag ----
// With a selection, assigns immediately (setTagOnNodes). With none, there's nowhere to persist it
// yet — kept as a phantom entry instead of being lost, so it still shows in the list and can be
// dragged/clicked onto a card later (see phantomTags above).
function createAndAssignTag(raw: string): void {
  const name = raw.trim();
  if (!name) return;
  const ids = selectedIds();
  if (!ids.length) {
    if (!phantomTags.has(name)) phantomTags.set(name, null);
    setStatus(`Added "${name}" — drag it (or select a card and click it) to use it`);
    return;
  }
  setTagOnNodes(ids, name, true);
}

// ---- shared "add/remove tag on a set of node ids" mutation — the one path both the click-toggle
// UI and the drag-assign UI funnel through, so the two always produce identical results. Skips
// locked nodes (like every other per-card mutation, e.g. properties.ts's colour swatch). `name` is
// always the base (colour-stripped) identity; the current colour (if any) is preserved on add. ----
function setTagOnNodes(ids: string[], name: string, on: boolean): void {
  if (state.readOnly) return;
  const targets = ids.filter(id => !isLockedEffective(state.nodes.get(id)!));
  if (!targets.length) return;
  const color = on ? colorOfName(name) : null;
  record(targets, () => {
    for (const id of targets) {
      const n = state.nodes.get(id); if (!n) continue;
      const has = n.tags.some(t => parseTag(t).name === name);
      if (on && !has) n.tags = [...n.tags, encodeTag(name, color)];
      else if (!on && has) n.tags = n.tags.filter(t => parseTag(t).name !== name);
      n.dirty = true;
    }
  });
  if (on) phantomTags.delete(name);   // now backed by a real node — no longer just a phantom
  // paint first so each card's height is current, then reflow (a tag row can change height), then
  // paint again — same triple-paint convention properties.ts's own tags input uses.
  paintAll(); applyLayouts(); paintAll(); scheduleSave(); renderTagPanel();
}

// ---- rename / colour / delete (kebab menu) ----
// Batch-rewrites every node that has `oldName` in its tags — one undo step reverts every touched
// node (history.ts's record() snapshots each node's full pre-image, tags included). Each
// occurrence keeps its OWN existing colour suffix; rename only ever touches the name part.
function renameTag(oldName: string, nextRaw: string): void {
  const newName = nextRaw.trim();
  if (state.readOnly || !newName || newName === oldName) return;
  if (phantomTags.has(oldName)) { const c = phantomTags.get(oldName) ?? null; phantomTags.delete(oldName); phantomTags.set(newName, c); }
  const ids = [...state.nodes.values()].filter(n => n.tags.some(t => parseTag(t).name === oldName)).map(n => n.id);
  if (!ids.length) { renderTagPanel(); setStatus(`Renamed tag "${oldName}" to "${newName}"`); return; }
  record(ids, () => {
    for (const id of ids) {
      const n = state.nodes.get(id); if (!n) continue;
      // dedupe: renaming may collide with a tag the node already has
      n.tags = [...new Set(n.tags.map(t => { const p = parseTag(t); return p.name === oldName ? encodeTag(newName, p.color) : t; }))];
      n.dirty = true;
    }
  });
  paintAll(); applyLayouts(); paintAll(); scheduleSave(); renderTagPanel();
  setStatus(`Renamed tag "${oldName}" to "${newName}" on ${ids.length} card${ids.length === 1 ? '' : 's'}`);
}
// Sets (or clears, color=null) every occurrence of `name`'s colour across every node that has it,
// plus its phantom entry if it's still (also) just a phantom. No layout/height change, so a plain
// repaint suffices — unlike rename/delete this never touches which nodes have the tag.
function setTagColor(name: string, color: string | null): void {
  if (state.readOnly) return;
  if (phantomTags.has(name)) phantomTags.set(name, color);
  const ids = [...state.nodes.values()].filter(n => n.tags.some(t => parseTag(t).name === name)).map(n => n.id);
  if (ids.length) {
    record(ids, () => {
      for (const id of ids) {
        const n = state.nodes.get(id); if (!n) continue;
        n.tags = n.tags.map(t => parseTag(t).name === name ? encodeTag(name, color) : t);
        n.dirty = true;
      }
    });
    scheduleSave();
  }
  paintAll(); renderTagPanel();
}
function deleteTag(name: string): void {
  if (state.readOnly) return;
  phantomTags.delete(name);
  const ids = [...state.nodes.values()].filter(n => n.tags.some(t => parseTag(t).name === name)).map(n => n.id);
  if (!ids.length) { renderTagPanel(); return; }
  record(ids, () => {
    for (const id of ids) {
      const n = state.nodes.get(id); if (!n) continue;
      n.tags = n.tags.filter(t => parseTag(t).name !== name);
      n.dirty = true;
    }
  });
  paintAll(); applyLayouts(); paintAll(); scheduleSave(); renderTagPanel();
  setStatus(`Deleted tag "${name}" from ${ids.length} card${ids.length === 1 ? '' : 's'}`);
}
// Turn a panel row's pill into an inline text field pre-filled with its current name — mirrors
// outline.ts's startRowTitleEdit (contenteditable there, a plain input here since a tag name has
// no markdown/wikilink concerns). Enter/blur commits via renameTag; Escape cancels. Sets
// rowEditActive so an unrelated repaint elsewhere (paintAll's renderTagPanel tail) can't yank the
// input out from under the user mid-edit — see renderTagPanel's own guard.
function startRenameTag(row: HTMLElement, name: string): void {
  const pill = row.querySelector('.tag-pill') as HTMLElement; if (!pill) return;
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'tp-rename-input'; input.value = name;
  pill.replaceWith(input);
  rowEditActive = true;
  input.focus(); input.select();
  const commit = (cancel: boolean): void => {
    input.removeEventListener('blur', onBlur);
    rowEditActive = false;
    if (!cancel) renameTag(name, input.value);
    else renderTagPanel();
  };
  const onBlur = (): void => commit(false);
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(true); }
  });
}
// Turn a panel row into a strip of colour swatches (same .swatch chips the card colour picker
// uses — properties.ts's rebuildSwatches — so the two pickers look identical). Picking one commits
// immediately; there's no separate confirm step, matching the swatch picker's own behaviour.
function startColorPick(row: HTMLElement, name: string): void {
  const current = colorOfName(name);
  row.innerHTML = `<div class="swatches tp-color-picker">
      <div class="swatch nofill" data-color="" title="No colour"></div>
      ${PALETTE.map(c => `<div class="swatch" data-color="${c}" title="${c}" style="--sw:var(--pal-${c})"></div>`).join('')}
    </div>`;
  rowEditActive = true;
  row.querySelectorAll<HTMLElement>('.swatch').forEach(sw => {
    sw.classList.toggle('active', (sw.dataset.color || null) === current);
    sw.addEventListener('click', () => { rowEditActive = false; setTagColor(name, sw.dataset.color || null); });
  });
}

// ---- panel rendering ----
let rowEditActive = false;   // a rename/colour-pick/create-tag row is live — see start*() above
export function renderTagPanel(): void {
  if (!ui.tagPanelOn) return;
  if (pillDragActive) return;   // never rebuild rows mid-drag — it would destroy the pointer-captured pill
  if (rowEditActive) return;    // never rebuild rows mid-edit — same reasoning
  const rowsEl = byId('tagRows');
  const tags = allTags();
  const ghostRowHtml = `<div class="tp-row tp-ghost" tabindex="0" role="button" title="Add a new tag">
      <span class="tp-ghost-plus">+</span><span class="tp-ghost-label">Add tag</span>
    </div>`;
  if (!tags.length) {
    rowsEl.innerHTML = `<div class="tp-empty">No tags yet — select a card, then add one below.</div>${ghostRowHtml}`;
  } else {
    rowsEl.innerHTML = tags.map(({ name, color, count }) => `
      <div class="tp-row" data-tag="${esc(name)}">
        ${tagPillHTML(encodeTag(name, color), ' title="Click to toggle on the selection, or drag onto a card"')}
        ${count ? `<span class="tp-count">${count}</span>` : ''}
        <button class="tp-menu-btn" type="button" title="Tag actions" aria-label="Actions for “${esc(name)}”">⋮</button>
      </div>`).join('') + ghostRowHtml;
  }
  rowsEl.querySelectorAll<HTMLElement>('.tp-row[data-tag]').forEach(row => {
    const name = row.dataset.tag!;
    const pill = row.querySelector('.tag-pill') as HTMLElement;
    const menuBtn = row.querySelector('.tp-menu-btn') as HTMLButtonElement;
    pill.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (state.readOnly) return;
      startPillDrag(e as PointerEvent, { tag: name }, pill);
    });
    pill.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; }
      const ids = selectedIds();
      if (!ids.length) { setStatus('Select a card first, or drag this tag onto one'); return; }
      const allHave = ids.every(id => state.nodes.get(id)?.tags.some(t => parseTag(t).name === name));
      setTagOnNodes(ids, name, !allHave);
    });
    menuBtn.addEventListener('click', () => {
      const r = menuBtn.getBoundingClientRect();
      openMenu([
        { label: 'Rename', run: () => startRenameTag(row, name) },
        { label: 'Colour…', run: () => startColorPick(row, name) },
        { label: 'Delete', run: () => deleteTag(name), danger: true },
      ], r.left, r.bottom + 4);
    });
  });
  const ghostRow = rowsEl.querySelector<HTMLElement>('.tp-ghost')!;
  ghostRow.addEventListener('pointerdown', (e) => e.stopPropagation());
  ghostRow.addEventListener('click', () => { if (!state.readOnly) startCreateTag(ghostRow); });
  ghostRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!state.readOnly) startCreateTag(ghostRow); }
  });
}
// Turn the ghost "+" row into an inline text field for naming a brand-new tag — same shape as
// startRenameTag above (in-place swap to a .tp-rename-input, commit on Enter/blur, cancel on
// Escape), just backed by createAndAssignTag instead of renameTag.
function startCreateTag(ghostRow: HTMLElement): void {
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'tp-rename-input'; input.placeholder = 'Tag name…';
  ghostRow.replaceWith(input);
  rowEditActive = true;
  input.focus();
  const commit = (cancel: boolean): void => {
    input.removeEventListener('blur', onBlur);
    rowEditActive = false;
    if (!cancel) createAndAssignTag(input.value);
    renderTagPanel();
  };
  const onBlur = (): void => commit(false);
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(true); }
  });
}

// ---- card-rendered pills: drag source for removal (main.ts's paintNode calls this after
// rebuilding a card's .tag-row) ----
export function bindCardTagPills(rowEl: HTMLElement, n: MindNode): void {
  rowEl.querySelectorAll<HTMLElement>('.tag-pill').forEach(pill => {
    pill.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (state.readOnly || isLockedEffective(n)) return;
      startPillDrag(e as PointerEvent, { tag: pill.dataset.tag!, ownerId: n.id }, pill);
    });
  });
}

// ---- pointer-based drag-and-drop ----
// Mouse: a small movement threshold turns the press into a drag. Touch: a long-press (with a
// movement slop that cancels it — a quick swipe/scroll shouldn't accidentally start a drag),
// exactly mirroring outline.ts's row drag (PX/MS/SLOP constants below match its own).
const PILL_DRAG_PX = 4, PILL_LONGPRESS_MS = 350, PILL_LONGPRESS_SLOP = 10;
interface PillPayload { tag: string; ownerId?: string; }   // tag is always the base (colour-stripped) name
let pillDragActive = false;
let suppressClick = false;   // set once a drag actually engages, so the trailing synthetic click (pointerup->click) doesn't ALSO toggle

function startPillDrag(e: PointerEvent, payload: PillPayload, pillEl: HTMLElement): void {
  if (pillDragActive) return;
  if (e.button !== 0 && e.pointerType !== 'touch') return;
  const touchInput = e.pointerType === 'touch';
  const startX = e.clientX, startY = e.clientY;
  let engaged = false;
  let longPressTimer: number | undefined;
  let ghost: HTMLElement | null = null;
  let hoverEl: HTMLElement | null = null;
  const setHover = (el: HTMLElement | null): void => {
    if (hoverEl) hoverEl.classList.remove('tag-drop-target');
    hoverEl = el;
    if (el) el.classList.add('tag-drop-target');
  };
  const positionGhost = (x: number, y: number): void => {
    if (ghost) { ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; }
  };
  // Blocking native touch scroll mid-gesture can't be done via touch-action alone once a
  // long-press has already begun tracking — see outline.ts's identical touchBlock for the
  // rationale; registered up-front so it's already in place when the long-press fires.
  const touchBlock = (ev: TouchEvent): void => { if (engaged) ev.preventDefault(); };
  const engage = (): void => {
    if (engaged) return;
    engaged = true; pillDragActive = true; suppressClick = true;
    ghost = pillEl.cloneNode(true) as HTMLElement;
    ghost.className = pillEl.className + ' tag-drag-ghost';
    ghost.removeAttribute('title');
    document.body.appendChild(ghost);
    positionGhost(startX, startY);
    pillEl.classList.add('tag-pill-dragging');
  };
  const move = (ev: PointerEvent): void => {
    if (!engaged) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (touchInput) { if (Math.abs(dx) + Math.abs(dy) > PILL_LONGPRESS_SLOP) clearTimeout(longPressTimer); return; }
      if (Math.abs(dx) + Math.abs(dy) < PILL_DRAG_PX) return;
      engage();
    }
    positionGhost(ev.clientX, ev.clientY);
    const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    setHover(under?.closest('#world [data-id]') as HTMLElement | null);
  };
  const finish = (commit: boolean): void => {
    clearTimeout(longPressTimer);
    if (touchInput) pillEl.removeEventListener('touchmove', touchBlock);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    if (!engaged) return;
    pillDragActive = false;
    ghost?.remove();
    const dropTarget = hoverEl;   // read before clearing — setHover(null) below would otherwise null it out first
    setHover(null);
    pillEl.classList.remove('tag-pill-dragging');
    if (commit) applyDrop(payload, dropTarget);
    else renderTagPanel();   // catch up on any repaint skipped while dragging (mirrors outline.ts's own cancel path)
  };
  const up = (): void => finish(true);
  const cancel = (): void => finish(false);
  if (touchInput) {
    pillEl.addEventListener('touchmove', touchBlock, { passive: false });
    longPressTimer = window.setTimeout(engage, PILL_LONGPRESS_MS);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

function applyDrop(payload: PillPayload, targetEl: HTMLElement | null): void {
  if (state.readOnly) return;
  if (payload.ownerId) {
    // dragged FROM a card: dropped on empty canvas removes it; dropped on a DIFFERENT card
    // assigns it there too (a copy, the source keeps its own tag); dropped back onto the same
    // card (or nothing under the pointer besides itself) is a no-op.
    if (!targetEl) { setTagOnNodes([payload.ownerId], payload.tag, false); return; }
    const id = targetEl.dataset.id;
    if (!id || id === payload.ownerId) return;
    assignToTarget(payload.tag, id);
    return;
  }
  // dragged FROM the panel — assign onto whatever card (or query card) is under the pointer.
  if (!targetEl) return;
  const id = targetEl.dataset.id; if (!id) return;
  assignToTarget(payload.tag, id);
}

// Shared "assign this tag to whatever card id is under the drop point" — a query card appends a
// `t:<tag>` filter token instead of touching MindNode.tags (queries have no tags of their own).
function assignToTarget(tag: string, id: string): void {
  const n = state.nodes.get(id); if (!n) return;
  if (isQueryCard(n)) {
    if (isLockedEffective(n)) { setStatus('Locked — can’t edit query'); return; }
    touch(n.id);
    appendQueryToken(n, `t:${tag}`);
    scheduleSave(); commitStep();
    paintAll();
    return;
  }
  const ids = (state.sel.has(id) && state.sel.size > 1) ? [...state.sel] : [id];
  setTagOnNodes(ids, tag, true);
}

function init(): void {
  byId('tagBtn').addEventListener('click', toggleTagPanel);
}
init();
