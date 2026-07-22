// ---------- emoji tags: assign / toggle / remove on cards ----------
// Tags aren't a first-class entity — there's no registry, just MindNode.tags: string[] round-tripped
// through frontmatter (utils/frontmatter.ts). Each tag is a single emoji (no name, no colour — the
// emoji itself is the visual identity), assigned via the "+" button at the end of a selected card's
// own tag row (main.ts's paintNode) or the outline properties sheet's tag row (properties.ts), both
// opening the shared MRU popover (features/emoji-picker.ts). This module owns the mutation
// (setTagOnNodes), the shared pill markup, and the card-rendered row's own click-to-remove / add
// wiring.
import { state, setStatus, type MindNode } from '../core/state.js';
import { isLockedEffective } from '../utils/model.js';
import { record } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { applyLayouts } from '../view/layout.js';
import { paintAll } from '../main.js';
import { esc } from '../utils/markdown.js';
// two-way cycle w/ emoji-picker.ts (which imports setTagOnNodes/tagPillHTML from here), evaluated
// only inside bindCardTagPills's own click handler below, never at module-eval time — same style as
// the main↔features cycles CLAUDE.md documents.
import { openEmojiPicker } from './emoji-picker.js';

// Shared pill markup for both the card-rendered row (main.ts) and the emoji picker's own MRU
// grid — one place owns "how does a tag pill look".
export function tagPillHTML(tag: string, extraAttrs = ''): string {
  return `<span class="tag-pill" data-tag="${esc(tag)}"${extraAttrs}>${esc(tag)}</span>`;
}

// ---- shared "add/remove tag on a set of node ids" mutation — the one path both the emoji picker
// and the card's own pill click funnel through, so the two always produce identical results. Skips
// locked nodes (like every other per-card mutation, e.g. properties.ts's colour swatch). ----
export function setTagOnNodes(ids: string[], tag: string, on: boolean): void {
  if (state.readOnly) return;
  const targets = ids.filter(id => !isLockedEffective(state.nodes.get(id)!));
  if (!targets.length) return;
  record(targets, () => {
    for (const id of targets) {
      const n = state.nodes.get(id); if (!n) continue;
      const has = n.tags.includes(tag);
      if (on && !has) n.tags = [...n.tags, tag];
      else if (!on && has) n.tags = n.tags.filter(t => t !== tag);
      n.dirty = true;
    }
  });
  // paint first so each card's height is current, then reflow (a tag row can change height), then
  // paint again.
  paintAll(); applyLayouts(); paintAll(); scheduleSave();
}

// ---- card-rendered tag row: click a pill to remove it, click the trailing "+" (only present on
// the selected card, see main.ts's showAddTag) to open the picker — main.ts's paintNode calls this
// after rebuilding a card's .tag-row. ----
export function bindCardTagPills(rowEl: HTMLElement, n: MindNode): void {
  rowEl.querySelectorAll<HTMLElement>('.tag-pill').forEach(pill => {
    pill.addEventListener('pointerdown', (e) => e.stopPropagation());   // don't let it start a card drag/select
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.readOnly) return;
      if (isLockedEffective(n)) { setStatus('Locked — can’t edit tags'); return; }
      setTagOnNodes([n.id], pill.dataset.tag!, false);
    });
  });
  const addBtn = rowEl.querySelector<HTMLButtonElement>('.tag-add-btn');
  if (addBtn) {
    addBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.readOnly || isLockedEffective(n)) return;
      openEmojiPicker(addBtn, [n.id]);
    });
  }
}
