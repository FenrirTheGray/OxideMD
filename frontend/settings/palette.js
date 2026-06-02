// Palette data + pure helpers, split out of settings.js.
//
// Dependency-free on purpose: no imports from state.js or the DOM at module
// load, so the pure functions (effectivePalette, effectiveBgColor) are
// unit-testable in Node. The two appliers (applyPaletteToBody, setBodyTheme)
// touch document.body, but only when called from the browser — never at
// import — so this module still loads in the test runner.

// Code/note backgrounds are the only colors where the dark defaults
// produce dark-on-dark text in light mode (text uses --fg, which is
// dark in light theme). Headings and accents read fine on either
// background, so they stay theme-agnostic.
export const BG_DEFAULTS = {
  dark: { code_bg_color: "#1e2127", note_bg_color: "#2a2f3a" },
  light: { code_bg_color: "#f0f0f0", note_bg_color: "#eaeef8" },
};

// If the saved value matches the *other* theme's default, swap to the
// resolved theme's default. Custom user picks pass through unchanged.
// Edge case: a user who deliberately chose the other theme's default
// hex sees it auto-swap on theme flip — accepted to avoid carrying a
// "this is custom" flag through the data model.
export function effectiveBgColor(savedValue, field, resolved) {
  const other = resolved === "dark" ? "light" : "dark";
  const lower = (savedValue || "").toLowerCase();
  if (lower === BG_DEFAULTS[other][field].toLowerCase()) {
    return BG_DEFAULTS[resolved][field];
  }
  return savedValue;
}

// ── Base UI palette ────────────────────────────────────────────────────────
// Every hex-valued token in the `body.theme-dark` / `body.theme-light`
// blocks of style.css, in display order and grouped for the Colors tab.
// `Config.palette` holds sparse overrides keyed by these same keys (the
// CSS custom-property name minus the leading `--`); a missing key falls
// back to DEFAULT_PALETTE below.
const BASE_PALETTE_GROUPS = [
  {
    name: "Backgrounds",
    tokens: [
      ["bg", "Page background"],
      ["bg-toolbar", "Toolbar & tabs"],
      ["bg-elevated", "Panels & popovers"],
      ["bg-code", "Code block surface"],
      ["bg-table-hd", "Table header"],
      ["bg-table-row", "Table row"],
      ["bg-search", "Search bar"],
      ["bg-settings", "Settings panel"],
      ["bg-settings-hd", "Settings header"],
      ["bg-settings-ft", "Settings footer"],
    ],
  },
  {
    name: "Text",
    tokens: [
      ["fg", "Body text"],
      ["fg-dim", "Dim text"],
      ["fg-muted", "Muted text"],
      ["fg-toolbar", "Toolbar text"],
    ],
  },
  {
    name: "Borders & accents",
    tokens: [
      ["border", "Borders"],
      ["border-focus", "Focus ring"],
      ["accent", "Accent"],
      ["accent-2", "Secondary accent"],
      ["danger", "Danger"],
      ["quote-border", "Blockquote bar"],
    ],
  },
  {
    name: "Links",
    tokens: [
      ["link", "Link"],
      ["link-hover", "Link hover"],
    ],
  },
  {
    name: "Highlights & UI",
    tokens: [
      ["mark-current", "Current search match"],
      ["mark-current-fg", "Current match text"],
      ["scrollbar-thumb", "Scrollbar"],
      ["scrollbar-hover", "Scrollbar hover"],
      ["status-ok", "Status OK"],
    ],
  },
];
// Flat ordered list of the 27 palette token keys.
export const BASE_PALETTE_TOKENS = BASE_PALETTE_GROUPS.flatMap((g) =>
  g.tokens.map((t) => t[0]),
);
// Built-in defaults — these MUST stay in sync with the `body.theme-dark`
// and `body.theme-light` blocks in style.css. 6-digit hex so values
// round-trip cleanly through <input type="color">.
export const DEFAULT_PALETTE = {
  dark: {
    bg: "#282c34",
    "bg-toolbar": "#21252b",
    "bg-elevated": "#2c313c",
    "bg-code": "#1e2127",
    "bg-table-hd": "#2a2f3a",
    "bg-table-row": "#272b33",
    "bg-search": "#21252b",
    "bg-settings": "#2c313c",
    "bg-settings-hd": "#31363f",
    "bg-settings-ft": "#21252b",
    fg: "#abb2bf",
    "fg-dim": "#7a8799",
    "fg-muted": "#8994a5",
    "fg-toolbar": "#9da5b4",
    border: "#3b4048",
    "border-focus": "#61afef",
    accent: "#61afef",
    "accent-2": "#56b6c2",
    danger: "#e06c75",
    "quote-border": "#c678dd",
    link: "#56b6c2",
    "link-hover": "#80cad1",
    "mark-current": "#61afef",
    "mark-current-fg": "#282c34",
    "scrollbar-thumb": "#3b4048",
    "scrollbar-hover": "#4b5263",
    "status-ok": "#98c379",
  },
  light: {
    bg: "#fafafa",
    "bg-toolbar": "#f0f0f0",
    "bg-elevated": "#ffffff",
    "bg-code": "#f0f0f0",
    "bg-table-hd": "#e8e8e8",
    "bg-table-row": "#f5f5f5",
    "bg-search": "#f0f0f0",
    "bg-settings": "#ffffff",
    "bg-settings-hd": "#f0f0f0",
    "bg-settings-ft": "#fafafa",
    fg: "#383a42",
    "fg-dim": "#696c77",
    "fg-muted": "#6a7387",
    "fg-toolbar": "#4a4a4f",
    border: "#d8d8d8",
    "border-focus": "#4078f2",
    accent: "#4078f2",
    "accent-2": "#0184bc",
    danger: "#e45649",
    "quote-border": "#a626a4",
    link: "#0184bc",
    "link-hover": "#005f8a",
    "mark-current": "#4078f2",
    "mark-current-fg": "#ffffff",
    "scrollbar-thumb": "#cccccc",
    "scrollbar-hover": "#b8b8b8",
    "status-ok": "#50a14f",
  },
};

// Merge a config's sparse palette overrides over the resolved theme's
// built-in defaults — an empty/missing override map reproduces the
// built-in look exactly.
export function effectivePalette(resolved, palette) {
  return { ...DEFAULT_PALETTE[resolved], ...(palette || {}) };
}
// Push a full palette map onto <body> as `--<token>` custom properties.
export function applyPaletteToBody(pal) {
  for (const [key, value] of Object.entries(pal)) {
    document.body.style.setProperty(`--${key}`, value);
  }
}

// Swap the body's `theme-*` class without disturbing the other state
// classes that live on <body> (`editing`, `maximized`, `resizing-split`).
// A blanket `body.className = ...` would wipe those — which is how an
// Esc-to-close-Settings while editing used to silently drop edit mode.
export function setBodyTheme(resolved) {
  document.body.classList.remove("theme-dark", "theme-light", "theme-system");
  document.body.classList.add(`theme-${resolved}`);
}
