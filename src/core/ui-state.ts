// ============================================================
// Shared mutable UI state for the interactive canvas subsystem (drag, in-place editing,
// pan/zoom gestures, image-drop). Like `state`, this is ONE object whose PROPERTIES are
// mutated in place (never reassign `ui`) so the live interaction state is shared across the
// render core (main.ts) and the feature modules split out of it (drag / inline-edit / gestures
// / attachments). Imported `let` bindings are read-only, hence the holder-object pattern.
// ============================================================
import type { MindNode, LayoutType, LayoutDir } from './state.js';

export type Pt = { x: number; y: number };

// A live node drag (moves a whole subtree, or the multi-selection). `active` is the card being
// dragged/dropped; `targets` follow the cursor (or, after a Shift-clone, just the clones).
export interface Drag {
  n: MindNode; active: MindNode; multi: boolean;
  sx: number; sy: number; cx: number; cy: number;
  start: Map<string, Pt>; targets: Map<string, Pt>; origins: Map<string, Pt>;
  moved: boolean; dropTarget: string | null;
  alt: boolean; shift: boolean; cloned: boolean;
  downTarget: EventTarget | null; meta: boolean; touch: boolean;
  clones?: MindNode[] | null;
}
export interface InlineEdit { id: string; orig: string; el: HTMLElement; isNew?: boolean; }
export interface BodyEdit { id: string; orig: string; el: HTMLElement; ta: HTMLTextAreaElement; }
export interface GroupFold { ids: Set<string>; node: string; t: number; }
export interface PanState { sx: number; sy: number; ox: number; oy: number; }
export interface Marquee { sx: number; sy: number; add: boolean; base: Set<string>; moved: boolean; }
export interface Pinch { dist: number; cx: number; cy: number; }
// Safari-only pinch events (not in lib.dom): clientX/Y + a scale factor.
export interface GestureEvt extends Event { clientX: number; clientY: number; scale: number; }

export const ui = {
  // ---- node drag (features/drag.ts) ----
  drag: null as Drag | null,
  dragRAF: null as number | null,   // pending rAF for drag paint; coalesces moves per frame
  autoPanRAF: null as number | null,
  // ---- slow-click / fold disambiguation (main render + drag) ----
  renameTimer: undefined as number | undefined,  // pending slow-click rename; any interaction cancels it
  pendingGroupFold: null as GroupFold | null,     // remembered group so a dblclick folds it all
  // ---- pan / zoom gestures (features/gestures.ts) ----
  pan: null as PanState | null,
  marquee: null as Marquee | null,
  spaceHeld: false,
  spaceUsedForPan: false,
  pinch: null as Pinch | null,                    // active two-finger gesture
  gestureStartK: 1,
  gestureMid: { x: 0, y: 0 } as Pt,
  // ---- in-place title/body editing (features/inline-edit.ts) ----
  // An open inlineEdit/bodyEdit defers the file rename / disk-reload while typing
  // (read as `!!ui.inlineEdit` / `!!ui.bodyEdit` in persistence.ts).
  inlineEdit: null as InlineEdit | null,
  bodyEdit: null as BodyEdit | null,
  // ---- animated relayout (main) ----
  animToken: 0,
};

// pointerId -> position, for the multi-touch gesture layer (a const Map, mutated in place).
export const gPointers = new Map<number, Pt>();

// True when focus is in a text field (sidebar input/textarea) or a contenteditable (the in-card
// title rename) — i.e. the user is typing, so card/canvas shortcuts and disk-reload should stand down.
export function isTypingInField(): boolean {
  const a = document.activeElement as HTMLElement | null;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(a?.tagName ?? '') || !!a?.isContentEditable;
}
