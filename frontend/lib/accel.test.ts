// Unit tests for the pure accelerator layer. Run with `npm test`
// (`node --test`). No DOM, no Tauri, no bundler — these import the
// dependency-free module directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAccel, formatAccelParts, canonicalizeAccel, normalizeKey,
} from "./accel.ts";

test('parseAccel: basic modifier + key', () => {
  assert.deepEqual(parseAccel('Mod+Shift+K'),
    { mod: true, alt: false, shift: true, key: 'K' });
  assert.deepEqual(parseAccel('Mod+Alt+Tab'),
    { mod: true, alt: true, shift: false, key: 'Tab' });
  assert.deepEqual(parseAccel('Home'),
    { mod: false, alt: false, shift: false, key: 'Home' });
});

test('parseAccel: modifier aliases normalize to Mod', () => {
  for (const alias of ['Ctrl', 'Control', 'Cmd', 'Command', 'Meta', 'Super']) {
    assert.equal(parseAccel(`${alias}+S`).mod, true, alias);
  }
  assert.equal(parseAccel('Option+S').alt, true);
});

test('parseAccel: case-insensitive modifiers and named keys', () => {
  assert.deepEqual(parseAccel('mod+shift+arrowleft'),
    { mod: true, alt: false, shift: true, key: 'ArrowLeft' });
});

test('parseAccel: single letters uppercase', () => {
  assert.equal(parseAccel('Mod+b').key, 'B');
  assert.equal(parseAccel('a').key, 'A');
});

test('parseAccel: the Plus escape hatch', () => {
  assert.deepEqual(parseAccel('+'),
    { mod: false, alt: false, shift: false, key: 'Plus' });
  assert.deepEqual(parseAccel('Mod++'),
    { mod: true, alt: false, shift: false, key: 'Plus' });
  assert.deepEqual(parseAccel('Mod+Shift++'),
    { mod: true, alt: false, shift: true, key: 'Plus' });
  // The named form is equivalent to the literal.
  assert.deepEqual(parseAccel('Mod+Plus'), parseAccel('Mod++'));
});

test('parseAccel: malformed input returns null', () => {
  assert.equal(parseAccel(''), null);
  assert.equal(parseAccel('   '), null);
  assert.equal(parseAccel(null), null);
  assert.equal(parseAccel(undefined), null);
  assert.equal(parseAccel(42), null);
  // Modifiers only, no key.
  assert.equal(parseAccel('Mod+Shift'), null);
  // A modifier token after the key portion is invalid.
  assert.equal(parseAccel('K+Mod'), null);
});

test('formatAccelParts: alphabetizes modifiers (Alt, Mod, Shift)', () => {
  assert.equal(
    formatAccelParts({ mod: true, alt: true, shift: true, key: 'K' }),
    'Alt+Mod+Shift+K');
  // Order of the input flags doesn't matter — output is canonical.
  assert.equal(
    formatAccelParts({ shift: true, mod: true, alt: false, key: 'Tab' }),
    'Mod+Shift+Tab');
});

test('formatAccelParts: empty without a key', () => {
  assert.equal(formatAccelParts({ mod: true, alt: false, shift: false, key: '' }), '');
  assert.equal(formatAccelParts(null), '');
});

test('canonicalizeAccel: round-trips and normalizes', () => {
  assert.equal(canonicalizeAccel('shift+mod+k'), 'Mod+Shift+K');
  assert.equal(canonicalizeAccel('Ctrl+='), 'Mod+=');
  assert.equal(canonicalizeAccel('Cmd+Shift+ArrowRight'), 'Mod+Shift+ArrowRight');
  // Idempotent.
  assert.equal(canonicalizeAccel('Alt+Mod+Shift+K'), 'Alt+Mod+Shift+K');
  // Invalid → empty string (the "unassigned" sentinel).
  assert.equal(canonicalizeAccel('Mod+Shift'), '');
  assert.equal(canonicalizeAccel(''), '');
});

test('normalizeKey: named keys, letters, and Plus', () => {
  assert.equal(normalizeKey('tab'), 'Tab');
  assert.equal(normalizeKey('ARROWUP'), 'ArrowUp');
  assert.equal(normalizeKey('+'), 'Plus');
  assert.equal(normalizeKey('b'), 'B');
  assert.equal(normalizeKey(''), '');
});
