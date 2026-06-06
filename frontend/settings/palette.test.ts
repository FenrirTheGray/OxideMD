// Unit tests for the pure palette helpers. palette.js has no imports and
// the appliers it exports only touch the DOM when called, so it loads
// cleanly in the Node test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BG_DEFAULTS,
  effectiveBgColor,
  BASE_PALETTE_TOKENS,
  DEFAULT_PALETTE,
  effectivePalette,
} from "./palette.ts";

test("effectiveBgColor: swaps the other theme's default to the resolved one", () => {
  // Saved value is the dark default while resolving to light → swap to light.
  assert.equal(
    effectiveBgColor(BG_DEFAULTS.dark.code_bg_color, "code_bg_color", "light"),
    BG_DEFAULTS.light.code_bg_color,
  );
  // Saved value is the light default while resolving to dark → swap to dark.
  assert.equal(
    effectiveBgColor(BG_DEFAULTS.light.note_bg_color, "note_bg_color", "dark"),
    BG_DEFAULTS.dark.note_bg_color,
  );
});

test("effectiveBgColor: matches case-insensitively", () => {
  assert.equal(
    effectiveBgColor(
      BG_DEFAULTS.dark.code_bg_color.toUpperCase(),
      "code_bg_color",
      "light",
    ),
    BG_DEFAULTS.light.code_bg_color,
  );
});

test("effectiveBgColor: passes custom picks through unchanged", () => {
  assert.equal(effectiveBgColor("#123456", "code_bg_color", "dark"), "#123456");
  // The resolved theme's own default is not the "other" default, so it stays.
  assert.equal(
    effectiveBgColor(BG_DEFAULTS.dark.code_bg_color, "code_bg_color", "dark"),
    BG_DEFAULTS.dark.code_bg_color,
  );
});

test("effectiveBgColor: empty/nullish input returns as-is", () => {
  assert.equal(effectiveBgColor("", "code_bg_color", "dark"), "");
  assert.equal(effectiveBgColor(undefined, "code_bg_color", "dark"), undefined);
});

test("effectivePalette: empty/missing overrides reproduce the defaults", () => {
  assert.deepEqual(effectivePalette("dark", {}), DEFAULT_PALETTE.dark);
  assert.deepEqual(effectivePalette("dark", null), DEFAULT_PALETTE.dark);
  assert.deepEqual(effectivePalette("light", undefined), DEFAULT_PALETTE.light);
});

test("effectivePalette: sparse overrides win over defaults", () => {
  const merged = effectivePalette("dark", { accent: "#abcdef" });
  assert.equal(merged.accent, "#abcdef");
  // Untouched tokens still come from the theme defaults.
  assert.equal(merged.bg, DEFAULT_PALETTE.dark.bg);
});

test("palette data: 27 tokens, all present in both theme defaults", () => {
  assert.equal(BASE_PALETTE_TOKENS.length, 27);
  for (const key of BASE_PALETTE_TOKENS) {
    assert.ok(key in DEFAULT_PALETTE.dark, `dark missing ${key}`);
    assert.ok(key in DEFAULT_PALETTE.light, `light missing ${key}`);
  }
});
