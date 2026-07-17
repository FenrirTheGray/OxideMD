// Unit tests for the pure Markdown line transforms. Run with `npm test`
// (`node --test`). No DOM, no CodeMirror, no bundler.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toggleOrderedBlock, buildHrInsert, codeSpan, unpadCode, codeFence, stripCodeSpan,
  splitIndent, diffSplice, blockLineSpan, wrapChunks, unwrapChunks,
} from './md-transform.ts';

test('toggleOrderedBlock: numbers a single line', () => {
  assert.equal(toggleOrderedBlock('Foo'), '1. Foo');
});

test('toggleOrderedBlock: starts a list on an empty block', () => {
  assert.equal(toggleOrderedBlock(''), '1. ');
});

test('toggleOrderedBlock: toggles a numbered line back off', () => {
  assert.equal(toggleOrderedBlock('1. Foo'), 'Foo');
});

test('toggleOrderedBlock: numbers content sequentially, leaving blank separators', () => {
  // Blank lines must NOT be numbered, and the counter must not skip over them
  // (no 1, 3, 4 gaps) — this is the CHANGELOG.md regression.
  assert.equal(
    toggleOrderedBlock('## [4.6.0]\n\n- item\n\n- other'),
    '1. ## [4.6.0]\n\n2. item\n\n3. other',
  );
});

test('toggleOrderedBlock: converts bullets to an ordered list', () => {
  assert.equal(toggleOrderedBlock('- a\n- b\n- c'), '1. a\n2. b\n3. c');
});

test('toggleOrderedBlock: toggle-off preserves blank separators', () => {
  assert.equal(toggleOrderedBlock('1. Foo\n\n2. Bar'), 'Foo\n\nBar');
});

test('toggleOrderedBlock: numbers nested items after their indentation', () => {
  // Anchored regexes used to double-prefix indented lines (`1.   - b`).
  assert.equal(toggleOrderedBlock('- a\n  - b'), '1. a\n  2. b');
});

test('toggleOrderedBlock: toggles indented numbered lines back off', () => {
  assert.equal(toggleOrderedBlock('1. a\n  2. b'), 'a\n  b');
});

test('toggleOrderedBlock: recognizes the `1)` delimiter style on input', () => {
  assert.equal(toggleOrderedBlock('1) a\n2) b'), 'a\nb');
  // Re-tagging a `)` list generates the canonical `.` style.
  assert.equal(toggleOrderedBlock('1) a\nb'), '1. a\n2. b');
});

test('splitIndent: separates leading whitespace from the rest', () => {
  assert.deepEqual(splitIndent('  - x'), ['  ', '- x']);
  assert.deepEqual(splitIndent('\t# h'), ['\t', '# h']);
  assert.deepEqual(splitIndent('x'), ['', 'x']);
  assert.deepEqual(splitIndent(''), ['', '']);
});

test('diffSplice: null on equal strings, minimal splice otherwise', () => {
  assert.equal(diffSplice('abc', 'abc'), null);
  assert.deepEqual(diffSplice('abc', 'aXc'), { from: 1, to: 2, insert: 'X' });
  assert.deepEqual(diffSplice('abc', 'abXc'), { from: 2, to: 2, insert: 'X' });
  assert.deepEqual(diffSplice('abXc', 'abc'), { from: 2, to: 3, insert: '' });
});

test('diffSplice: applying the splice reconstructs the target', () => {
  const cases = [
    ['', 'a'], ['a', ''], ['aaa', 'aa'], ['aa', 'aaa'],
    ['hello world', 'hello brave world'], ['x', 'y'],
    ['| a | b |', '| a   | b   |'],
  ];
  for (const [a, b] of cases) {
    const s = diffSplice(a, b);
    const applied = s ? a.slice(0, s.from) + s.insert + a.slice(s.to) : a;
    assert.equal(applied, b, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
});

test('blockLineSpan: selection ending at column 0 stays on the previous line', () => {
  const v = 'one\ntwo\nthree';
  // Triple-click / Shift+Down select through the newline: block is line 1 only.
  assert.deepEqual(blockLineSpan(v, 0, 4), { lineStart: 0, lineEnd: 3 });
  // A mid-line selection expands to its full line.
  assert.deepEqual(blockLineSpan(v, 5, 6), { lineStart: 4, lineEnd: 7 });
  // A bare caret at column 0 still targets its own line.
  assert.deepEqual(blockLineSpan(v, 4, 4), { lineStart: 4, lineEnd: 7 });
  // Last line without trailing newline.
  assert.deepEqual(blockLineSpan(v, 9, 11), { lineStart: 8, lineEnd: 13 });
});

test('wrapChunks: edge whitespace stays outside the markers', () => {
  assert.equal(wrapChunks('word ', '**'), '**word** ');
  assert.equal(wrapChunks(' word', '**'), ' **word**');
  assert.equal(wrapChunks('   ', '**'), '   '); // whitespace-only: untouched
});

test('wrapChunks: blank-line chunks are wrapped separately', () => {
  assert.equal(wrapChunks('a\n\nb', '**'), '**a**\n\n**b**');
  assert.equal(wrapChunks('a\n \nb', '*'), '*a*\n \n*b*');
  assert.equal(wrapChunks('a\n\nb', '<u>', '</u>'), '<u>a</u>\n\n<u>b</u>');
});

test('unwrapChunks: inverse of wrapChunks', () => {
  const cases: [string, string, string?][] = [
    ['word ', '**'], ['a\n\nb', '~~'], [' x\n\n y ', '<u>', '</u>'],
  ];
  for (const [text, open, close] of cases) {
    assert.equal(unwrapChunks(wrapChunks(text, open, close), open, close), text);
  }
});

test('unwrapChunks: null when any content chunk is not wrapped', () => {
  assert.equal(unwrapChunks('**a**\n\nb', '**'), null);
  assert.equal(unwrapChunks('plain', '**'), null);
});

test('unwrapChunks: even star runs are bold, not italic', () => {
  // `**text**` has star edges, but stripping one star would corrupt the
  // bold marker — the italic toggle must wrap instead.
  assert.equal(unwrapChunks('**text**', '*'), null);
  assert.equal(unwrapChunks('***text***', '*'), '**text**');
  assert.equal(unwrapChunks('*text*', '*'), 'text');
});

test('unwrapChunks: edges belonging to different spans are refused', () => {
  assert.equal(unwrapChunks('<u>a</u> x <u>b</u>', '<u>', '</u>'), null);
});

test('buildHrInsert: no separator at the start of the document', () => {
  assert.equal(buildHrInsert(''), '---\n');
});

test('buildHrInsert: blank line after a paragraph so it is not a setext heading', () => {
  // `Hello\n---` would render "Hello" as an <h2>; we need a blank line.
  assert.equal(buildHrInsert('Hello'), '\n\n---\n');
});

test('buildHrInsert: tops up a single trailing newline', () => {
  assert.equal(buildHrInsert('Hello\n'), '\n---\n');
});

test('buildHrInsert: no extra blank when one already precedes', () => {
  assert.equal(buildHrInsert('Hello\n\n'), '---\n');
});

test('codeSpan: single backtick for plain content', () => {
  assert.deepEqual(codeSpan('plain'), { fence: '`', pad: '' });
});

test('codeSpan: fence outgrows the longest run inside', () => {
  // Content has a run of two backticks, so the fence needs three.
  assert.deepEqual(codeSpan('a ``b`` c'), { fence: '```', pad: '' });
});

test('codeSpan: pads when content touches a backtick at an edge', () => {
  assert.deepEqual(codeSpan('`x'), { fence: '``', pad: ' ' });
});

test('unpadCode: strips a symmetric space pair, leaves others', () => {
  assert.equal(unpadCode(' `x` '), '`x`');
  assert.equal(unpadCode('plain'), 'plain');
  assert.equal(unpadCode('   '), '   '); // all spaces: untouched
});

test('codeFence: at least three backticks, grows past inner runs', () => {
  assert.equal(codeFence('no backticks here'), '```');
  assert.equal(codeFence('has ```` four'), '`````');
});

test('codeSpan / stripCodeSpan: wrapping then unwrapping round-trips', () => {
  // The wrap (codeSpan) and unwrap (stripCodeSpan, used by wrapCode's toggle)
  // paths must compose: backtick runs and edge padding can't lose content.
  for (const x of ['plain', '`x', 'x`', 'a`b', 'a``b', '`', '``', '` `']) {
    const { fence, pad } = codeSpan(x);
    const wrapped = fence + pad + x + pad + fence;
    assert.equal(stripCodeSpan(wrapped), x, `round-trip for ${JSON.stringify(x)}`);
  }
});

test('stripCodeSpan: returns null when not a code span', () => {
  assert.equal(stripCodeSpan('not code'), null);
  assert.equal(stripCodeSpan('`unbalanced'), null);
});
