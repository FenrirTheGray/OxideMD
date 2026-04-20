// Markdown formatting actions for the CodeMirror 6 editor.
//
// Every mutation is a single CM6 transaction so undo/redo gets a clean
// history entry per action. After dispatch we re-focus the view because
// toolbar clicks momentarily blur the editor.

import { EditorSelection } from '@codemirror/state';

function getSel(view) {
  const r = view.state.selection.main;
  return { s: r.from, e: r.to };
}
function getDoc(view) { return view.state.doc.toString(); }

// Apply a change and (optionally) a new selection in one transaction. The
// selection coordinates are absolute positions in the *new* doc, so callers
// compute them in terms of the inserted text's length. Re-focuses the view
// because toolbar clicks pull focus away.
function edit(view, from, to, insert, selFrom, selTo) {
  const tr = { changes: { from, to, insert } };
  if (selFrom != null) {
    tr.selection = EditorSelection.range(selFrom, selTo ?? selFrom);
  }
  view.dispatch(tr);
  view.focus();
}

function atLineStart(v, pos) {
  return pos === 0 || v[pos - 1] === '\n';
}

// Block-op helper: expand the current selection to cover whole lines.
// Mirrors the textarea version's edge case where a selection ending at a
// line boundary doesn't pull in the empty line below.
function expandToLines(view) {
  const v = getDoc(view);
  const { s, e } = getSel(view);
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = v.indexOf('\n', e);
  if (lineEnd === -1) lineEnd = v.length;
  if (e > s && e === lineStart && lineEnd !== v.length) lineEnd = lineStart;
  return { lineStart, lineEnd, block: v.slice(lineStart, lineEnd) };
}

// ── Inline wrappers (bold / italic / strike / code) ───────────────────
function wrapInline(view, marker, placeholder) {
  const v = getDoc(view);
  const { s, e } = getSel(view);
  const sel = v.slice(s, e);
  const mLen = marker.length;

  // Case A: marker sits just outside the selection (e.g. caret was inside
  // an existing **bold** pair, selection covers just `bold`) — strip the
  // outer markers.
  if (sel && s >= mLen && v.slice(s - mLen, s) === marker && v.slice(e, e + mLen) === marker) {
    edit(view, s - mLen, e + mLen, sel, s - mLen, s - mLen + sel.length);
    return;
  }
  // Case B: selection includes the markers (user selected `**bold**`) —
  // strip them.
  if (sel.length >= 2 * mLen && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(mLen, -mLen);
    edit(view, s, e, inner, s, s + inner.length);
    return;
  }
  // Case C: wrap. With no selection we drop in a placeholder and select
  // it so the user can immediately type over it.
  const inner = sel || placeholder;
  edit(view, s, e, marker + inner + marker, s + mLen, s + mLen + inner.length);
}

// ── Line prefix toggles (headings / list / quote / task) ──────────────
function togglePrefix(view, prefix, exactRe, familyRe = exactRe) {
  const { lineStart, lineEnd, block } = expandToLines(view);
  const lines = block.length === 0 ? [''] : block.split('\n');
  const allExact = lines.every(l => exactRe.test(l));

  const next = allExact
    ? lines.map(l => l.replace(exactRe, ''))
    : lines.map(l => prefix + l.replace(familyRe, ''));
  const result = next.join('\n');
  edit(view, lineStart, lineEnd, result, lineStart, lineStart + result.length);
}

function toggleOrdered(view) {
  const numRe = /^(\d+)\.\s/;
  const { lineStart, lineEnd, block } = expandToLines(view);
  const lines = block.length === 0 ? [''] : block.split('\n');
  const allNumbered = lines.every(l => numRe.test(l));

  const next = allNumbered
    ? lines.map(l => l.replace(numRe, ''))
    : lines.map((l, i) => `${i + 1}. ${l.replace(LIST_RE, '')}`);
  const result = next.join('\n');
  edit(view, lineStart, lineEnd, result, lineStart, lineStart + result.length);
}

// ── Block inserts (link / image / code block / hr) ────────────────────
function insertLink(view) {
  const v = getDoc(view);
  const { s, e } = getSel(view);
  const sel = v.slice(s, e);
  const text = sel || 'link text';
  const snippet = `[${text}](url)`;
  const urlStart = s + 1 + text.length + 2;  // '[' + text + ']('
  edit(view, s, e, snippet, urlStart, urlStart + 3);
}

function insertImage(view) {
  const v = getDoc(view);
  const { s, e } = getSel(view);
  const sel = v.slice(s, e);
  const alt = sel || 'alt';
  const snippet = `![${alt}](url)`;
  const urlStart = s + 2 + alt.length + 2;  // '![' + alt + ']('
  edit(view, s, e, snippet, urlStart, urlStart + 3);
}

function insertCodeBlock(view) {
  const v = getDoc(view);
  const { s, e } = getSel(view);
  const sel = v.slice(s, e);
  const pre = atLineStart(v, s) ? '' : '\n';
  const snippet = `${pre}\`\`\`\n${sel}\n\`\`\`\n`;
  if (!sel) {
    const caret = s + pre.length + 4;  // pre + '```\n'
    edit(view, s, e, snippet, caret, caret);
  } else {
    edit(view, s, e, snippet);
  }
}

function insertHr(view) {
  const v = getDoc(view);
  const { s } = getSel(view);
  const pre = atLineStart(v, s) ? '' : '\n';
  edit(view, s, s, `${pre}---\n`);
}

// ── Indent / outdent (Tab / Shift+Tab) ────────────────────────────────
function indent(view) {
  const v = getDoc(view);
  const { s, e } = getSel(view);
  const sel = v.slice(s, e);
  if (!sel.includes('\n')) {
    edit(view, s, e, '  ', s + 2, s + 2);
    return;
  }
  const { lineStart, lineEnd, block } = expandToLines(view);
  const result = block.split('\n').map(l => '  ' + l).join('\n');
  edit(view, lineStart, lineEnd, result, lineStart, lineStart + result.length);
}

function outdent(view) {
  const { lineStart, lineEnd, block } = expandToLines(view);
  const lines = block.split('\n');
  const result = lines.map(l => l.replace(/^ {1,2}/, '')).join('\n');
  if (result === block) return;
  edit(view, lineStart, lineEnd, result, lineStart, lineStart + result.length);
}

// ── Dispatcher ────────────────────────────────────────────────────────
const H1_EXACT   = /^#\s/;
const H2_EXACT   = /^##\s/;
const H3_EXACT   = /^###\s/;
const HEADING_RE = /^#{1,6}\s/;
const BULLET_EXACT = /^-\s(?!\[)/;
const TASK_EXACT   = /^-\s\[[ xX]\]\s/;
const LIST_RE      = /^(?:-\s\[[ xX]\]\s|-\s|\d+\.\s)/;
const QUOTE_RE   = /^>\s/;

export function applyFormat(view, action) {
  if (!view) return;
  switch (action) {
    case 'bold':      return wrapInline(view, '**', 'bold text');
    case 'italic':    return wrapInline(view, '*',  'italic text');
    case 'strike':    return wrapInline(view, '~~', 'strikethrough');
    case 'code':      return wrapInline(view, '`',  'code');
    case 'h1':        return togglePrefix(view, '# ',     H1_EXACT, HEADING_RE);
    case 'h2':        return togglePrefix(view, '## ',    H2_EXACT, HEADING_RE);
    case 'h3':        return togglePrefix(view, '### ',   H3_EXACT, HEADING_RE);
    case 'ul':        return togglePrefix(view, '- ',     BULLET_EXACT, LIST_RE);
    case 'task':      return togglePrefix(view, '- [ ] ', TASK_EXACT,   LIST_RE);
    case 'quote':     return togglePrefix(view, '> ',     QUOTE_RE);
    case 'ol':        return toggleOrdered(view);
    case 'link':      return insertLink(view);
    case 'image':     return insertImage(view);
    case 'codeblock': return insertCodeBlock(view);
    case 'hr':        return insertHr(view);
    case 'indent':    return indent(view);
    case 'outdent':   return outdent(view);
  }
}
