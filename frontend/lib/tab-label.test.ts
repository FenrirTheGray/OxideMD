import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabLabels, nextUntitledTitle } from './tab-label.ts';

test('same-named files get their parent folder', () => {
  assert.deepEqual(
    tabLabels([
      { title: 'note.md', path: '/d/a/note.md' },
      { title: 'note.md', path: 'C:\\d\\b\\note.md' },
      { title: 'one.md', path: '/d/one.md' },
      { title: 'Untitled', path: null },
    ]),
    ['note.md — a', 'note.md — b', 'one.md', 'Untitled'],
  );
});

test('untitled tabs are numbered, reusing gaps', () => {
  assert.equal(nextUntitledTitle([]), 'Untitled');
  assert.equal(nextUntitledTitle(['Untitled']), 'Untitled 2');
  assert.equal(nextUntitledTitle(['Untitled', 'Untitled 3']), 'Untitled 2');
  assert.equal(nextUntitledTitle(['Untitled 2']), 'Untitled');
});
