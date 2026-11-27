import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { GFM } from '@lezer/markdown';
import { buildLivePreview, snapPastHidden, taskToggleChange } from './live-preview.ts';

// The source ranges rendered mode hides (`out`), paints a bullet over
// (`bullets`) or makes a task box (`boxes`), with the caret at `cursor`.
function replaced(doc: string, cursor: number) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ extensions: [GFM] })],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  const { deco, atomic } = buildLivePreview(state, [{ from: 0, to: doc.length }]);
  const out: string[] = [], boxes: string[] = [], bullets: string[] = [];
  for (let c = deco.iter(); c.value; c.next()) {
    const cls: string = c.value.spec.class ?? '';
    // Rendered mode must never replace a range: see live-preview.ts.
    assert.equal(c.value.spec.widget, undefined);
    assert.ok(cls, 'every decoration is a class');
    if (cls.includes('cm-lp-hide')) out.push(doc.slice(c.from, c.to));
    else if (cls.includes('cm-lp-bullet')) bullets.push(doc.slice(c.from, c.to));
  }
  for (let c = atomic.iter(); c.value; c.next()) boxes.push(`${doc.slice(c.from, c.to)}${c.value.spec.attributes['aria-checked']}`);
  return { out, boxes, bullets };
}

test('livePreview: inline marks hide until the caret touches their node', () => {
  const doc = 'a **bold** and `code`\n\nlast';
  assert.deepEqual(replaced(doc, doc.length).out, ['**', '**', '`', '`']);
  assert.deepEqual(replaced(doc, 5).out, ['`', '`']); // caret inside the bold
});

test('livePreview: heading and quote marks come back on their own line', () => {
  const doc = '# Title\n\n> quote\n\nend';
  assert.deepEqual(replaced(doc, doc.length).out, ['# ', '> ']);
  assert.deepEqual(replaced(doc, 3).out, ['> ']);
});

test('livePreview: a link hides its target, bare brackets stay literal', () => {
  const doc = '[text](https://example.com) and [4.15.0] and <https://a.b>\n\nend';
  assert.deepEqual(replaced(doc, doc.length).out, ['[', ']', '(', 'https://example.com', ')', '<', '>']);
});

test('livePreview: a task box takes the bullet\'s place; the marker shows only under the caret', () => {
  const doc = '- [ ] todo\n- [x] done\n- plain\n1. [ ] numbered\n\nend';
  const away = replaced(doc, doc.length);
  assert.deepEqual(away.boxes, ['[ ]false', '[x]true', '[ ]false']);
  assert.deepEqual(away.out, ['- ', '- ']);   // a task's dash and gap are hidden
  assert.deepEqual(away.bullets, ['-']);      // a plain item gets its dot; a number stays
  // Caret in the task's text: nothing changes, so typing does not flicker.
  assert.deepEqual(replaced(doc, 8).out, ['- ', '- ']);
  // Caret on the marker itself (line start): that line shows it as written.
  assert.deepEqual(replaced(doc, 0).out, ['- ']);
  assert.deepEqual(replaced(doc, 22).bullets, []); // start of "- plain"
  assert.deepEqual(replaced(doc, 24).bullets, ['-']); // in "plain"
});

test('livePreview: nothing inside a table or a code block is hidden', () => {
  const doc = '| **a** | b |\n| --- | --- |\n| `c` | d |\n\n```js\nconst a = "**x**";\n```\n\nend';
  // Only the fences go; the table and the code text are left alone.
  assert.deepEqual(replaced(doc, doc.length).out, ['```', '```']);
});

test('taskToggleChange flips one character and refuses anything else', () => {
  const state = EditorState.create({ doc: '- [ ] a\n- [X] b' });
  assert.deepEqual(taskToggleChange(state, 2), { from: 3, to: 4, insert: 'x' });
  assert.deepEqual(taskToggleChange(state, 10), { from: 11, to: 12, insert: ' ' });
  assert.equal(taskToggleChange(state, 0), null);
});

test('a click that lands before trailing hidden markup goes to the line end', () => {
  const doc = 'plain **bold**\n\na [link](https://x.y) more\n\nend';
  const click = (from: number, at: number) => EditorState.create({
    doc,
    selection: EditorSelection.cursor(from),
    extensions: [markdown({ extensions: [GFM] }), snapPastHidden],
  }).update({ selection: EditorSelection.cursor(at), userEvent: 'select.pointer' }).state.selection.main.head;
  assert.equal(click(doc.length, 12), 14); // after "bold", only `**` follows
  assert.equal(click(doc.length, 10), 10); // inside "bold": left alone
  assert.equal(click(doc.length, 22), 22); // after "link": " more" follows the target
  assert.equal(click(9, 12), 12);          // caret already in the bold: its marks are showing
});
