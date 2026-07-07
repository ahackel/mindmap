// ---------- full-screen editor sheet (phone / outline mode) ----------
// The keyboard-safe replacement for the in-card title/body editors: one sheet with a title
// field, a raw-markdown textarea and an explicit Done. startInlineEdit/startBodyEdit route
// here when phoneMode() or outline mode is active (see features/inline-edit.ts), so every
// entry point (F2, E, slow-click, add child/sibling, context menu) lands in the same editor.
// Contracts mirror inline-edit: n.title/n.body stay untouched until commit, the whole session
// is ONE undo step (touch/commitStep), and an open ui.sheetEdit defers the file rename and
// the focus-reload (see data/persistence.ts).
import { state, setStatus, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { applyLayouts } from '../view/layout.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, selectNode } from '../main.js';
import { titleProblem } from './inline-edit.js';
import { deleteNode } from './crud.js';
import { touch, commitStep } from './history.js';

const sheet = document.getElementById('editorSheet') as HTMLElement;
const shTitle = document.getElementById('shTitle') as HTMLInputElement;
const shBody = document.getElementById('shBody') as HTMLTextAreaElement;
const shDone = document.getElementById('shDone') as HTMLButtonElement;
const shCancel = document.getElementById('shCancel') as HTMLButtonElement;

// read-only sessions (help map / locked mode) never set ui.sheetEdit — nothing can be written,
// so the persistence guards don't apply; the sheet just displays the note.
let roView: string | null = null;   // node id being VIEWED read-only, else null

export function sheetOpen(): boolean { return !!ui.sheetEdit || !!roView; }

export function openEditorSheet(n: MindNode | undefined, { focus, isNew = false }: { focus?: 'title' | 'body'; isNew?: boolean } = {}): void {
  if (!n) return;
  if (sheetOpen()) closeEditorSheet();               // commit any other open session first
  if (state.selId !== n.id || state.sel.size !== 1) selectNode(n.id);
  if (state.readOnly) roView = n.id;
  else {
    touch(n.id);   // the whole sheet session becomes ONE undo step (incl. creation when isNew)
    ui.sheetEdit = { id: n.id, origTitle: n.title, origBody: n.body, isNew };
  }
  shTitle.value = n.title;
  shBody.value = n.body;
  shTitle.readOnly = state.readOnly;
  shBody.readOnly = state.readOnly;
  shTitle.classList.remove('invalid');
  document.body.classList.add('sheet-open');
  fitToViewport();
  if (focus === 'title' || isNew) { shTitle.focus(); shTitle.select(); }
  else if (focus === 'body') { shBody.focus(); shBody.setSelectionRange(shBody.value.length, shBody.value.length); }
}

// Commit (or cancel) the session and close the sheet. Commit keeps the typed title if valid
// (else the node's current title stays) and stores the body verbatim. Esc on a brand-new card
// cancels the whole creation, same as the inline editor.
export function closeEditorSheet({ cancel = false }: { cancel?: boolean } = {}): void {
  const se = ui.sheetEdit;
  ui.sheetEdit = null; roView = null;                 // null first → guards/blur become no-ops
  document.body.classList.remove('sheet-open');
  sheet.style.height = ''; sheet.style.top = '';
  (document.activeElement as HTMLElement | null)?.blur?.();   // close the on-screen keyboard
  if (!se) return;                                    // read-only view: nothing to commit
  const n = state.nodes.get(se.id);
  if (!n) { commitStep(); return; }
  if (cancel && se.isNew) {
    // same net-null trick as endInlineEdit: the pending step holds the create's null
    // before-image, so deleting here nets null→null and the step is discarded.
    deleteNode(n.id);
    commitStep();
    setStatus('Cancelled new card');
    return;
  }
  if (!cancel) {
    const t = shTitle.value.replace(/[\r\n]+/g, ' ').trim();   // titles map to filenames — no newlines
    if (!titleProblem(t, n.id)) n.title = t;
    n.body = shBody.value;
    n.dirty = true;
    paintAll(); applyLayouts(); paintAll();           // content changed height → reflow the canvas
    scheduleSave();
  }
  commitStep();                                       // cancelled/unchanged sessions are discarded
}

// live title validation, same rule as the inline rename (empty / duplicate filename)
shTitle.addEventListener('input', () => {
  const se = ui.sheetEdit; if (!se) return;
  shTitle.classList.toggle('invalid', !!titleProblem(shTitle.value, se.id));
});
shDone.addEventListener('click', () => closeEditorSheet());
shCancel.addEventListener('click', () => closeEditorSheet({ cancel: true }));
sheet.addEventListener('keydown', (e) => {
  e.stopPropagation();   // keep global card/canvas shortcuts out while the sheet is up
  if (e.key === 'Escape') { e.preventDefault(); closeEditorSheet({ cancel: true }); }
  else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); closeEditorSheet(); }
  // Enter in the title drops into the body (like ↓ in the inline rename); plain Enter in the
  // body just inserts a newline.
  else if (e.key === 'Enter' && e.target === shTitle) { e.preventDefault(); shBody.focus(); }
});

// Keyboard safety: size the sheet to the VISUAL viewport so the Done button and the caret
// never hide behind the on-screen keyboard (100dvh ignores the keyboard on iOS).
function fitToViewport(): void {
  if (!document.body.classList.contains('sheet-open')) return;
  const vv = window.visualViewport;
  if (!vv) return;   // no visualViewport → the 100dvh fallback in styles.css applies
  sheet.style.height = vv.height + 'px';
  sheet.style.top = vv.offsetTop + 'px';
}
window.visualViewport?.addEventListener('resize', fitToViewport);
window.visualViewport?.addEventListener('scroll', fitToViewport);
