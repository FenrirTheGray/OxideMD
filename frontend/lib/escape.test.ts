// Run with: node --test (see package.json "test" script).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml } from "./escape.ts";

test('escapeHtml: escapes the five HTML-sensitive characters', () => {
  assert.equal(
    escapeHtml(`<a href="x" title='y'>&</a>`),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
  );
});

test('escapeHtml: leaves ordinary text untouched', () => {
  assert.equal(escapeHtml('plain text 123'), 'plain text 123');
});

test('escapeHtml: coerces non-strings via String()', () => {
  assert.equal(escapeHtml(42 as any), '42');
  assert.equal(escapeHtml(null as any), 'null');
});
