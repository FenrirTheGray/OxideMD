// Pure, dependency-free Markdown line transforms shared by the editor's
// formatting actions. Deliberately free of CodeMirror imports so they can be
// unit-tested directly with `node --test` (see md-transform.test.ts), the same
// way the accelerator layer is.

// The marker of any list item (bullet, task, or ordered) at the start of a
// line, so a line can be re-tagged from one list type to another.
export const LIST_PREFIX_RE = /^(?:-\s\[[ xX]\]\s|-\s|\d+\.\s)/;

const ORDERED_RE = /^(\d+)\.\s/;

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

  const allNumbered = contentLines.every(l => ORDERED_RE.test(l));
  if (allNumbered) {
    return lines.map(l => (l.trim() === '' ? l : l.replace(ORDERED_RE, ''))).join('\n');
  }

  let n = 0;
  return lines
    .map(l => (l.trim() === '' ? l : `${(n += 1)}. ${l.replace(LIST_PREFIX_RE, '')}`))
    .join('\n');
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
