// Unit tests for the pure Markdown line transforms. Run with `npm test`
// (`node --test`). No DOM, no CodeMirror, no bundler.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toggleOrderedBlock, buildHrInsert, buildTableInsert, buildLink, buildCodeBlockInsert, codeSpan, unpadCode, codeFence, stripCodeSpan,
  splitIndent, diffSplice, blockLineSpan, wrapChunks, unwrapChunks,
  togglePrefixBlock, blockMarkerLength, LIST_PREFIX_RE, HEADING_RE, H1_EXACT, BULLET_EXACT, TASK_EXACT,
} from './md-transform.ts';
import { formatTableBlock } from '../lib/md-table.ts';

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
  assert.equal(toggleOrderedBlock('- a\n  - b'), '1. a\n   1. b');
});

test('toggleOrderedBlock: keeps nesting, one counter per level, children under the wider marker', () => {
  assert.equal(toggleOrderedBlock('- fruit\n  - apple\n  - pear\n- veg'),
    '1. fruit\n   1. apple\n   2. pear\n2. veg');
  // Three levels, and an already-indented block keeps its base indent.
  assert.equal(toggleOrderedBlock('  - a\n    - b\n      - c\n  - d'),
    '  1. a\n     1. b\n        1. c\n  2. d');
  // A two-digit parent pushes its children one column further.
  const ten = Array.from({ length: 10 }, (_, i) => `- i${i}`).join('\n') + '\n  - child';
  assert.ok(toggleOrderedBlock(ten).endsWith('10. i9\n    1. child'));
});

test('togglePrefixBlock: applies and strips, skipping blank lines', () => {
  assert.equal(togglePrefixBlock('alpha\n\nbeta', '- ', BULLET_EXACT, LIST_PREFIX_RE), '- alpha\n\n- beta');
  assert.equal(togglePrefixBlock('- alpha\n\n- beta', '- ', BULLET_EXACT, LIST_PREFIX_RE), 'alpha\n\nbeta');
  assert.equal(togglePrefixBlock('a\n  \nb', '- [ ] ', TASK_EXACT, LIST_PREFIX_RE), '- [ ] a\n  \n- [ ] b');
  assert.equal(togglePrefixBlock('a\n\nb', '# ', H1_EXACT, HEADING_RE), '# a\n\n# b');
});

test('togglePrefixBlock: a quote marks blank lines so it stays one quote', () => {
  assert.equal(togglePrefixBlock('a\n\nb', '> ', /^>\s/, /^>\s/, true), '> a\n> \n> b');
  assert.equal(togglePrefixBlock('> a\n> \n> b', '> ', /^>\s/, /^>\s/, true), 'a\n\nb');
});

test('toggleOrderedBlock: an all-blank block keeps its line count', () => {
  assert.equal(toggleOrderedBlock('\n'), '1. \n');
});

test('togglePrefixBlock: an empty line still gets the marker', () => {
  assert.equal(togglePrefixBlock('', '## ', /^##\s/, HEADING_RE), '## ');
  assert.equal(togglePrefixBlock('  ', '- ', BULLET_EXACT, LIST_PREFIX_RE), '- ');
});

test('togglePrefixBlock: converts within a family and keeps the indent', () => {
  assert.equal(togglePrefixBlock('## sub', '# ', H1_EXACT, HEADING_RE), '# sub');
  assert.equal(togglePrefixBlock('  - [ ] x', '- ', BULLET_EXACT, LIST_PREFIX_RE), '  - x');
});

test('togglePrefixBlock: `*` and `+` bullets, and bullets whose text starts with `[`', () => {
  assert.equal(togglePrefixBlock('* star item', '- ', BULLET_EXACT, LIST_PREFIX_RE), 'star item');
  assert.equal(togglePrefixBlock('+ plus', '- ', BULLET_EXACT, LIST_PREFIX_RE), 'plus');
  assert.equal(togglePrefixBlock('- [docs](http://x.io) here', '- ', BULLET_EXACT, LIST_PREFIX_RE), '[docs](http://x.io) here');
  // A real task box is not a bullet: Bullet list re-tags it instead.
  assert.equal(togglePrefixBlock('- [x] done', '- ', BULLET_EXACT, LIST_PREFIX_RE), '- done');
  assert.equal(togglePrefixBlock('* [ ] t', '- [ ] ', TASK_EXACT, LIST_PREFIX_RE), 't');
});

test('blockMarkerLength: indent plus quote, list, task or heading marker', () => {
  assert.equal(blockMarkerLength('- one'), 2);
  assert.equal(blockMarkerLength('  * [ ] t'), 8);
  assert.equal(blockMarkerLength('12. x'), 4);
  assert.equal(blockMarkerLength('> - q'), 4);
  assert.equal(blockMarkerLength('## h'), 3);
  assert.equal(blockMarkerLength('plain'), 0);
  assert.equal(blockMarkerLength('  indented'), 0);
  assert.equal(blockMarkerLength('*em*'), 0);
  assert.equal(blockMarkerLength('#tag'), 0);
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
  // Two spans, not one: the inner single backticks close the first span.
  assert.equal(stripCodeSpan('`a` and `b`'), null);
  assert.equal(stripCodeSpan('``a```'), null);
  assert.equal(stripCodeSpan('```a``'), null);
  assert.equal(stripCodeSpan('``a ` b``'), 'a ` b');
});

test('buildTableInsert: aligned table split off by blank lines at a mid-line cursor', () => {
  const { text, header, body } = buildTableInsert('foo', 'bar', ['', 'Name'], 2);
  const table = [
    '| Header 1 | Name |',
    '| -------- | ---- |',
    '|          |      |',
    '|          |      |',
  ];
  assert.equal(text, '\n\n' + table.join('\n') + '\n\n');
  assert.equal(text.slice(header, header + 8), 'Header 1');
  assert.equal(body, text.indexOf(table[2]) + 2);
  // Already in formatter shape, so the live realign leaves it alone.
  assert.deepEqual(formatTableBlock(table), table);
});

test('buildTableInsert: headers are trimmed and a bare pipe is escaped', () => {
  const { text } = buildTableInsert('', '', ['  a|b ', 'c\\|d'], 1);
  assert.equal(text.split('\n')[0], '| a\\|b | c\\|d |');
});

test('buildTableInsert: gaps top up existing newlines, none at the document edges', () => {
  const t = buildTableInsert('', '', [''], 1).text;
  assert.equal(t, '| Header 1 |\n| -------- |\n|          |\n');
  assert.equal(buildTableInsert('a\n', '\nb', [''], 1).text, '\n' + t);
  assert.equal(buildTableInsert('a\n\n', '\n\nb', [''], 1).text, t.slice(0, -1));
});

test('buildLink: plain link and image', () => {
  assert.equal(buildLink('Docs', 'https://x.io/a'), '[Docs](https://x.io/a)');
  assert.equal(buildLink('A cat', 'assets/cat.png', true), '![A cat](assets/cat.png)');
});

test('buildLink: brackets in the text are escaped, already-escaped ones kept', () => {
  assert.equal(buildLink('a [b] c', 'u'), '[a \\[b\\] c](u)');
  assert.equal(buildLink('x\\]', 'u'), '[x\\]](u)');
  // `\\]` is an escaped backslash then a bare bracket.
  assert.equal(buildLink('x\\\\]', 'u'), '[x\\\\\\]](u)');
  assert.equal(buildLink('[]', 'u'), '[\\[\\]](u)');
});

test('buildLink: a trailing unescaped backslash is escaped so it cannot eat the `]`', () => {
  assert.equal(buildLink('C:\\temp\\', 'x.org'), '[C:\\temp\\\\](x.org)');
  assert.equal(buildLink('a\\\\', 'u'), '[a\\\\](u)');
});

test('buildLink: spaces or parens wrap the destination in angle brackets', () => {
  assert.equal(buildLink('t', 'my file.png'), '[t](<my file.png>)');
  assert.equal(buildLink('t', 'https://en.wikipedia.org/wiki/Rust_(language)'), '[t](<https://en.wikipedia.org/wiki/Rust_(language)>)');
  assert.equal(buildLink('t', 'a b<c>'), '[t](<a b%3Cc%3E>)');
});

test('buildCodeBlockInsert: new block tagged, caret on the empty body line', () => {
  const { text, caret } = buildCodeBlockInsert('intro', '', ' sql extra ');
  assert.equal(text, '\n```sql\n\n```\n');
  assert.equal(text.slice(0, caret!), '\n```sql\n');
});

test('buildCodeBlockInsert: wraps a selection, backticks dropped from the language', () => {
  assert.deepEqual(buildCodeBlockInsert('', 'a ``` b', 'j`s'), { text: '````js\na ``` b\n````\n', caret: null });
  assert.equal(buildCodeBlockInsert('x\n', 'y', '').text, '```\ny\n```\n');
});

test('buildCodeBlockInsert: whole selected lines get no extra blank line in the fence', () => {
  assert.equal(buildCodeBlockInsert('x\n', 'alpha\nbeta\n', '').text, '```\nalpha\nbeta\n```\n');
});
