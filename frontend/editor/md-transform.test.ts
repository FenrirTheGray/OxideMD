// Unit tests for the pure Markdown line transforms. Run with `npm test`
// (`node --test`). No DOM, no CodeMirror, no bundler.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toggleOrderedBlock, buildHrInsert, codeSpan, unpadCode, codeFence, stripCodeSpan,
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
