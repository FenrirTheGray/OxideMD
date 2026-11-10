import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMatches } from './text-search.ts';

const hits = (text: string, q: string, cs = false) =>
  findMatches(text, q, cs).map(([s, e]) => text.slice(s, e));

test('offsets after İ point at the original text', () => {
  const text = 'İstanbul is a big city.';
  assert.deepEqual(hits(text, 'city'), ['city']);
  assert.deepEqual(hits(text, '.'), ['.']);
  assert.deepEqual(findMatches(text, '.', false), [[22, 23]]);
});

test('a match ending inside a multi-unit fold covers the whole source char', () => {
  assert.deepEqual(hits('xİy', 'xi'), ['xİ']);
  assert.deepEqual(hits('İstanbul', 'İst'), ['İst']);
});

test('case sensitivity and non-overlap', () => {
  assert.deepEqual(hits('Alpha alpha', 'alpha', true), ['alpha']);
  assert.deepEqual(hits('Alpha alpha', 'ALPHA'), ['Alpha', 'alpha']);
  assert.equal(findMatches('aaaa', 'aa', false).length, 2);
  assert.deepEqual(findMatches('abc', '', false), []);
});

test('astral characters keep their offsets', () => {
  assert.deepEqual(hits('😀 Ab', 'ab'), ['Ab']);
});
