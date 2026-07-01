// ============================================================
// Markdown frontmatter parse/serialize.
// Frontmatter is parsed as ORDERED entries so unknown keys round-trip untouched: each
// entry groups a top-level `key:` line with any following continuation lines (indented
// values, `- list` items, blanks, comments) until the next top-level key. This lets us
// rewrite ONLY the app-owned keys (tags/color/mm_*) while preserving everything else —
// `date`, `category`, `aliases`, custom fields, and the note body — verbatim.
// ============================================================
import { state, type MindNode, type FmEntry } from '../core/state.js';

// The shape parseMd yields — a node-to-be plus its raw layout (mm_*) values.
export interface ParsedNote {
  title: string;
  fmEntries: FmEntry[];
  color: string;
  keepStatus: string;
  tags: string[];
  body: string;
  mm: {
    parent: string;
    x: number | null;
    y: number | null;
    collapsed: boolean;
    done: boolean;
    checklist: boolean;
    layout: string;
    side: string;
  };
}

function parseFM(fmText: string): FmEntry[] {
  const entries: FmEntry[] = [];
  for (const line of fmText.split('\n')){
    const m = line.match(/^([\w-]+):(.*)$/);
    if (m) entries.push({ key: m[1], lines: [line] });
    else if (entries.length) entries[entries.length-1].lines.push(line);   // continuation
    else entries.push({ key: null, lines: [line] });
  }
  return entries;
}
function fmEntry(entries: FmEntry[], key: string): FmEntry | undefined { return entries.find(e => e.key === key); }
function fmValue(entries: FmEntry[], key: string): string {
  const e = fmEntry(entries, key); if (!e) return '';
  return e.lines[0].slice(e.lines[0].indexOf(':')+1).trim();
}
function fmTags(entries: FmEntry[]): string[] {
  const e = fmEntry(entries, 'tags'); if (!e) return [];
  const inline = e.lines[0].slice(e.lines[0].indexOf(':')+1).trim();
  if (inline) return inline.replace(/^\[|\]$/g,'').split(',').map(s=>s.trim()).filter(Boolean);
  return e.lines.slice(1).map(l=>l.trim()).filter(l=>l.startsWith('-'))   // YAML list form
    .map(l=>l.replace(/^-\s*/,'').replace(/^["']|["']$/g,'').trim()).filter(Boolean);
}
function fmSet(entries: FmEntry[], key: string, line: string): void {
  const e = fmEntry(entries, key);
  if (e) e.lines = [line]; else entries.push({ key, lines:[line] });
}
function fmRemove(entries: FmEntry[], key: string): void {
  const i = entries.findIndex(e => e.key === key);
  if (i >= 0) entries.splice(i, 1);
}

export function parseMd(text: string, fileName: string): ParsedNote {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const entries = m ? parseFM(m[1]) : [];
  const body = m ? m[2] : text;
  // The TITLE is always the filename (without .md) — it's the node's identity on disk.
  const title = (fileName || 'Untitled').replace(/\.md$/i, '').trim() || 'Untitled';
  const num = (v: string): number | null => (v !== '' && !isNaN(+v)) ? +v : null;
  return {
    title,
    fmEntries: entries,                    // full original frontmatter, preserved on save
    color: fmValue(entries, 'color'),      // palette key, e.g. 'blue'
    keepStatus: fmValue(entries, 'status'),
    tags: fmTags(entries),
    body: body.trim(),
    // mindmap layout — note identity is its filename; parent stored as the PARENT note's path.
    mm: {
      parent: fmValue(entries, 'mm_parent'),
      x: num(fmValue(entries, 'mm_x')),
      y: num(fmValue(entries, 'mm_y')),
      collapsed: fmValue(entries, 'mm_collapsed') === 'true',
      done: fmValue(entries, 'mm_done') === 'true',
      checklist: fmValue(entries, 'mm_checklist') === 'true',
      // none(inherit) | free | line | fan — `mm_dir` (a parent-wide direction) is gone; a legacy
      // `two-sided` map already has valid mm_x/mm_y that per-side `fan` reproduces, so fold it
      // in rather than treating it as unknown.
      layout: (v => v === 'two-sided' ? 'fan' : v || 'none')(fmValue(entries, 'mm_layout')),
      // left | right | up | down | '' (unset — backfilled from position once loaded, see
      // data/persistence.ts). This is the CHILD's own attachment side, not the parent's.
      side: fmValue(entries, 'mm_side'),
    },
  };
}
function todayISO(): string { return new Date().toISOString().slice(0,10); }
// Rebuild the file from the ORIGINAL frontmatter entries, touching only the app-owned keys:
// tags, color, and the mm_* layout. `date`, `category`, `aliases`, custom fields, etc. are
// kept verbatim; `date` is stamped only when the note has none yet (never overwritten).
export function serializeMd(n: MindNode): string {
  const entries: FmEntry[] = (n.fmEntries || []).map(e => ({ key: e.key, lines: [...e.lines] }));
  // strip any stale mm_* (re-added fresh below); the prefix match covers every layout key
  entries.filter(e => e.key && e.key.startsWith('mm_')).forEach(e => fmRemove(entries, e.key as string));
  fmSet(entries, 'tags', `tags: ${n.tags.length ? `[${n.tags.join(', ')}]` : '[]'}`);
  if (n.color) fmSet(entries, 'color', `color: ${n.color}`); else fmRemove(entries, 'color');
  if (!fmEntry(entries, 'date')) entries.unshift({ key:'date', lines:[`date: ${todayISO()}`] });
  const parentNode = n.parent ? state.nodes.get(n.parent) : null;
  if (parentNode) entries.push({ key:'mm_parent', lines:[`mm_parent: ${parentNode.file}`] });
  if (parentNode && n.side) entries.push({ key:'mm_side', lines:[`mm_side: ${n.side}`] });
  entries.push({ key:'mm_x', lines:[`mm_x: ${Math.round(n.x)}`] });
  entries.push({ key:'mm_y', lines:[`mm_y: ${Math.round(n.y)}`] });
  if (n.collapsed) entries.push({ key:'mm_collapsed', lines:['mm_collapsed: true'] });
  if (n.done) entries.push({ key:'mm_done', lines:['mm_done: true'] });
  if (n.checklist) entries.push({ key:'mm_checklist', lines:['mm_checklist: true'] });
  if (n.layoutType && n.layoutType !== 'none')   // none (inherit) is the default — omit from file
    entries.push({ key:'mm_layout', lines:[`mm_layout: ${n.layoutType}`] });
  const fm = entries.flatMap(e => e.lines).join('\n');
  const body = n.body.trim();
  return `---\n${fm}\n---\n` + (body ? '\n' + body + '\n' : '\n');
}
