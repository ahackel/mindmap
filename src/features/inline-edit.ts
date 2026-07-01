// ---------- in-place title & body editing ----------
// Editing happens ON the card, not in the sidebar: slow-click (or F2) renames the title in a
// contenteditable, slow-click the body (or ↓ from the title) opens a raw-markdown textarea.
// An open ui.inlineEdit/bodyEdit defers the file rename / disk-reload while typing so the
// folder isn't littered with half-typed names. nodeEl (main) binds the title handlers; the body
// editor binds its own. Reflow uses the live DOM height, so n.title/body stay untouched mid-edit.
import { state, setStatus, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { takenTitles } from '../utils/model.js';
import { applyLayouts } from '../view/layout.js';
import { scheduleSave } from '../data/persistence.js';
import { onBodyPaste } from './attachments.js';
import { paintAll, selectNode, edName } from '../main.js';
import { extractToChild, deleteNode } from './crud.js';
import { touch, commitStep } from './history.js';

// Why a title is invalid (empty or already used by another node), else '' (ok).
// Filenames collide case-insensitively on macOS/Windows, so compare lowercased.
function titleProblem(title: string, selfId: string): string {
  const t = title.trim();
  if (!t) return 'Title can’t be empty';
  if (takenTitles(selfId).has(t.toLowerCase()))
    return 'A node with this title already exists';
  return '';
}

// ---------- inline title rename (edit the title on the card itself) ----------
// Entered via slow-click (a second click on the already-selected card), F2, or automatically
// when a node is created. An open ui.inlineEdit makes the save loop defer the file rename
// until editing ends (no M.md, Ma.md… litter).
export function startInlineEdit(n: MindNode | undefined, { isNew = false }: { isNew?: boolean } = {}): void {
  if (state.readOnly || !n || !n.el) return;
  if (ui.inlineEdit) endInlineEdit();                              // close any other open editor first
  touch(n.id);   // the whole edit session becomes ONE undo step (for a fresh card, incl. its creation)
  if (state.selId !== n.id || state.sel.size !== 1) selectNode(n.id);
  const titleEl = n.el.querySelector('.title') as HTMLElement;
  // `isNew` marks a just-created card: Escape then cancels the whole creation (deletes it),
  // rather than just reverting the rename the way it does for an existing card.
  ui.inlineEdit = { id:n.id, orig:n.title, el:titleEl, isNew };
  titleEl.setAttribute('contenteditable', 'plaintext-only');
  titleEl.classList.add('editing'); titleEl.classList.remove('invalid');
  titleEl.focus();
  const r = document.createRange(); r.selectNodeContents(titleEl);     // select-all so typing replaces
  const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
}
// Live: validate + reflow as the user types. We never touch n.title here (layout uses the live DOM
// height, not the stored title), so a half-typed invalid title can't corrupt anything.
export function onInlineInput(n: MindNode): void {
  const ie = ui.inlineEdit;
  if (!ie || ie.id !== n.id) return;
  const val = ie.el.textContent ?? '';
  const problem = titleProblem(val, n.id);
  ie.el.classList.toggle('invalid', !!problem);
  edName.textContent = val;     // mirror the live name into the sidebar's read-only header
  applyLayouts(); paintAll();   // a taller/shorter title reflows siblings (title text stays, guarded)
}
export function onInlineKeydown(e: KeyboardEvent, n: MindNode): void {
  if (!ui.inlineEdit || ui.inlineEdit.id !== n.id) return;
  if (e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); e.stopPropagation(); endInlineEdit(); }
  else if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); endInlineEdit({ cancel:true }); }
  // ↓ from the title drops straight into editing the body (handy right after creating a card)
  else if (e.key === 'ArrowDown'){ e.preventDefault(); e.stopPropagation(); endInlineEdit(); startBodyEdit(n, { atStart:true }); }
}
// Commit (or cancel) the rename: keep the typed title if valid, else fall back to the node's
// current (last-valid) title. Restores canonical text, then reflows + saves.
export function endInlineEdit({ cancel = false }: { cancel?: boolean } = {}): void {
  const ie = ui.inlineEdit; if (!ie) return;
  ui.inlineEdit = null;                               // null first → the blur handler becomes a no-op
  const n = state.nodes.get(ie.id);
  ie.el.removeAttribute('contenteditable');
  ie.el.classList.remove('editing', 'invalid');
  ie.el.blur();                                       // ensure keyboard closes on iOS when ended by keypress
  if (!n) { commitStep(); return; }
  if (cancel && ie.isNew){                            // Esc on a freshly-created card = cancel creation
    // The pending step still holds this card's before-image (null, from mkNode); deleteNode rides
    // it as a non-owner, so committing here nets null→null and the step is discarded — no create
    // OR delete ends up in the history.
    deleteNode(n.id);
    commitStep();
    setStatus('Cancelled new card');
    return;
  }
  const val = (ie.el.textContent ?? '').replace(/[\r\n]+/g, ' ').trim();   // titles map to filenames — no newlines
  if (!cancel && !titleProblem(val, n.id)) n.title = val;
  ie.el.textContent = n.title;                        // restore the canonical text
  n.dirty = true;
  edName.textContent = n.title;                       // keep the sidebar header in sync
  paintAll(); applyLayouts(); paintAll();             // title may have changed height → reflow
  scheduleSave();
  commitStep();                                       // one undo step per rename session
}

// ---------- inline body edit (edit a card's note on the card itself) ----------
// Entered via slow-click on the body, or ↓ from the title editor. Shows the RAW markdown in a
// textarea inside .body; Enter inserts a newline, Esc cancels (restores the original), blur commits.
// An open `ui.bodyEdit` mirrors the title guard so the save loop / disk-reload behave the same.
export function autosizeBody(ta: HTMLTextAreaElement): void { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
export function startBodyEdit(n: MindNode, { atStart = false }: { atStart?: boolean } = {}): void {
  if (state.readOnly || !n || !n.el) return;
  if (ui.bodyEdit && ui.bodyEdit.id === n.id) return;          // already editing this body
  if (ui.inlineEdit) endInlineEdit();                          // close a title editor first
  if (ui.bodyEdit) endBodyEdit();                              // close any other open body editor
  touch(n.id);   // the whole body-edit session becomes ONE undo step
  if (state.selId !== n.id || state.sel.size !== 1) selectNode(n.id);
  const bodyEl = n.el.querySelector('.body') as HTMLElement;
  const ta = document.createElement('textarea');
  ta.className = 'body-edit'; ta.spellcheck = false; ta.value = n.body;
  ui.bodyEdit = { id:n.id, orig:n.body, el:bodyEl, ta };
  n.el.classList.remove('no-body');                            // give the body slot room while editing
  bodyEl.innerHTML = ''; bodyEl.appendChild(ta);
  bodyEl.classList.add('editing');
  // typing: keep the textarea sized to its content and reflow siblings as the card grows/shrinks
  ta.addEventListener('input', () => { autosizeBody(ta); onBodyInput(n); });
  ta.addEventListener('keydown', (e) => onBodyKeydown(e, n));
  ta.addEventListener('blur',    () => { if (ui.bodyEdit && ui.bodyEdit.id === n.id) endBodyEdit(); });
  ta.addEventListener('paste',   onBodyPaste);                 // paste images straight into the note
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());   // place the caret, don't drag the card
  ta.focus();
  autosizeBody(ta);              // size to content first so the card's real height is known…
  applyLayouts(); paintAll();    // …then reflow siblings around it (not just after a newline)
  const pos = atStart ? 0 : ta.value.length;
  ta.setSelectionRange(pos, pos);
}
// Live: reflow as the user types. n.body isn't touched here (layout uses the live DOM height),
// so an in-progress edit can't corrupt anything — the textarea content is preserved by paintNode.
function onBodyInput(n: MindNode): void {
  if (!ui.bodyEdit || ui.bodyEdit.id !== n.id) return;
  applyLayouts(); paintAll();
}
function onBodyKeydown(e: KeyboardEvent, n: MindNode): void {
  if (!ui.bodyEdit || ui.bodyEdit.id !== n.id) return;
  e.stopPropagation();                                  // keep canvas/card shortcuts out while typing
  if (e.key === 'Escape'){ e.preventDefault(); endBodyEdit({ cancel:true }); }
  else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter'){ e.preventDefault(); endBodyEdit(); }
  else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'e' || e.key === 'E')){ e.preventDefault(); extractToChild(); }
  // plain Enter falls through → the textarea inserts a newline (notes are multi-line)
}
// Commit (or cancel) the body edit. Commit stores the textarea text; cancel leaves n.body untouched
// (its original). Either way we drop the textarea and re-render + reflow from n.body.
export function endBodyEdit({ cancel = false }: { cancel?: boolean } = {}): void {
  const be = ui.bodyEdit; if (!be) return;
  ui.bodyEdit = null;                                   // null first → the blur handler becomes a no-op
  be.ta.blur();                                         // ensure keyboard closes on iOS when ended by keypress
  const n = state.nodes.get(be.id);
  be.el.classList.remove('editing');
  const changed = !!n && !cancel && be.ta.value !== be.orig;
  if (changed){ n.body = be.ta.value; n.dirty = true; }
  paintAll(); applyLayouts(); paintAll();               // re-render the body and reflow the height change
  if (changed) scheduleSave();
  commitStep();                                         // no-op sessions (cancel/unchanged) are discarded
}
