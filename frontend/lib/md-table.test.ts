// Unit tests for the Markdown table aligner + pre-save tidier.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitTableCells, parseTableRow, isTableSeparator, hasUnescapedPipe,
  parseAlignments, visibleWidth, padCell,
  alignMarkdownTables, formatMarkdownBuffer,
} from "./md-table.ts";

test('splitTableCells: respects escaped pipes', () => {
  assert.deepEqual(splitTableCells('a|b|c'), ['a', 'b', 'c']);
  assert.deepEqual(splitTableCells('a\\|b|c'), ['a\\|b', 'c']);
});

test('parseTableRow: strips outer pipes and trims', () => {
  assert.deepEqual(parseTableRow('| a | b |'), ['a', 'b']);
  assert.deepEqual(parseTableRow('a | b'), ['a', 'b']);
});

test('isTableSeparator: recognizes separator rows only', () => {
  assert.equal(isTableSeparator('| --- | --- |'), true);
  assert.equal(isTableSeparator('|:--|--:|:-:|'), true);
  assert.equal(isTableSeparator('| a | b |'), false);
  assert.equal(isTableSeparator(''), false);
  assert.equal(isTableSeparator('| -x- |'), false);
});

test('hasUnescapedPipe', () => {
  assert.equal(hasUnescapedPipe('a | b'), true);
  assert.equal(hasUnescapedPipe('a \\| b'), false);
  assert.equal(hasUnescapedPipe('no pipes here'), false);
});

test('parseAlignments: maps colon markers', () => {
  assert.deepEqual(parseAlignments('|:--|--:|:-:|---|'),
    ['left', 'right', 'center', 'default']);
});

test('visibleWidth: ASCII, CJK, and emoji count correctly', () => {
  assert.equal(visibleWidth('abc'), 3);
  assert.equal(visibleWidth(''), 0);
  assert.equal(visibleWidth('中文'), 4);      // 2 wide chars
  assert.equal(visibleWidth('✅'), 2);         // single-codepoint emoji
  assert.equal(visibleWidth('🛠️'), 2);        // surrogate pair + VS16
});

test('padCell: alignment padding to a target width', () => {
  assert.equal(padCell('ab', 5, 'default'), 'ab   ');
  assert.equal(padCell('ab', 5, 'right'), '   ab');
  assert.equal(padCell('ab', 6, 'center'), '  ab  ');
  // No shrinking when content already exceeds width.
  assert.equal(padCell('abcdef', 3, 'default'), 'abcdef');
});

test('alignMarkdownTables: pads columns to a uniform grid', () => {
  const input = [
    '| Name | Age |',
    '| --- | --- |',
    '| Alice | 30 |',
    '| Bob | 1 |',
  ].join('\n');
  const out = alignMarkdownTables(input).split('\n');
  // Every row is the same visible length once aligned.
  const len = out[0].length;
  for (const row of out) assert.equal(row.length, len, row);
  assert.equal(out[0], '| Name  | Age |');
  assert.equal(out[2], '| Alice | 30  |');
});

test('alignMarkdownTables: preserves alignment colons in the separator', () => {
  const input = [
    '| a | b | c |',
    '|:--|--:|:-:|',
    '| 1 | 2 | 3 |',
  ].join('\n');
  const sep = alignMarkdownTables(input).split('\n')[1];
  assert.match(sep, /^\| :-+ \| -+: \| :-+: \|$/);
});

test('alignMarkdownTables: leaves fenced code blocks untouched', () => {
  const input = [
    '```',
    '| not | a | table |',
    '| --- | --- | --- |',
    '```',
  ].join('\n');
  assert.equal(alignMarkdownTables(input), input);
});

test('formatMarkdownBuffer: normalizes endings and trailing whitespace', () => {
  // CRLF → LF; a trailing tab is stripped; 3+ trailing spaces on a
  // non-blank line collapse to the two-space hard break (see next test).
  const input = 'plain line\t\r\nlast\r\n\r\n\r\n';
  const out = formatMarkdownBuffer(input);
  assert.equal(out, 'plain line\nlast\n');
});

test('formatMarkdownBuffer: preserves the two-space hard break', () => {
  const out = formatMarkdownBuffer('hard break here  \nnext');
  assert.equal(out, 'hard break here  \nnext\n');
  // Three-plus trailing spaces collapse to exactly two.
  assert.equal(formatMarkdownBuffer('x     \ny'), 'x  \ny\n');
});

test('formatMarkdownBuffer: ensures exactly one trailing newline', () => {
  assert.equal(formatMarkdownBuffer('no newline'), 'no newline\n');
  assert.equal(formatMarkdownBuffer('many\n\n\n'), 'many\n');
});
