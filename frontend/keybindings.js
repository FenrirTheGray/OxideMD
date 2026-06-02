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
import { logWarn } from './logger.js';
import {
  NAMED_KEYS,
  parseAccel, formatAccelParts, canonicalizeAccel,
} from './lib/accel.js';

// Re-export the pure accel helpers so existing importers (settings.js,
// shortcuts-display.js) keep importing them from keybindings.js unchanged.
export { parseAccel, formatAccelParts, canonicalizeAccel };

// Modifier-only keys — during capture, a keydown with one of these as the
// key should be ignored until the user presses a real key.
export const MODIFIER_ONLY_KEYS = new Set([
  'Control', 'Shift', 'Alt', 'Meta', 'OS', 'Hyper', 'Super',
]);

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
  { id: 'newFile',       category: 'File', label: 'New file',         defaultAccel: 'Mod+N' },
  { id: 'openFile',      category: 'File', label: 'Open file',        defaultAccel: 'Mod+O' },
  { id: 'openFolder',    category: 'File', label: 'Open folder',      defaultAccel: 'Mod+Shift+O' },
  { id: 'closeFolder',   category: 'File', label: 'Close folder',     defaultAccel: 'Mod+Shift+W' },
  { id: 'searchInFolder',category: 'File', label: 'Search in folder', defaultAccel: 'Mod+Shift+F' },
  { id: 'save',          category: 'File', label: 'Save file',        defaultAccel: 'Mod+S' },
  { id: 'reload',        category: 'File', label: 'Reload file',      defaultAccel: 'Mod+R' },
  { id: 'print',         category: 'File', label: 'Print to PDF',     defaultAccel: 'Mod+P' },
  { id: 'exportHtml',    category: 'File', label: 'Export as HTML…', defaultAccel: 'Mod+Shift+E' },

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
    logWarn('keybindings', `registerHandler: unknown action "${id}"`);
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
