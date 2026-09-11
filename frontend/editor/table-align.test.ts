import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { liveTableAlign } from './table-align.ts';

function state(doc, ...cursors) {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(cursors.map((c) => EditorSelection.cursor(c))),
    extensions: [markdown(), history(), liveTableAlign, EditorState.allowMultipleSelections.of(true)],
  });
}
function type(st, text, userEvent = 'input.type') {
  return st.update(st.replaceSelection(text), { userEvent }).state;
}

const TABLE = '| a | bb |\n|---|---|\n| c | d |';

test('liveTableAlign: a keystroke in a table re-pads the block and keeps the caret', () => {
  const st = type(state(TABLE, TABLE.length - 2), 'x'); // after "d"
  assert.equal(st.doc.toString(), '| a   | bb  |\n| --- | --- |\n| c   | dx  |');
  assert.equal(st.doc.sliceString(0, st.selection.main.head).endsWith('| dx'), true);
});

test('liveTableAlign: realign rides in the same undo step', () => {
  let st = type(state(TABLE, TABLE.length - 2), 'x');
  let undone = st;
  undo({ state: st, dispatch: (tr) => { undone = tr.state; } });
  assert.equal(undone.doc.toString(), TABLE);
});

test('liveTableAlign: starting a new row with `|` keeps the caret inside it', () => {
  const st = type(type(state(TABLE, TABLE.length), '\n'), '|');
  assert.equal(st.doc.line(4).text, '|     |     |');
  assert.equal(st.selection.main.head, st.doc.line(4).from + 2);
  // The next character extends the first cell, not a new column.
  assert.equal(type(st, 'e').doc.line(4).text, '| e   |     |');
});

test('liveTableAlign: multiple cursors survive a keystroke in a table', () => {
  const doc = '| a | bb |\n|---|---|\n| c | d |\n| c | e |';
  const st = type(state(doc, doc.length - 12, doc.length - 1), 'x');
  assert.equal(st.selection.ranges.length, 2);
});

test('liveTableAlign: programmatic replacements and undo are left alone', () => {
  const st = state('| a | bb |\n|---|---|\n| c | d ', 12);
  const next = st.update({ changes: { from: 0, to: st.doc.length, insert: TABLE } }).state;
  assert.equal(next.doc.toString(), TABLE);
});

test('liveTableAlign: tables inside fenced code are not touched', () => {
  const doc = '```\n| a | bb |\n|---|---|\n| c | d |\n```';
  const st = type(state(doc, doc.length - 6), 'x');
  assert.equal(st.doc.toString(), '```\n| a | bb |\n|---|---|\n| c | dx |\n```');
});

test('liveTableAlign: a pipe line above the header is not swallowed into the block', () => {
  const doc = 'x | y\n| a | bb |\n|---|---|\n| c | d |';
  const st = type(state(doc, 3), 'z'); // inside "x | y"
  assert.equal(st.doc.line(1).text, 'x |z y');
});
