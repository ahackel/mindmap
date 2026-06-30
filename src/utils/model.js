// ---------- hierarchy helpers ----------
// The tree is DERIVED from each node's `parent` (no stored edge list). These queries
// walk that live structure in state.nodes.
import { state } from '../core/state.js';

export function childrenOf(id){ return [...state.nodes.values()].filter(n => n.parent === id); }
export function isRoot(n){ return !n.parent || !state.nodes.has(n.parent); }
// A node's `collapsed` flag means "this branch is folded": the node ITSELF and all
// `collapsed` on a node hides its CHILDREN but keeps the node itself visible (outliner
// model). So a node is hidden only if one of its ANCESTORS is collapsed.
export function isHidden(n){
  let p = n.parent && state.nodes.get(n.parent);
  while (p){
    if (p.collapsed) return true;
    p = p.parent && state.nodes.get(p.parent);
  }
  return false;
}
export function descendantCount(id){
  let c = 0; for (const ch of childrenOf(id)) c += 1 + descendantCount(ch.id); return c;
}
// guard against cycles when re-parenting
export function isAncestor(maybeAncestorId, nodeId){
  let p = state.nodes.get(nodeId);
  p = p && p.parent && state.nodes.get(p.parent);
  while (p){ if (p.id === maybeAncestorId) return true; p = p.parent && state.nodes.get(p.parent); }
  return false;
}
