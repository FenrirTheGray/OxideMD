// Pure, dependency-free Markdown line transforms shared by the editor's
// formatting actions. Deliberately free of CodeMirror imports so they can be
// unit-tested directly with `node --test` (see md-transform.test.ts), the same
// way the accelerator layer is.

// The marker of any list item (bullet, task, or ordered) at the start of a
// line, so a line can be re-tagged from one list type to another. Both
// CommonMark ordered delimiters (`1.` and `1)`) are recognized on input;
// generation always emits `1.`.
export const LIST_PREFIX_RE = /^(?:-\s\[[ xX]\]\s|-\s|\d+[.)]\s)/;

const ORDERED_RE = /^(\d+)[.)]\s/;

// Split a line into [indent, rest]. The line toggles (headings, lists,
// quotes) match and insert markers against `rest`, so a nested list item or
// indented heading toggles in place instead of getting a second marker at
// column 0.
export function splitIndent(l: string): [string, string] {
  const ind = /^[ \t]*/.exec(l)![0];
  return [ind, l.slice(ind.length)];
}

// Expand a [s, e) selection to whole-line bounds for block ops. A non-empty
// selection ending at column 0 (triple-click and Shift+Down select through
// the newline) stops at the previous line — the line the caret merely
// touches is not part of the block.
export function blockLineSpan(v: string, s: number, e: number): { lineStart: number; lineEnd: number } {
  const lineStart = s === 0 ? 0 : v.lastIndexOf('\n', s - 1) + 1;
  const end = e > s && v[e - 1] === '\n' ? e - 1 : e;
  let lineEnd = v.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = v.length;
  return { lineStart, lineEnd };
}

// ── Inline wrap/unwrap ────────────────────────────────────────────────────
// Blank-line separator (odd captures survive String.split for reassembly).
const CHUNK_SPLIT = /(\n[ \t]*\n(?:[ \t]*\n)*)/;

// Wrap `text` in open/close delimiters, one wrap per blank-line-separated
// chunk (CommonMark emphasis can't span blank lines), skipping each chunk's
// edge whitespace (a delimiter touching inner whitespace doesn't parse —
// `**word **` renders its asterisks literally). Whitespace-only text is
// returned unchanged.
export function wrapChunks(text: string, open: string, close: string = open): string {
  return text.split(CHUNK_SPLIT).map((seg, i) => {
    if (i % 2 === 1) return seg;
    const lead = /^\s*/.exec(seg)![0];
    const core = seg.trim();
    if (!core) return seg;
    return lead + open + core + close + seg.slice(lead.length + core.length);
  }).join('');
}

// Inverse of wrapChunks: strip open/close from every chunk's core. Returns
// null when any content chunk isn't wrapped — the caller wraps instead.
// Two edge-lookalike guards:
//  • single `*`: a core whose star run is even is bold (`**text**`), not
//    italic — stripping one star would corrupt the bold marker;
//  • asymmetric delimiters: `<u>a</u> x <u>b</u>` has matching edges but
//    they belong to two different spans (a closer precedes any opener in
//    the inner text).
export function unwrapChunks(text: string, open: string, close: string = open): string | null {
  let sawContent = false;
  const parts = text.split(CHUNK_SPLIT).map((seg, i) => {
    if (i % 2 === 1) return seg;
    const lead = /^\s*/.exec(seg)![0];
    const core = seg.trim();
    if (!core) return seg;
    sawContent = true;
    if (core.length < open.length + close.length
        || !core.startsWith(open) || !core.endsWith(close)) return null;
    if (open === '*'
        && (/^\*+/.exec(core)![0].length % 2 === 0
          || /\*+$/.exec(core)![0].length % 2 === 0)) return null;
    const inner = core.slice(open.length, core.length - close.length);
    if (open !== close) {
      const iClose = inner.indexOf(close);
      const iOpen = inner.indexOf(open);
      if (iClose !== -1 && (iOpen === -1 || iClose < iOpen)) return null;
    }
    return lead + inner + seg.slice(lead.length + core.length);
  });
  if (!sawContent || parts.some(p => p === null)) return null;
  return parts.join('');
}

// Minimal single-splice diff between two versions of a buffer: shared prefix
// and suffix are kept, only the differing middle is replaced. Used to swap
// the editor buffer (format-on-save, discard) without a whole-document
// replacement — CM6 then maps the selection through the small change, so the
// caret and scroll survive. Returns null when the strings are equal.
export function diffSplice(
  oldStr: string, newStr: string,
): { from: number; to: number; insert: string } | null {
  if (oldStr === newStr) return null;
  let from = 0;
  const max = Math.min(oldStr.length, newStr.length);
  while (from < max && oldStr.charCodeAt(from) === newStr.charCodeAt(from)) from++;
  let endOld = oldStr.length, endNew = newStr.length;
  while (endOld > from && endNew > from
      && oldStr.charCodeAt(endOld - 1) === newStr.charCodeAt(endNew - 1)) {
    endOld--; endNew--;
  }
  return { from, to: endOld, insert: newStr.slice(from, endNew) };
}

// Toggle an ordered list over a block of lines.
//
// Markdown ordered lists render like an HTML <ol>: only the first item's
// number sets the start, every later number is ignored and the renderer
// auto-increments (CommonMark §5.3, and every major renderer — GitHub,
// GitLab, VS Code, Obsidian, Pandoc). The source digits are therefore
// cosmetic: we emit a readable 1./2./3.… sequence but never need to rewrite
// them as the document is edited.
//
// Blank lines inside a multi-line selection are list separators and are left
// untouched — numbering them is what turned selections of files like
// CHANGELOG.md into a mess. The counter only advances on real content lines,
// so the numbering has no gaps. When the block has no content at all (caret on
// an empty line) we start a fresh list with `1. `.
export function toggleOrderedBlock(block: string): string {
  const lines = block.length === 0 ? [''] : block.split('\n');
  const contentLines = lines.filter(l => l.trim() !== '');

  if (contentLines.length === 0) return `1. ${lines[0]}`;

  const allNumbered = contentLines.every(l => ORDERED_RE.test(splitIndent(l)[1]));
  if (allNumbered) {
    return lines.map(l => {
      if (l.trim() === '') return l;
      const [ind, rest] = splitIndent(l);
      return ind + rest.replace(ORDERED_RE, '');
    }).join('\n');
  }

  let n = 0;
  return lines.map(l => {
    if (l.trim() === '') return l;
    const [ind, rest] = splitIndent(l);
    return `${ind}${(n += 1)}. ${rest.replace(LIST_PREFIX_RE, '')}`;
  }).join('\n');
}

// Build the text to insert for a thematic break (`---`) at a cursor whose
// preceding document text is `before`.
//
// A line of dashes sitting directly under a non-blank line is parsed as a
// setext heading underline — it turns that line into an <h2> instead of
// drawing a rule (CommonMark "Setext headings": the setext interpretation
// takes precedence, and a blank line is needed to separate a paragraph from a
// following line of dashes). So we guarantee a blank line precedes the rule by
// topping the trailing newlines up to two (none needed at the start of the
// document).
export function buildHrInsert(before: string): string {
  if (before.length === 0) return '---\n';
  const trailing = /\n*$/.exec(before)?.[0].length ?? 0;
  return '\n'.repeat(Math.max(0, 2 - trailing)) + '---\n';
}

const longestBacktickRun = (s: string): number =>
  (s.match(/`+/g) ?? [] as string[]).reduce((n, r) => Math.max(n, r.length), 0);

// Choose the delimiter for an inline code span around `content`. A code span's
// fence must be longer than the longest backtick run it contains, and content
// that touches a backtick at either edge needs a space of padding, otherwise
// the fence can't be told apart from the content (CommonMark code spans).
export function codeSpan(content: string): { fence: string; pad: string } {
  return {
    fence: '`'.repeat(longestBacktickRun(content) + 1),
    pad: content.startsWith('`') || content.endsWith('`') ? ' ' : '',
  };
}

// The reverse of the padding `codeSpan` adds: a code span that both begins and
// ends with a space (and isn't all spaces) has one space stripped from each
// side by the renderer, so we strip it back off when unwrapping.
export function unpadCode(s: string): string {
  return s.length >= 2 && s.startsWith(' ') && s.endsWith(' ') && s.trim() !== ''
    ? s.slice(1, -1)
    : s;
}

// Strip an inline code span back to its content — the inverse of wrapping with
// `codeSpan`. Returns null when `s` isn't a single fenced code span.
export function stripCodeSpan(s: string): string | null {
  const m = /^(`+)([\s\S]+?)\1$/.exec(s);
  return m ? unpadCode(m[2]) : null;
}

// The fence for a fenced code block: at least three backticks, and longer than
// the longest backtick run in the body so a line inside the block can't close
// it early (CommonMark fenced code blocks).
export function codeFence(body: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
}
