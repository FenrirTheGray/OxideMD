// Live Markdown table alignment for the CodeMirror editor.
//
// After a user edit inside a table block, re-pad that block with the same
// formatter save uses and keep the caret in its cell. A transaction filter
// (not an update listener) so the re-pad rides in the keystroke's own
// transaction: one undo step, no second history entry.
//
// Split out of editor.ts so it can be exercised headlessly in Node — the
// only dependencies are @codemirror/state, the markdown syntax tree, and
// the pure helpers in lib/md-table.ts.

import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { hasUnescapedPipe, isTableStart, realignTableBlock } from '../lib/md-table.ts';

function inCodeBlock(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return true;
  }
  return false;
}

// Line-number range [from, to] of the table block containing `lineNo`, or
// null. Mirrors alignMarkdownTables: rows are non-blank lines with a pipe,
// the block opens at the first header/delimiter pair.
export function tableRangeAt(doc, lineNo) {
  const isRow = (n) => { const t = doc.line(n).text; return t.trim() !== '' && hasUnescapedPipe(t); };
  if (!isRow(lineNo)) return null;
  let from = lineNo, to = lineNo;
  while (from > 1 && isRow(from - 1)) from--;
  while (to < doc.lines && isRow(to + 1)) to++;
  for (let i = from; i < to; i++) {
    if (isTableStart(doc.line(i).text, doc.line(i + 1).text)) return lineNo >= i ? { from: i, to } : null;
  }
  return null;
}

export const liveTableAlign = EditorState.transactionFilter.of((tr) => {
  // Only typed / deleted / pasted edits. Programmatic replacements (Discard,
  // Format document, undo) must land verbatim, or the buffer diverges from
  // what the caller just wrote and the dirty flag lies.
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('delete'))) return tr;
  if (tr.isUserEvent('input.type.compose')) return tr;
  // The realign replaces the selection with one caret, so with multiple
  // cursors it would silently drop all but the main one.
  const sel = tr.newSelection.main;
  if (!sel.empty || tr.newSelection.ranges.length > 1) return tr;
  const doc = tr.newDoc;
  const line = doc.lineAt(sel.head);
  const range = tableRangeAt(doc, line.number);
  if (!range || inCodeBlock(tr.state, sel.head)) return tr;
  const block = [];
  for (let n = range.from; n <= range.to; n++) block.push(doc.line(n).text);
  const { lines, caret } = realignTableBlock(block, { line: line.number - range.from, col: sel.head - line.from });
  const from = doc.line(range.from).from, to = doc.line(range.to).to;
  const next = lines.join('\n');
  if (next === doc.sliceString(from, to)) return tr;
  let anchor = from + caret.col;
  for (let i = 0; i < caret.line; i++) anchor += lines[i].length + 1;
  return [tr, { changes: { from, to, insert: next }, selection: { anchor }, sequential: true }];
});
