// ---------- hierarchy helpers ----------
// The tree is DERIVED from each node's `parent` (no stored edge list). These queries
// walk that live structure in state.nodes.
import { state, type MindNode } from '../core/state.js';

export function childrenOf(id: string | null): MindNode[] {
  return [...state.nodes.values()].filter(n => n.parent === id);
}
export function isRoot(n: MindNode): boolean { return !n.parent || !state.nodes.has(n.parent); }
// A node's `collapsed` flag means "this branch is folded": the node ITSELF and all
// `collapsed` on a node hides its CHILDREN but keeps the node itself visible (outliner
// model). So a node is hidden only if one of its ANCESTORS is collapsed.
export function isHidden(n: MindNode): boolean {
  let p = n.parent ? state.nodes.get(n.parent) : undefined;
  while (p){
    if (p.collapsed) return true;
    p = p.parent ? state.nodes.get(p.parent) : undefined;
  }
  return false;
}
// The visible card standing in for n: n itself when it's shown, otherwise its nearest
// ancestor that is still visible. Search uses this to highlight the first visible parent
// containing a match that's buried inside a collapsed branch.
export function firstVisible(n: MindNode): MindNode {
  if (!isHidden(n)) return n;
  let p = n.parent ? state.nodes.get(n.parent) : undefined;
  while (p){
    if (!isHidden(p)) return p;
    p = p.parent ? state.nodes.get(p.parent) : undefined;
  }
  return n; // unreachable: the root is always visible
}
export function descendantCount(id: string): number {
  let c = 0; for (const ch of childrenOf(id)) c += 1 + descendantCount(ch.id); return c;
}
// A node whose lock cascades down: any ANCESTOR (not itself) is locked. Such a node can't even be
// selected — only the locked card itself remains selectable (see isLockedEffective below).
export function hasLockedAncestor(n: MindNode): boolean {
  let p = n.parent ? state.nodes.get(n.parent) : undefined;
  while (p){
    if (p.locked) return true;
    p = p.parent ? state.nodes.get(p.parent) : undefined;
  }
  return false;
}
// A node protected from move/collapse-toggle/edit/delete: it's locked itself, or a descendant of a
// locked ancestor. Selection is a narrower check (hasLockedAncestor alone) — the locked card itself
// stays selectable, just not editable.
export function isLockedEffective(n: MindNode): boolean { return n.locked || hasLockedAncestor(n); }
// Locked somewhere in id's own subtree (itself or any descendant) — used to refuse deleting a whole
// branch that contains a locked card, even when the branch's root itself isn't locked.
export function subtreeHasLocked(id: string): boolean {
  const n = state.nodes.get(id);
  if (n?.locked) return true;
  return childrenOf(id).some(ch => subtreeHasLocked(ch.id));
}
// The set of titles already in use (lowercased + trimmed), optionally excluding one node.
// Filenames collide case-insensitively on macOS/Windows, so collision checks compare lowercased.
// Shared by the rename validator (inline-edit) and the unique-name minter (crud).
export function takenTitles(exceptId?: string): Set<string> {
  const taken = new Set<string>();
  for (const n of state.nodes.values())
    if (n.id !== exceptId) taken.add(n.title.trim().toLowerCase());
  return taken;
}
// guard against cycles when re-parenting
export function isAncestor(maybeAncestorId: string, nodeId: string): boolean {
  let p = state.nodes.get(nodeId);
  p = p && p.parent ? state.nodes.get(p.parent) : undefined;
  while (p){ if (p.id === maybeAncestorId) return true; p = p.parent ? state.nodes.get(p.parent) : undefined; }
  return false;
}
