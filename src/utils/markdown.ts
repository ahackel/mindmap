// ============================================================
// Markdown -> HTML — a small hand-rolled subset (headings, links, emphasis, task
// lists). NOT a full Markdown parser; extend these functions rather than reaching for
// a library (the no-dependency constraint is deliberate). The card body is a clipped
// preview rendered from this.
// ============================================================

// escape text for safe insertion into SVG/HTML markup
const ESC_MAP: Record<string, string> = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, c => ESC_MAP[c]);
}

// Inline emphasis on a PLAIN text run (escaped first so user text can't inject markup).
function mdEmphasis(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g,     '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_/g,  '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}
// Links/wikilinks within a text run; emphasis is applied to the gaps and link labels.
//   ![alt](src)                  → image (vault-relative path, or a remote/data URL)
//   [text](url) / bare https?:// → external link (new tab)
//   [[Note]] or [[Note|alias]]   → wikilink → focuses that node in the map
// NOTE: the image alternative comes first so ![..](..) isn't mis-read as a link with a stray "!".
function mdLinks(text: string): string {
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|(https?:\/\/[^\s)]+)/g;
  let out = '', last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))){
    out += mdEmphasis(text.slice(last, m.index));
    if (m[2])      out += imgTag(m[2], m[1]);                                                         // ![alt](src)
    else if (m[4]) out += `<a class="lk" href="${esc(m[4])}" target="_blank" rel="noopener">${mdEmphasis(m[3])}</a>`;
    else if (m[5]) out += `<a class="lk wikilink" data-target="${esc(m[5].trim())}">${esc((m[6]||m[5]).trim())}</a>`;
    else           out += `<a class="lk" href="${esc(m[7])}" target="_blank" rel="noopener">${esc(m[7])}</a>`;
    last = re.lastIndex;
  }
  out += mdEmphasis(text.slice(last));
  return out;
}
// An <img> for inline markdown. The real src is resolved after insertion (hydrateImages): vault
// paths are read from the store as blob URLs, remote/data URLs pass through — so rendering stays
// synchronous while disk reads happen lazily.
// data-img-src is consumed (removed) by hydrateImages; data-path stays on the element so the
// context menu can map a rendered <img> back to its markdown reference / vault file.
function imgTag(src: string, alt: string): string {
  return `<img class="md-img" data-img-src="${esc(src.trim())}" data-path="${esc(src.trim())}" alt="${esc(alt || '')}">`;
}
// Full inline pass: protect `code` spans first (no formatting inside), then links + emphasis.
function mdInline(text: string): string {
  let out = '', last = 0;
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))){
    out += mdLinks(text.slice(last, m.index));
    out += `<code>${esc(m[1])}</code>`;
    last = re.lastIndex;
  }
  out += mdLinks(text.slice(last));
  return out;
}
// Block-level pass: headings, lists, blockquotes, fenced code, rules, paragraphs.
export function renderBodyHTML(md: string | null | undefined): string {
  const src = (md || '').replace(/\r\n?/g, '\n').trim();
  if (!src) return '';                 // empty body → nothing (no stray blank line under the title)
  const lines = src.split('\n');
  let html = '', i = 0, taskIdx = 0;   // taskIdx: nth checkbox in the body, for write-back on toggle
  const BLOCK = /^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+\.\s)/;
  while (i < lines.length){
    const line = lines[i];
    if (/^```/.test(line)){                                   // fenced code block
      i++; const code: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;                                                    // skip closing fence
      html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; continue;
    }
    let h: RegExpMatchArray | null;
    if ((h = line.match(/^(#{1,6})\s+(.*)$/))){               // heading
      html += `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`; i++; continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)){ html += '<hr>'; i++; continue; }   // horizontal rule
    if (/^\s*>/.test(line)){                                   // blockquote
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${q.map(mdInline).join('<br>')}</blockquote>`; continue;
    }
    if (/^\s*[-*+]\s+/.test(line)){                            // unordered list (incl. [ ]/[x] tasks)
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      html += '<ul>' + items.map(it => {
        const tm = it.match(/^\[([ xX])\]\s+(.*)$/);
        if (tm) return `<li class="task"><input type="checkbox" class="taskbox" data-ti="${taskIdx++}"`
                     + `${tm[1].toLowerCase()==='x' ? ' checked' : ''}>${mdInline(tm[2])}</li>`;
        return `<li>${mdInline(it)}</li>`;
      }).join('') + '</ul>'; continue;
    }
    if (/^\s*\d+\.\s+/.test(line)){                            // ordered list
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      html += `<ol>${items.map(it => `<li>${mdInline(it)}</li>`).join('')}</ol>`; continue;
    }
    // text run: gather until the next block. Every blank line is KEPT and rendered as an empty
    // line (like Obsidian) — including blanks right before/after a list or other block. A run
    // that's only blank lines (a gap between two blocks) becomes that many empty lines.
    const para: string[] = [];
    while (i < lines.length && !BLOCK.test(lines[i])) para.push(lines[i++]);
    if (para.some(l => l.trim())) html += `<p>${para.map(mdInline).join('<br>')}</p>`;
    else html += '<br>'.repeat(para.length);
  }
  return html;
}
