// Pure, dependency-free Markdown table alignment + pre-save tidier.
//
// Split out of editor.js so the formatter (and its grapheme-width math) can
// be unit-tested in Node without CodeMirror, the DOM, or the Tauri globals.
// editor.js imports `formatMarkdownBuffer`; the rest are exported for tests.
//
// The formatter powers the opt-in editor_format_on_save setting: it aligns
// Markdown tables VS Code-style, normalizes line endings, trims trailing
// whitespace (preserving the two-space hard-break), and collapses to a
// single trailing newline.

// Splits a row's body on un-escaped pipes (so `\|` inside a cell stays
// part of that cell). Returns the raw cell strings — the caller trims.
export function splitTableCells(rowBody) {
  const cells = [];
  let cur = '';
  for (let j = 0; j < rowBody.length; j++) {
    const ch = rowBody[j];
    if (ch === '\\' && rowBody[j + 1] === '|') { cur += '\\|'; j++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

export function parseTableRow(line) {
  let body = line.trim();
  body = body.replace(/^\|/, '').replace(/\|$/, '');
  return splitTableCells(body).map(c => c.trim());
}

export function isTableSeparator(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('-')) return false;
  const cells = parseTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every(c => /^:?-{1,}:?$/.test(c));
}

export function hasUnescapedPipe(line) {
  for (let j = 0; j < line.length; j++) {
    if (line[j] === '\\') { j++; continue; }
    if (line[j] === '|') return true;
  }
  return false;
}

export function parseAlignments(sepLine) {
  return parseTableRow(sepLine).map(c => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return 'default';
  });
}

// Visible (monospace column) width of a string. Counts graphemes via
// Intl.Segmenter and treats Extended_Pictographic emoji + East Asian
// Wide/Fullwidth ranges as 2 cols. Catches both `✅` (single codepoint,
// `.length === 1`, visible 2) and `🛠️` (surrogate pair + VS16, `.length`
// > 2, visible 2) so cells with mixed emoji forms still align.
const _segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
export function graphemeWidth(g) {
  if (/\p{Extended_Pictographic}/u.test(g)) return 2;
  // A grapheme made up of only combining marks / zero-width characters
  // occupies no column. A base+combining grapheme keeps its base's width
  // because codePointAt(0) below reads the base character.
  if (/^[\p{M}​‌‍⁠﻿]+$/u.test(g)) return 0;
  const cp = g.codePointAt(0);
  if (cp == null) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||
    (cp >= 0x2E80 && cp <= 0x303E) ||
    (cp >= 0x3041 && cp <= 0x33FF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0xA000 && cp <= 0xA4CF) ||
    (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE30 && cp <= 0xFE4F) ||
    (cp >= 0xFF00 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    // Supplementary-plane wide ranges: Ideographic Symbols & Punctuation,
    // and CJK Unified Ideographs Ext B–G + the compatibility supplement.
    (cp >= 0x16FE0 && cp <= 0x16FFF) ||
    (cp >= 0x20000 && cp <= 0x3FFFD)
  ) return 2;
  return 1;
}
export function visibleWidth(s) {
  if (!s) return 0;
  if (!_segmenter) return s.length; // fallback for ancient runtimes
  let w = 0;
  for (const { segment } of _segmenter.segment(s)) w += graphemeWidth(segment);
  return w;
}

export function padCell(text, width, align) {
  const pad = width - visibleWidth(text);
  if (pad <= 0) return text;
  if (align === 'right')  return ' '.repeat(pad) + text;
  if (align === 'center') {
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + text + ' '.repeat(pad - l);
  }
  return text + ' '.repeat(pad);
}

// Aligns one detected table block (header, separator, body rows) into
// VS Code-style padded columns with leading/trailing pipes.
export function formatTableBlock(block) {
  const header = parseTableRow(block[0]);
  const aligns = parseAlignments(block[1]);
  const body   = block.slice(2).map(parseTableRow);
  const colCount = Math.max(header.length, aligns.length, ...body.map(r => r.length));
  const pad = arr => { while (arr.length < colCount) arr.push(''); return arr; };
  pad(header);
  while (aligns.length < colCount) aligns.push('default');
  body.forEach(pad);

  const widths = new Array(colCount).fill(3);
  for (let c = 0; c < colCount; c++) {
    widths[c] = Math.max(widths[c], visibleWidth(header[c]));
    for (const r of body) widths[c] = Math.max(widths[c], visibleWidth(r[c]));
  }

  const buildRow = (cells) =>
    '| ' + cells.map((c, i) => padCell(c, widths[i], aligns[i])).join(' | ') + ' |';

  const sepCells = widths.map((w, i) => {
    const a = aligns[i];
    if (a === 'center') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
    if (a === 'left')   return ':' + '-'.repeat(Math.max(2, w - 1));
    if (a === 'right')  return '-'.repeat(Math.max(2, w - 1)) + ':';
    return '-'.repeat(Math.max(3, w));
  });
  const sepRow = '| ' + sepCells.map((s, i) => padCell(s, widths[i], 'default')).join(' | ') + ' |';

  return [buildRow(header), sepRow, ...body.map(buildRow)];
}

// Walks the buffer, leaves fenced code blocks alone, and reformats any
// run of [header | separator | body...] lines into aligned columns.
export function alignMarkdownTables(text) {
  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const marks = fence[1];
      const ch = marks[0];
      // CommonMark: the closing fence must use the same character and be at
      // least as long as the opener, so a ```` block isn't closed by ```.
      if (!inFence) { inFence = true; fenceChar = ch; fenceLen = marks.length; }
      else if (ch === fenceChar && marks.length >= fenceLen) {
        inFence = false; fenceChar = ''; fenceLen = 0;
      }
      out.push(line);
      i++;
      continue;
    }
    if (inFence) { out.push(line); i++; continue; }

    if (i + 1 < lines.length
        && hasUnescapedPipe(line)
        && line.trim() !== ''
        && isTableSeparator(lines[i + 1])) {
      let end = i + 2;
      while (end < lines.length
             && hasUnescapedPipe(lines[end])
             && lines[end].trim() !== ''
             && !lines[end].match(/^\s*(```+|~~~+)/)) {
        end++;
      }
      out.push(...formatTableBlock(lines.slice(i, end)));
      i = end;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

// Pre-save tidier. Normalizes line endings to LF, aligns Markdown
// tables (VS Code-style), trims trailing whitespace per line
// (preserving Markdown's exactly-two-space hard-break syntax), and
// collapses to a single trailing newline. Opt-in via
// editor_format_on_save.
export function formatMarkdownBuffer(text) {
  let out = text.replace(/\r\n?/g, '\n');
  out = alignMarkdownTables(out);
  out = out.split('\n').map(line => {
    if (/\S {2,}$/.test(line)) return line.replace(/ +$/, '  ');
    return line.replace(/[ \t]+$/, '');
  }).join('\n');
  return out.replace(/\n*$/, '\n');
}
