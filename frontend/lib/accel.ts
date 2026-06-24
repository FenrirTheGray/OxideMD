// Pure, dependency-free accelerator parsing/serialization.
//
// Split out of keybindings.js so it can be unit-tested in Node without the
// DOM, the Tauri globals, or the logger's import side effects. keybindings.js
// re-imports these; the platform-dependent matchers (matchesAccel,
// eventToAccel, accelToTokens) stay there because they read `isMac` and
// KeyboardEvent.
//
// Accelerator format (stored in config, human-editable):
//   "Mod+Shift+K", "Mod+Alt+Tab", "Home", "" (unassigned)
//
//   Mod   = Ctrl on Win/Linux, Cmd on macOS. Stored portably so one config
//           file works on both platforms; `Cmd`/`Ctrl`/`Meta` are accepted
//           aliases on parse but normalize to `Mod` on save.
//   Alt, Shift = literal modifiers.
//   Key   = single uppercase letter, digit, or a named key (Tab, Home,
//           ArrowLeft, Escape, Plus, F1…F24, …).
//
// Modifiers are alphabetized on save so two accels compare as strings.

// ── Named keys ─────────────────────────────────────────────────────────────
// Any KeyboardEvent.key value that isn't a single printable char gets a
// canonical token. `Plus` is in here because `+` can't survive string
// splitting on `+` — we normalize `+` → `Plus` on parse and render `Plus`
// → `+` on display.
export const NAMED_KEYS = new Set([
  'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Escape', 'Space',
  'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Plus',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  'F13','F14','F15','F16','F17','F18','F19','F20','F21','F22','F23','F24',
]);

export const MOD_ORDER = ['Alt', 'Mod', 'Shift'];

// ── Parse / serialize ──────────────────────────────────────────────────────

// "Mod+Shift+K" → { mod:true, alt:false, shift:true, key:'K' }
// Returns null on malformed input (empty, unknown modifiers, missing key).
export function parseAccel(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!trimmed) return null;

  // Split on '+' but treat a trailing '+' as the literal Plus key. This is
  // the escape hatch for keys that collide with our separator.
  //   "Mod++"       → mods ["Mod"],  key "+"   → Plus
  //   "Mod+Shift++" → mods ["Mod","Shift"], key "+" → Plus
  //   "+"           → key "+"        → Plus
  let tokens;
  if (trimmed === '+') {
    tokens = ['+'];
  } else if (trimmed.endsWith('++')) {
    tokens = [...trimmed.slice(0, -2).split('+'), '+'];
  } else {
    tokens = trimmed.split('+');
  }
  // Drop any empty segments except the literal + we just preserved.
  tokens = tokens.map(t => t.trim()).filter((t, i, arr) => t !== '' || i === arr.length - 1);
  if (tokens.length === 0) return null;

  const accel = { mod: false, alt: false, shift: false, key: '' };
  for (let i = 0; i < tokens.length; i++) {
    const p = tokens[i];
    const lower = p.toLowerCase();
    if (lower === 'mod' || lower === 'cmd' || lower === 'command'
        || lower === 'ctrl' || lower === 'control' || lower === 'meta' || lower === 'super') {
      accel.mod = true; continue;
    }
    if (lower === 'alt' || lower === 'option') { accel.alt = true; continue; }
    if (lower === 'shift') { accel.shift = true; continue; }
    // Anything else must be the key portion and must be last.
    if (i !== tokens.length - 1) return null;
    accel.key = normalizeKey(p);
  }
  if (!accel.key) return null;
  return accel;
}

export function formatAccelParts(accel) {
  if (!accel || !accel.key) return '';
  const mods = [];
  if (accel.alt)   mods.push('Alt');
  if (accel.mod)   mods.push('Mod');
  if (accel.shift) mods.push('Shift');
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...mods, accel.key].join('+');
}

export function canonicalizeAccel(str) {
  const parsed = parseAccel(str);
  return parsed ? formatAccelParts(parsed) : '';
}

export function normalizeKey(raw) {
  if (!raw) return '';
  if (raw === '+') return 'Plus';
  // Named keys — case-insensitive match, canonical casing.
  for (const name of NAMED_KEYS) {
    if (raw.toLowerCase() === name.toLowerCase()) return name;
  }
  return raw.toUpperCase();
}
