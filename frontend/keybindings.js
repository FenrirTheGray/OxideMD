// Pure keybindings layer — action registry, accelerator parsing, matching,
// formatting, and capture. No DOM, no side effects; consumed by the
// dispatcher in app.js/editor.js and the Shortcuts tab in settings.js.
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

import { isMac } from './state.js';

// ── Named keys ─────────────────────────────────────────────────────────────
// Any KeyboardEvent.key value that isn't a single printable char gets a
// canonical token. `Plus` is in here because `+` can't survive string
// splitting on `+` — we normalize `+` → `Plus` on parse and render `Plus`
// → `+` on display.
const NAMED_KEYS = new Set([
  'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Escape', 'Space',
  'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Plus',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  'F13','F14','F15','F16','F17','F18','F19','F20','F21','F22','F23','F24',
]);

// Modifier-only keys — during capture, a keydown with one of these as the
// key should be ignored until the user presses a real key.
export const MODIFIER_ONLY_KEYS = new Set([
  'Control', 'Shift', 'Alt', 'Meta', 'OS', 'Hyper', 'Super',
]);

const MOD_ORDER = ['Alt', 'Mod', 'Shift'];

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

function normalizeKey(raw) {
  if (!raw) return '';
  if (raw === '+') return 'Plus';
  // Named keys — case-insensitive match, canonical casing.
  for (const name of NAMED_KEYS) {
    if (raw.toLowerCase() === name.toLowerCase()) return name;
  }
  if (raw.length === 1) return raw.toUpperCase();
  return raw.toUpperCase();
}

// ── Matching against KeyboardEvent ─────────────────────────────────────────

export function matchesAccel(e, accel) {
  if (!accel) return false;
  const modDown = isMac ? e.metaKey : e.ctrlKey;
  if (accel.mod !== modDown) return false;
  if (accel.alt !== e.altKey) return false;
  if (accel.shift !== e.shiftKey) return false;
  return eventKeyName(e) === accel.key;
}

// Canonical key name for a KeyboardEvent — same namespace as accel.key.
export function eventKeyName(e) {
  const k = e.key;
  if (!k) return '';
  if (k === '+') return 'Plus';
  if (NAMED_KEYS.has(k)) return k;
  if (k.length === 1) return k.toUpperCase();
  return k;
}

// Live keydown → accel string. Returns '' for modifier-only presses.
export function eventToAccel(e) {
  if (MODIFIER_ONLY_KEYS.has(e.key)) return '';
  const key = eventKeyName(e);
  if (!key) return '';
  const accel = {
    mod:   isMac ? e.metaKey : e.ctrlKey,
    alt:   e.altKey,
    shift: e.shiftKey,
    key,
  };
  return formatAccelParts(accel);
}

// ── Human-readable display ─────────────────────────────────────────────────

const MAC_SYMBOL = { Mod: '\u2318', Alt: '\u2325', Shift: '\u21E7' };
const PC_SYMBOL  = { Mod: 'Ctrl',   Alt: 'Alt',    Shift: 'Shift' };

const KEY_DISPLAY = {
  ArrowLeft:  '\u2190',
  ArrowRight: '\u2192',
  ArrowUp:    '\u2191',
  ArrowDown:  '\u2193',
  Plus:       '+',
  Space:      'Space',
};

export function accelToTokens(str) {
  const parsed = parseAccel(str);
  if (!parsed) return [];
  const symbols = isMac ? MAC_SYMBOL : PC_SYMBOL;
  const tokens = [];
  if (parsed.alt)   tokens.push(symbols.Alt);
  if (parsed.mod)   tokens.push(symbols.Mod);
  if (parsed.shift) tokens.push(symbols.Shift);
  tokens.push(KEY_DISPLAY[parsed.key] || parsed.key);
  return tokens;
}

// ── Action registry ────────────────────────────────────────────────────────
// `defaultAccel` is the user-facing, rebindable binding. `defaultAliases`
// are additional default bindings that are dispatched alongside the
// primary but are NOT shown in the Shortcuts tab. They exist to preserve
// natural typing variations (e.g. Ctrl+= and Ctrl+Shift+= for zoom in).
// Aliases are cleared when the user overrides the primary — "taking over"
// the action opts out of the convenience variants.
//
// `context`: 'editor' = only while a markdown textarea is focused; else
//             fires everywhere. Editor-context actions are tried first;
//             unmatched, the dispatcher falls through to global actions.
//
// `rebindableOnLinux: false` hides the row from the Shortcuts tab on
// Linux, where `src-tauri/src/lib.rs` intercepts certain combos at the
// GTK level before JS can see them (tab navigation). Rebinding there
// would be a lie — the default combo keeps firing via the GTK hook.
//
// TODO: plumb a Tauri command that lets Rust consult current bindings so
// Linux users can rebind tab navigation too.

export const ACTIONS = [
  { id: 'openFile',      category: 'File', label: 'Open file',        defaultAccel: 'Mod+O' },
  { id: 'openFolder',    category: 'File', label: 'Open folder',      defaultAccel: 'Mod+Shift+O' },
  { id: 'closeFolder',   category: 'File', label: 'Close folder',     defaultAccel: 'Mod+Shift+W' },
  { id: 'save',          category: 'File', label: 'Save file',        defaultAccel: 'Mod+S' },
  { id: 'reload',        category: 'File', label: 'Reload file',      defaultAccel: 'Mod+R' },

  { id: 'toggleEdit',    category: 'View', label: 'Toggle edit mode', defaultAccel: 'Mod+E' },
  { id: 'cycleSplitMode',category: 'View', label: 'Cycle split layout', defaultAccel: 'Mod+\\' },
  // Single Mod+F binding for both contexts. The handler in app.js asks
  // editor.js whether the CM6 surface has focus and routes to its
  // built-in find/replace panel; otherwise it opens the read-mode bar.
  { id: 'toggleSearch',  category: 'View', label: 'Search',           defaultAccel: 'Mod+F' },
  { id: 'zoomIn',        category: 'View', label: 'Zoom in',
    // Mod+Plus: numpad; Mod+=: US-layout unshifted; Mod+Shift+Plus: the
    // actual `Ctrl+Shift+=` muscle-memory gesture most people use.
    defaultAccel: 'Mod+Plus', defaultAliases: ['Mod+=', 'Mod+Shift+Plus'] },
  { id: 'zoomOut',       category: 'View', label: 'Zoom out',         defaultAccel: 'Mod+-' },
  { id: 'zoomReset',     category: 'View', label: 'Reset zoom',       defaultAccel: 'Mod+0' },

  { id: 'nextTab',       category: 'Tabs', label: 'Next tab',
    defaultAccel: 'Mod+Tab', rebindableOnLinux: false },
  { id: 'prevTab',       category: 'Tabs', label: 'Previous tab',
    defaultAccel: 'Mod+Shift+Tab', rebindableOnLinux: false },
  { id: 'moveTabLeft',   category: 'Tabs', label: 'Move tab left',
    defaultAccel: 'Mod+Shift+ArrowLeft', rebindableOnLinux: false },
  { id: 'moveTabRight',  category: 'Tabs', label: 'Move tab right',
    defaultAccel: 'Mod+Shift+ArrowRight', rebindableOnLinux: false },
  { id: 'closeTab',      category: 'Tabs', label: 'Close tab',        defaultAccel: 'Mod+W' },

  { id: 'bold',   category: 'Format', label: 'Bold',          defaultAccel: 'Mod+B',       context: 'editor' },
  { id: 'italic', category: 'Format', label: 'Italic',        defaultAccel: 'Mod+I',       context: 'editor' },
  { id: 'strike', category: 'Format', label: 'Strikethrough', defaultAccel: 'Mod+Shift+X', context: 'editor' },
  { id: 'code',   category: 'Format', label: 'Inline code',   defaultAccel: 'Mod+`',       context: 'editor' },
  { id: 'h1',     category: 'Format', label: 'Heading 1',     defaultAccel: 'Mod+1',       context: 'editor' },
  { id: 'h2',     category: 'Format', label: 'Heading 2',     defaultAccel: 'Mod+2',       context: 'editor' },
  { id: 'h3',     category: 'Format', label: 'Heading 3',     defaultAccel: 'Mod+3',       context: 'editor' },
  { id: 'ul',     category: 'Format', label: 'Bullet list',   defaultAccel: 'Mod+Shift+L', context: 'editor' },
  { id: 'ol',     category: 'Format', label: 'Numbered list', defaultAccel: 'Mod+Shift+N', context: 'editor' },
  { id: 'task',   category: 'Format', label: 'Task list',     defaultAccel: 'Mod+Shift+T', context: 'editor' },
  { id: 'link',   category: 'Format', label: 'Link',          defaultAccel: 'Mod+K',       context: 'editor' },
  { id: 'image',  category: 'Format', label: 'Image',         defaultAccel: 'Mod+Shift+M', context: 'editor' },
  { id: 'indent', category: 'Format', label: 'Indent',        defaultAccel: 'Tab',         context: 'editor' },
  { id: 'outdent',category: 'Format', label: 'Outdent',       defaultAccel: 'Shift+Tab',   context: 'editor' },
];

const ACTION_BY_ID = new Map(ACTIONS.map(a => [a.id, a]));

export function getAction(id) { return ACTION_BY_ID.get(id); }

// Defaults as primary-only, for the Shortcuts UI.
export function defaultBindings() {
  const map = Object.create(null);
  for (const a of ACTIONS) map[a.id] = a.defaultAccel;
  return map;
}

// Merge user overrides on top of defaults. Shape:
//   effective[id] = { primary: string, aliases: string[] }
// An empty-string primary = user explicitly unassigned. User override
// clears the default aliases — if they take control, the convenience
// variants no longer fire for that action.
export function effectiveBindings(userOverrides) {
  const out = Object.create(null);
  for (const a of ACTIONS) {
    const hasOverride = userOverrides
      && typeof userOverrides === 'object'
      && Object.prototype.hasOwnProperty.call(userOverrides, a.id)
      && typeof userOverrides[a.id] === 'string';
    if (hasOverride) {
      const raw = userOverrides[a.id];
      out[a.id] = { primary: raw === '' ? '' : canonicalizeAccel(raw), aliases: [] };
    } else {
      out[a.id] = {
        primary: a.defaultAccel,
        aliases: (a.defaultAliases || []).map(canonicalizeAccel).filter(Boolean),
      };
    }
  }
  return out;
}

// ── Handler registry + dispatcher ──────────────────────────────────────────
// Runtime registers one handler per action. Walk cost is O(n) with ~18
// entries — negligible vs. the prior if-chain, and short-circuits on
// first match.

const handlers = new Map();

export function registerHandler(id, fn) {
  if (!ACTION_BY_ID.has(id)) {
    console.warn(`registerHandler: unknown action "${id}"`);
    return;
  }
  handlers.set(id, fn);
}

// Invoke an action directly, bypassing key matching. Used by the Rust-
// forwarded listeners on Linux (see app.js `listen('next-tab', …)`), which
// must call the same handler as Ctrl+Tab so rebinds to adjacent actions
// stay in sync with the GTK-intercepted defaults.
export function runAction(id) {
  const fn = handlers.get(id);
  if (fn) fn();
}

// `bindings` is the effectiveBindings() output. `ctx` is 'global' or
// 'editor'. Editor-context actions are tried first; if none match and
// ctx==='editor', the caller should re-dispatch with ctx='global' (so
// Ctrl+S-while-editing still saves). Returns true if something fired.
export function dispatchKey(e, bindings, ctx = 'global') {
  for (const action of ACTIONS) {
    const actionCtx = action.context || 'global';
    if (actionCtx !== ctx) continue;
    const b = bindings[action.id];
    if (!b) continue;
    if (!tryMatch(e, b.primary) && !b.aliases.some(a => tryMatch(e, a))) continue;
    const fn = handlers.get(action.id);
    if (!fn) return false;  // bound but no handler — let the event through
    fn(e);
    return true;
  }
  return false;
}

function tryMatch(e, accelStr) {
  if (!accelStr) return false;
  const parsed = parseAccel(accelStr);
  return parsed ? matchesAccel(e, parsed) : false;
}

// Reverse lookup: accel → conflicting action id (primary bindings only —
// aliases aren't shown in UI so conflicts against them are invisible).
// Used by the capture UX to show "already bound to X" warnings.
export function findActionByAccel(bindings, accelStr, excludeId = null) {
  const canon = canonicalizeAccel(accelStr);
  if (!canon) return null;
  for (const id of Object.keys(bindings)) {
    if (id === excludeId) continue;
    if (bindings[id].primary === canon) return id;
  }
  return null;
}
