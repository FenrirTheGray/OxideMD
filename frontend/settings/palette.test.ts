// Unit tests for the pure palette helpers. palette.js has no imports and
// the appliers it exports only touch the DOM when called, so it loads
// cleanly in the Node test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  THEME_DEFAULTS,
  effectiveThemeColor,
  BASE_PALETTE_TOKENS,
  DEFAULT_PALETTE,
  effectivePalette,
} from "./palette.ts";

test("effectiveThemeColor: swaps the other theme's default to the resolved one", () => {
  // Saved value is the dark default while resolving to light → swap to light.
  assert.equal(
    effectiveThemeColor(THEME_DEFAULTS.dark.code_bg_color, "code_bg_color", "light"),
    THEME_DEFAULTS.light.code_bg_color,
  );
  // Saved value is the light default while resolving to dark → swap to dark.
  assert.equal(
    effectiveThemeColor(THEME_DEFAULTS.light.note_bg_color, "note_bg_color", "dark"),
    THEME_DEFAULTS.dark.note_bg_color,
  );
});

test("effectiveThemeColor: matches case-insensitively", () => {
  assert.equal(
    effectiveThemeColor(
      THEME_DEFAULTS.dark.code_bg_color.toUpperCase(),
      "code_bg_color",
      "light",
    ),
    THEME_DEFAULTS.light.code_bg_color,
  );
});

test("effectiveThemeColor: passes custom picks through unchanged", () => {
  assert.equal(effectiveThemeColor("#123456", "code_bg_color", "dark"), "#123456");
  // The resolved theme's own default is not the "other" default, so it stays.
  assert.equal(
    effectiveThemeColor(THEME_DEFAULTS.dark.code_bg_color, "code_bg_color", "dark"),
    THEME_DEFAULTS.dark.code_bg_color,
  );
});

test("effectiveThemeColor: a retired default snaps to the current one", () => {
  // #8b5cf6 was the dark bullet default before the contrast fix. Configs
  // already on disk still hold it; without the retired-defaults list it
  // reads as a custom pick and the swap silently stops working for every
  // existing install — which is the whole population the fix was for.
  assert.equal(
    effectiveThemeColor("#8b5cf6", "bullet_color", "dark"),
    THEME_DEFAULTS.dark.bullet_color,
  );
  assert.equal(
    effectiveThemeColor("#8B5CF6", "bullet_color", "light"),
    THEME_DEFAULTS.light.bullet_color,
  );
  // A field with no retired entries is unaffected.
  assert.equal(effectiveThemeColor("#8b5cf6", "h1_color", "dark"), "#8b5cf6");
});

test("effectiveThemeColor: empty/nullish input returns as-is", () => {
  assert.equal(effectiveThemeColor("", "code_bg_color", "dark"), "");
  assert.equal(effectiveThemeColor(undefined, "code_bg_color", "dark"), undefined);
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

// ── Contrast ───────────────────────────────────────────────────────────────
// WCAG 2.1 relative luminance + contrast ratio. Kept local to the test:
// nothing in the app computes contrast at runtime, so shipping a helper
// for it would be dead weight.
function contrast(hexA, hexB) {
  const channel = (hex, i) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex) =>
    0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
  const [hi, lo] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

test("contrast: helper matches known WCAG reference pairs", () => {
  // Guards the guard — a broken contrast() would make every check below
  // pass vacuously. Black on white is exactly 21:1; a color against
  // itself is exactly 1:1.
  assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
  assert.equal(Math.round(contrast("#777777", "#777777")), 1);
});

test("contrast: heading defaults are readable on their own theme's background", () => {
  // The bug this guards: heading defaults used to be one theme-agnostic
  // set, so the dark hues landed on the light background at 1.39:1.
  for (const theme of ["dark", "light"]) {
    const bg = DEFAULT_PALETTE[theme].bg;
    for (const field of ["h1_color", "h2_color", "h3_color", "bullet_color"]) {
      const ratio = contrast(THEME_DEFAULTS[theme][field], bg);
      assert.ok(ratio >= 4.5, `${theme} ${field} is ${ratio.toFixed(2)}:1 on ${bg}`);
    }
  }
});

test("contrast: body, dim, and link text clear 4.5:1 in both themes", () => {
  for (const theme of ["dark", "light"]) {
    const pal = DEFAULT_PALETTE[theme];
    for (const token of ["fg", "fg-dim", "fg-muted", "fg-toolbar", "link", "link-hover"]) {
      const ratio = contrast(pal[token], pal.bg);
      assert.ok(ratio >= 4.5, `${theme} --${token} is ${ratio.toFixed(2)}:1 on ${pal.bg}`);
    }
  }
});

test("contrast: focus ring clears the 3:1 non-text threshold", () => {
  for (const theme of ["dark", "light"]) {
    const pal = DEFAULT_PALETTE[theme];
    const ratio = contrast(pal["border-focus"], pal.bg);
    assert.ok(ratio >= 3, `${theme} --border-focus is ${ratio.toFixed(2)}:1`);
  }
});

test("palette data: 27 tokens, all present in both theme defaults", () => {
  assert.equal(BASE_PALETTE_TOKENS.length, 27);
  for (const key of BASE_PALETTE_TOKENS) {
    assert.ok(key in DEFAULT_PALETTE.dark, `dark missing ${key}`);
    assert.ok(key in DEFAULT_PALETTE.light, `light missing ${key}`);
  }
});
