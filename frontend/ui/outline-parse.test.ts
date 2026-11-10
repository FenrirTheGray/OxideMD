import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutline } from './outline-parse.ts';

const texts = (src: string) => parseOutline(src).map((e) => e.text);

test('C1: a ~~~ line inside a ``` block does not end the block', () => {
  assert.deepEqual(texts('# One\n\n```\n~~~\n```\n\n## Two\n\n## Three\n'), ['One', 'Two', 'Three']);
});

test('C2: ``` lines inside a ```` fence stay code', () => {
  assert.deepEqual(texts('# One\n\n````md\n```sh\n# install deps\n```\n````\n\n## Two\n'), ['One', 'Two']);
});

test('C3: --- after a quote, list item or code block is a rule, not a setext heading', () => {
  const src = '# Top\n\n> quote line\n---\n\n- item line\n---\n\n```\ncode\n```\n---\n\n    indented code\n---\n\n# End\n';
  assert.deepEqual(texts(src), ['Top', 'End']);
});

test('C4: headings in quotes, list items, indented 1-3 spaces, and empty ones count', () => {
  const src = '# Top\n\n> # In quote\n\n- # In list\n\n # One space indent\n\n#\n\n## After empty\n';
  assert.deepEqual(parseOutline(src), [
    { level: 1, text: 'Top', line: 1 },
    { level: 1, text: 'In quote', line: 3 },
    { level: 1, text: 'In list', line: 5 },
    { level: 1, text: 'One space indent', line: 7 },
    { level: 1, text: '', line: 9 },
    { level: 2, text: 'After empty', line: 11 },
  ]);
});

test('C4: four-space indent is code, not a heading', () => {
  assert.deepEqual(texts('    # code\n\n# Real\n'), ['Real']);
});

test('C5: setext headings in a CRLF file, with correct lines', () => {
  assert.deepEqual(parseOutline('Alpha\r\n=====\r\n\r\ntext\r\n\r\nBeta\r\n----\r\n\r\n# Gamma\r\n'), [
    { level: 1, text: 'Alpha', line: 1 },
    { level: 2, text: 'Beta', line: 6 },
    { level: 1, text: 'Gamma', line: 9 },
  ]);
});

test('C7: a closing # needs a space before it', () => {
  assert.deepEqual(texts('# Learn C#\n\n## F# notes\n\n## Closed ##\n'), ['Learn C#', 'F# notes', 'Closed']);
});

test('C8: entries show heading text, not markup', () => {
  const src = '# **Bold** title\n\n## See [the docs](http://x.io "t")\n\n## The `run` command\n\n'
    + '## ![logo](a.png) and <http://a.io>\n\n## Not \\*em\\*\n\nPara one\npara two\n===\n';
  assert.deepEqual(texts(src), [
    'Bold title', 'See the docs', 'The run command', 'logo and http://a.io', 'Not *em*', 'Para one para two',
  ]);
});

test('C8: a two-line setext heading starts on its first line', () => {
  assert.deepEqual(parseOutline('Para one\npara two\n===\n'), [{ level: 1, text: 'Para one para two', line: 1 }]);
});

test('heading attributes are stripped, # inside a fence is ignored', () => {
  assert.deepEqual(texts('# Title {#custom .x}\n\n```\n# not\n```\n'), ['Title']);
});

test('empty input', () => {
  assert.deepEqual(parseOutline(''), []);
});
