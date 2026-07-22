// ---------- outline single-card editor ----------
// The outline's "deep edit" surface for ONE card: its title + note, styled like the canvas card —
// NOT the sidebar form. Opened from a row (the › open button), or whenever something needs the
// note editor while in outline mode (slow-click the row / E / ↓ from the title — see
// features/inline-edit.ts's startBodyEdit). Renders into #olCards inside the outline panel and
// toggles `body.ol-editing` (instant, no slide-in). The open card slides up a properties sheet from
// the bottom (#branchProps): colour / tags / checklist / group background, the same controls as the
// canvas sidebar (features/properties.ts). Duplicate / delete still live in the row's ⋯ menu; the
// "+" button here adds a CHILD of the open card and drills straight into it, so you can build out a
// branch card-by-card. Editing reuses the in-card editors' contract: one undo step per focus→blur
// session, and ui.panelEdit freezes the file rename while typing.
import { state, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { applyLayouts } from '../view/layout.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, effectiveColor } from '../main.js';
import { titleProblem, autosizeBody } from './inline-edit.js';
import { addChild } from './crud.js';
import { touch, commitStep } from './history.js';
import { createProperties, type PropertyControls } from './properties.js';
import { isLockedEffective } from '../utils/model.js';

const cardsEl = document.getElementById('olCards') as HTMLElement;
// persistent (index.html), not part of .ol-scroll — see its CSS comment for why. Shown/hidden
// purely via body.ol-editing, so it's wired once here rather than created/destroyed per open.
document.getElementById('ocBack')!.addEventListener('click', () => closeBranchEditor());
let anchorId: string | null = null;   // the tapped card whose sibling group is shown
let activeId: string | null = null;   // the card currently focused → the props sheet targets it

// ---- properties sheet (lives at the bottom of the outliner panel) ----
// The same colour / tags / checklist / group-background controls as the canvas sidebar (built once
// in features/properties.ts), pinned to the bottom of the outliner for the active card. Created
// lazily: at module-import time main.ts is still evaluating and its SWATCH_BG/PALETTE aren't defined
// yet (createProperties builds the swatch row eagerly), so we defer to first open.
const bpEl = document.getElementById('branchProps') as HTMLElement;
bpEl.inert = true;   // stays in the DOM (transform:translateY, not display:none) so its slide-up
// animates — but that also leaves #bpTags/#bpChecklist/#bpBg focusable while "closed", which
// iOS Safari counts towards showing the keyboard's Prev/Next accessory bar even for an unrelated
// focused field elsewhere on the page. `inert` drops it from the focus/tab order without
// touching layout or the transition; toggled alongside body.branch-props-open below.
let bpPanel: PropertyControls | null = null;
function props(): PropertyControls {
  return bpPanel ??= createProperties({
    colors: document.getElementById('bpColors') as HTMLElement,
    tags: document.getElementById('bpTags') as HTMLInputElement,
    checklist: document.getElementById('bpChecklist') as HTMLInputElement,
    bg: document.getElementById('bpBg') as HTMLInputElement,
  }, () => (activeId ? [activeId] : []));
}
function markActiveCard(id: string | null): void {
  cardsEl.querySelectorAll<HTMLElement>('.oc-card.active').forEach(c => c.classList.remove('active'));
  if (id) cardsEl.querySelector<HTMLElement>(`.oc-card[data-id="${id}"]`)?.classList.add('active');
}
// Make `n` the active card: highlight its card, point the props sheet at it and slide it up. Called
// when a card in the branch editor is focused or tapped, and for the anchor when the editor opens.
function setActiveCard(n: MindNode): void {
  activeId = n.id;
  // No selectNode() — the properties sheet targets `activeId` directly (see props() above), and
  // the outliner never touches canvas selection (see features/outline.ts's row click handler).
  markActiveCard(n.id);
  props().sync();
  bpEl.inert = false;
  document.body.classList.add('branch-props-open');
}
function hideProps(): void {
  activeId = null; markActiveCard(null);
  bpEl.inert = true;
  document.body.classList.remove('branch-props-open');
}
// The factory repaints the canvas/outline on a colour change, but the open branch card carries its
// own tint via its c-* class — re-apply it so the card recolours in place as you pick a swatch.
bpEl.addEventListener('click', () => {
  if (!activeId) return;
  const n = state.nodes.get(activeId); if (!n) return;
  cardsEl.querySelector<HTMLElement>(`.oc-card[data-id="${activeId}"]`)?.setAttribute(
    'class', `oc-card active c-${effectiveColor(n)}`);
});

// ---- drag the handle down to dismiss the sheet ----
// A pointer drag on the grab handle follows the finger (downward only); released past a threshold it
// slides the sheet away (hideProps), else it snaps back. Focusing/tapping a card brings it back.
const bpHandle = bpEl.querySelector('.bp-handle') as HTMLElement;
const DISMISS_PX = 56;
let dragStartY = 0, dragging = false;
bpHandle.addEventListener('pointerdown', (e) => {
  dragging = true; dragStartY = e.clientY;
  bpEl.classList.add('bp-dragging');                 // suspend the transition so it tracks the finger
  try { bpHandle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
});
bpHandle.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  bpEl.style.transform = `translateY(${Math.max(0, e.clientY - dragStartY)}px)`;
});
function endDrag(e: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  bpEl.classList.remove('bp-dragging');              // re-enable the transition for the snap / slide-out
  const dy = Math.max(0, e.clientY - dragStartY);
  bpEl.style.transform = '';                         // hand back to CSS: translateY(0) if kept, or the parked state
  if (dy > DISMISS_PX) hideProps();
}
bpHandle.addEventListener('pointerup', endDrag);
bpHandle.addEventListener('pointercancel', endDrag);
// keyboard affordance for the handle (it's a button): Enter / Space dismisses
bpHandle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hideProps(); }
});

export function branchEditorOpen(): boolean { return document.body.classList.contains('ol-editing'); }
// The + button, while the single-card editor is open, adds a CHILD of the open card. addChild
// (via startInlineEdit's outlineActive+branchEditorOpen branch) re-opens the editor on the new
// child, so tapping + repeatedly drills a branch deeper, one card at a time.
export function addToBranch(): void { if (anchorId && !state.readOnly) addChild(anchorId); }

// ---- one edit session (focus→blur) per field, mirroring the in-card / panel editors ----
function beginEdit(n: MindNode): void {
  if (ui.panelEdit?.id === n.id) return;
  touch(n.id);
  ui.panelEdit = { id: n.id, origTitle: n.title, origBody: n.body };
}
function endEdit(): void {
  if (!ui.panelEdit) return;
  ui.panelEdit = null;   // null first → the deferred file rename lands on the next save
  commitStep();          // no-op sessions (nothing typed) are discarded
  scheduleSave();        // flush the pending rename
}
function cardFor(n: MindNode): HTMLElement {
  const card = document.createElement('div');
  card.className = `oc-card c-${effectiveColor(n)}`;
  card.dataset.id = n.id;

  const locked = isLockedEffective(n);
  const title = document.createElement('input');
  title.className = 'oc-title'; title.value = n.title;
  title.autocomplete = 'off'; title.spellcheck = false; title.readOnly = locked;
  const note = document.createElement('textarea');
  note.className = 'oc-note'; note.value = n.body;
  note.spellcheck = false; note.readOnly = locked;
  // empty note → the same accent "Add note…" bubble the canvas shows (.node .addnote); clicking it
  // (or Enter from the title) swaps in the textarea and focuses it.
  const addNote = document.createElement('button');
  addNote.type = 'button'; addNote.className = 'oc-addnote'; addNote.textContent = 'Add note…';
  addNote.disabled = locked;
  const revealNote = (): void => { if (!note.isConnected) { addNote.replaceWith(note); autosizeBody(note); } note.focus(); };
  addNote.addEventListener('click', revealNote);

  title.addEventListener('focus', () => beginEdit(n));
  title.addEventListener('input', () => {
    const val = title.value.replace(/[\r\n]+/g, ' ');   // titles map to filenames — no newlines
    const problem = titleProblem(val, n.id);
    title.classList.toggle('invalid', !!problem);
    if (problem) return;                                // keep the last valid title until it's fixed
    n.title = val.trim(); n.dirty = true; scheduleSave();
  });
  title.addEventListener('blur', () => { title.value = n.title; title.classList.remove('invalid'); endEdit(); });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); revealNote(); } });

  note.addEventListener('focus', () => beginEdit(n));
  note.addEventListener('input', () => { n.body = note.value; n.dirty = true; autosizeBody(note); scheduleSave(); });
  note.addEventListener('blur', () => {
    endEdit();
    // emptied the note → swap the textarea back for the "Add note…" bubble
    if (!note.value.trim() && note.isConnected) note.replaceWith(addNote);
  });

  // tapping/focusing anywhere in the card makes it the active card (props sheet targets it). Use
  // focusin (fires when the title/note gains focus) + a pointerdown for taps on the card's padding.
  card.addEventListener('focusin', () => setActiveCard(n));
  card.addEventListener('pointerdown', () => setActiveCard(n));

  card.append(title, n.body && n.body.trim() ? note : addNote);
  return card;
}

// Open the single-card editor on `id`. `focus` picks what grabs the keyboard: the title (default,
// select-all so typing replaces it), the note (revealing it first if still empty), or 'none' to
// just show the card without stealing focus (the › open button on a row).
export function openBranchEditor(id: string, focus: 'title' | 'body' | 'none' = 'title'): void {
  const n = state.nodes.get(id); if (!n || state.readOnly) return;
  anchorId = id;
  cardsEl.textContent = '';
  const card = cardFor(n);
  cardsEl.appendChild(card);
  document.body.classList.add('ol-editing');
  cardsEl.querySelectorAll<HTMLTextAreaElement>('.oc-note').forEach(autosizeBody);   // size notes to content
  setActiveCard(n);   // open the props sheet on the card
  card.scrollIntoView({ block: 'nearest' });
  if (focus === 'body') {
    // reveal the note (its textarea, or the "Add note…" bubble if it's still empty) and focus it
    (card.querySelector<HTMLElement>('.oc-note') ?? card.querySelector<HTMLElement>('.oc-addnote'))?.click?.();
    card.querySelector<HTMLTextAreaElement>('.oc-note')?.focus();
  } else if (focus === 'title') {
    const t = card.querySelector<HTMLInputElement>('.oc-title');
    t?.focus(); t?.select();
  }
}
export function closeBranchEditor(): void {
  if (!branchEditorOpen()) return;
  (document.activeElement as HTMLElement | null)?.blur?.();   // commit any open field session
  anchorId = null;
  hideProps();
  document.body.classList.remove('ol-editing');
  cardsEl.textContent = '';
  applyLayouts(); paintAll();   // reflect the title/note edits in the list rows (+ canvas behind)
}

// Escape anywhere in the editor is a keyboard "back" button.
cardsEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBranchEditor(); }
});
