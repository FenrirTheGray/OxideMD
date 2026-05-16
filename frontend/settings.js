import {
  invoke,
  state,
  systemDarkMQ,
  isLinux,
  tabs,
  statusText,
  statusIndicator,
  settingsOverlay,
  searchBar,
  hasActiveOverlay,
  MD_EXTS_DEFAULT,
} from "./state.js";
import {
  activeTab,
  applyZoom,
  setLoading,
  clearStatus,
  renderContent,
  applyRecentFiles,
} from "./tabs.js";
import { setPreviewHtml, promptResetSettings } from "./editor.js";
import { closeSearch } from "./search.js";
import {
  ACTIONS,
  effectiveBindings,
  findActionByAccel,
  eventToAccel,
  accelToTokens,
  canonicalizeAccel,
  MODIFIER_ONLY_KEYS,
} from "./keybindings.js";
import { renderShortcutsUI } from "./shortcuts-display.js";
import { updateAutoCompact } from "./window-size.js";

// ── Settings tab structure & placement convention ──────────────────────────
// The Settings modal has six tabs. When adding a new setting row, decide
// where it belongs by what the setting actually changes:
//
//   General   — app-wide behavior that isn't typography or color: the
//               toolbar button style, how the folder browser decides which
//               files are Markdown, and whether exported PDFs are
//               printer-friendly.
//   Reading   — the rendered/printed output and reading layout: typography
//               (font, size, line height), reading width, and preserve
//               line breaks. It no longer owns the toolbar, the
//               Markdown-extensions field, or the printer-friendly toggle —
//               those moved to General.
//   Editor    — the CodeMirror edit surface itself: word wrap, spell check,
//               line numbers, and any future option that changes how text
//               looks or behaves *while editing*.
//   Colors    — color tokens and theme: the theme select and every
//               --color swatch.
//   Shortcuts — keybinding overrides only.
//   About     — version, links, update check. No configurable settings.
//
// Rule of thumb: if it changes the CodeMirror edit surface → Editor; if it
// changes rendered/printed output or reading layout → Reading; if it's a
// color token or the theme → Colors; if it's app-wide behavior or file
// handling → General. When a setting could plausibly fit two tabs, place it
// by the surface the user is looking at when the change matters to them.
// ───────────────────────────────────────────────────────────────────────────

// ── Config / theme ─────────────────────────────────────────────────────────
function resolvedTheme(theme) {
  if (theme !== "system") return theme;
  return systemDarkMQ.matches ? "dark" : "light";
}

// Code/note backgrounds are the only colors where the dark defaults
// produce dark-on-dark text in light mode (text uses --fg, which is
// dark in light theme). Headings and accents read fine on either
// background, so they stay theme-agnostic.
const BG_DEFAULTS = {
  dark: { code_bg_color: "#1e2127", note_bg_color: "#2a2f3a" },
  light: { code_bg_color: "#f0f0f0", note_bg_color: "#eaeef8" },
};

// If the saved value matches the *other* theme's default, swap to the
// resolved theme's default. Custom user picks pass through unchanged.
// Edge case: a user who deliberately chose the other theme's default
// hex sees it auto-swap on theme flip — accepted to avoid carrying a
// "this is custom" flag through the data model.
function effectiveBgColor(savedValue, field, resolved) {
  const other = resolved === "dark" ? "light" : "dark";
  const lower = (savedValue || "").toLowerCase();
  if (lower === BG_DEFAULTS[other][field].toLowerCase()) {
    return BG_DEFAULTS[resolved][field];
  }
  return savedValue;
}

export async function loadCustomFont(filename) {
  if (state.activeFontFilename === filename) return;
  try {
    const b64 = await invoke("get_font_data", { filename });
    const ext = filename.split(".").pop().toLowerCase();
    const format =
      { ttf: "truetype", otf: "opentype", woff: "woff", woff2: "woff2" }[ext] ||
      "truetype";
    if (!state.fontStyleEl) {
      state.fontStyleEl = document.createElement("style");
      document.head.appendChild(state.fontStyleEl);
    }
    state.fontStyleEl.textContent = `@font-face { font-family: "OxideMD-Custom"; src: url("data:font/${ext};base64,${b64}") format("${format}"); }`;
    state.activeFontFilename = filename;
  } catch (err) {
    state.activeFontFilename = null;
    statusText.textContent = `Font error: ${err}`;
    statusIndicator.classList.remove("hidden", "status-loading");
    setTimeout(clearStatus, 4000);
  }
}

// Swap the body's `theme-*` class without disturbing the other state
// classes that live on <body> (`editing`, `maximized`, `resizing-split`).
// A blanket `body.className = ...` would wipe those — which is how an
// Esc-to-close-Settings while editing used to silently drop edit mode.
function setBodyTheme(resolved) {
  document.body.classList.remove("theme-dark", "theme-light", "theme-system");
  document.body.classList.add(`theme-${resolved}`);
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
const BASE_PALETTE_TOKENS = BASE_PALETTE_GROUPS.flatMap((g) =>
  g.tokens.map((t) => t[0]),
);
// Built-in defaults — these MUST stay in sync with the `body.theme-dark`
// and `body.theme-light` blocks in style.css. 6-digit hex so values
// round-trip cleanly through <input type="color">.
const DEFAULT_PALETTE = {
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
function effectivePalette(resolved, palette) {
  return { ...DEFAULT_PALETTE[resolved], ...(palette || {}) };
}
// Push a full palette map onto <body> as `--<token>` custom properties.
function applyPaletteToBody(pal) {
  for (const [key, value] of Object.entries(pal)) {
    document.body.style.setProperty(`--${key}`, value);
  }
}

export function applyConfig(cfg) {
  const resolved = resolvedTheme(cfg.theme);
  setBodyTheme(resolved);
  if (cfg.font_family.startsWith("custom:")) {
    const filename = cfg.font_family.slice(7);
    if (state.activeFontFilename !== filename) loadCustomFont(filename);
    document.body.style.setProperty(
      "--font-family",
      '"OxideMD-Custom", sans-serif',
    );
  } else {
    document.body.style.setProperty(
      "--font-family",
      `"${cfg.font_family}", sans-serif`,
    );
  }
  document.body.style.setProperty("--font-size", `${cfg.font_size}px`);
  document.body.style.setProperty("--content-line-height", cfg.line_height);
  document.body.style.setProperty("--reading-width", `${cfg.reading_width}px`);
  document.body.style.setProperty("--h1-color", cfg.h1_color);
  document.body.style.setProperty("--h2-color", cfg.h2_color);
  document.body.style.setProperty("--h3-color", cfg.h3_color);
  document.body.style.setProperty("--bullet-color", cfg.bullet_color);
  document.body.style.setProperty(
    "--code-bg",
    effectiveBgColor(cfg.code_bg_color, "code_bg_color", resolved),
  );
  document.body.style.setProperty("--code-accent", cfg.code_accent_color);
  document.body.style.setProperty(
    "--note-bg",
    effectiveBgColor(cfg.note_bg_color, "note_bg_color", resolved),
  );
  document.body.style.setProperty("--note-accent", cfg.note_accent_color);
  document.body.style.setProperty("--sidebar-width", `${cfg.sidebar_width}px`);
  // Base UI palette — sparse overrides merged over the theme defaults.
  applyPaletteToBody(effectivePalette(resolved, cfg.palette));
  document
    .getElementById("toolbar-buttons")
    .classList.toggle("compact", !!cfg.toolbar_compact);
  // Re-evaluate the responsive compact flag — toggling the user
  // preference off while the window is narrow should still leave
  // labels hidden, and toggling it on while the auto flag is set
  // shouldn't strand a stale class either way.
  updateAutoCompact();
}

// Live update when the OS switches dark/light while theme is set to 'system'
systemDarkMQ.addEventListener("change", () => {
  if (state.config?.theme === "system") applyConfig(state.config);
});

// ── Custom selects ─────────────────────────────────────────────────────────
// The font and custom-theme selects are managed separately (dynamic
// options), so skip them here.
document.querySelectorAll(".custom-select").forEach((sel) => {
  if (sel.id === "setting-font" || sel.id === "setting-custom-theme") return;
  const trigger = sel.querySelector(".custom-select-trigger");
  const options = sel.querySelectorAll(".custom-select-option");
  let focusedIndex = -1;

  // Expose .value getter/setter so existing code works unchanged
  Object.defineProperty(sel, "value", {
    get() {
      return sel.dataset.value || "";
    },
    set(v) {
      const old = sel.dataset.value;
      sel.dataset.value = v;
      const match = sel.querySelector(
        `.custom-select-option[data-value="${CSS.escape(v)}"]`,
      );
      trigger.textContent = match ? match.textContent : v;
      options.forEach((o) =>
        o.classList.toggle("selected", o.dataset.value === v),
      );
      if (old !== v) sel.dispatchEvent(new Event("change"));
    },
  });

  function openSelect() {
    document.querySelectorAll(".custom-select.open").forEach((s) => {
      if (s !== sel) closeSelect(s);
    });
    sel.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    // Focus the currently selected option
    focusedIndex = Array.from(options).findIndex((o) =>
      o.classList.contains("selected"),
    );
    if (focusedIndex === -1) focusedIndex = 0;
    updateOptionFocus();
  }

  function closeSelect(s) {
    s = s || sel;
    s.classList.remove("open");
    s.querySelector(".custom-select-trigger").setAttribute(
      "aria-expanded",
      "false",
    );
    s.querySelectorAll(".custom-select-option").forEach((o) =>
      o.classList.remove("focused"),
    );
  }

  function updateOptionFocus() {
    options.forEach((o, i) =>
      o.classList.toggle("focused", i === focusedIndex),
    );
    if (focusedIndex >= 0)
      options[focusedIndex].scrollIntoView({ block: "nearest" });
  }

  function selectFocused() {
    if (focusedIndex >= 0 && options[focusedIndex]) {
      sel.value = options[focusedIndex].dataset.value;
    }
    closeSelect();
    trigger.focus();
  }

  trigger.addEventListener("click", () => {
    if (sel.classList.contains("open")) closeSelect();
    else openSelect();
  });

  // Keyboard support
  trigger.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        if (sel.classList.contains("open")) selectFocused();
        else openSelect();
        break;
      case "ArrowDown":
        e.preventDefault();
        if (!sel.classList.contains("open")) {
          openSelect();
          break;
        }
        focusedIndex = Math.min(focusedIndex + 1, options.length - 1);
        updateOptionFocus();
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!sel.classList.contains("open")) {
          openSelect();
          break;
        }
        focusedIndex = Math.max(focusedIndex - 1, 0);
        updateOptionFocus();
        break;
      case "Escape":
        if (sel.classList.contains("open")) {
          e.preventDefault();
          e.stopPropagation();
          closeSelect();
          trigger.focus();
        }
        break;
      case "Tab":
        if (sel.classList.contains("open")) closeSelect();
        break;
    }
  });

  options.forEach((opt) => {
    opt.addEventListener("click", () => {
      sel.value = opt.dataset.value;
      closeSelect();
      trigger.focus();
    });
  });
});

// ── Font dropdown (dynamic) ───────────────────────────────────────────────
const fontSelect = document.getElementById("setting-font");
const fontTrigger = fontSelect.querySelector(".custom-select-trigger");
const fontOptionsContainer = fontSelect.querySelector(".custom-select-options");

// ── Font select open/close/keyboard ───────────────────────────────────────
function openFontSelect() {
  document.querySelectorAll(".custom-select.open").forEach((s) => {
    s.classList.remove("open");
    s.querySelector(".custom-select-trigger").setAttribute(
      "aria-expanded",
      "false",
    );
  });
  fontSelect.classList.add("open");
  fontTrigger.setAttribute("aria-expanded", "true");
}

function closeFontSelect() {
  fontSelect.classList.remove("open");
  fontTrigger.setAttribute("aria-expanded", "false");
  fontOptionsContainer
    .querySelectorAll(".custom-select-option")
    .forEach((o) => o.classList.remove("focused"));
}

fontTrigger.addEventListener("click", () => {
  if (fontSelect.classList.contains("open")) closeFontSelect();
  else openFontSelect();
});

fontTrigger.addEventListener("keydown", (e) => {
  const opts = Array.from(
    fontOptionsContainer.querySelectorAll(".custom-select-option"),
  );
  let focusedIdx = opts.findIndex((o) => o.classList.contains("focused"));

  switch (e.key) {
    case "Enter":
    case " ":
      e.preventDefault();
      if (fontSelect.classList.contains("open") && focusedIdx >= 0) {
        opts[focusedIdx].click();
      } else {
        openFontSelect();
      }
      break;
    case "ArrowDown":
      e.preventDefault();
      if (!fontSelect.classList.contains("open")) {
        openFontSelect();
        break;
      }
      focusedIdx = Math.min(focusedIdx + 1, opts.length - 1);
      opts.forEach((o, i) => o.classList.toggle("focused", i === focusedIdx));
      if (opts[focusedIdx])
        opts[focusedIdx].scrollIntoView({ block: "nearest" });
      break;
    case "ArrowUp":
      e.preventDefault();
      if (!fontSelect.classList.contains("open")) {
        openFontSelect();
        break;
      }
      focusedIdx = Math.max(focusedIdx - 1, 0);
      opts.forEach((o, i) => o.classList.toggle("focused", i === focusedIdx));
      if (opts[focusedIdx])
        opts[focusedIdx].scrollIntoView({ block: "nearest" });
      break;
    case "Escape":
      if (fontSelect.classList.contains("open")) {
        e.preventDefault();
        e.stopPropagation();
        closeFontSelect();
        fontTrigger.focus();
      }
      break;
    case "Tab":
      if (fontSelect.classList.contains("open")) closeFontSelect();
      break;
  }
});

// Override the value getter/setter for the font select to work with dynamic options
Object.defineProperty(fontSelect, "value", {
  get() {
    return fontSelect.dataset.value || "";
  },
  set(v) {
    fontSelect.dataset.value = v;
    const opts = fontSelect.querySelectorAll(".custom-select-option");
    const match = fontSelect.querySelector(
      `.custom-select-option[data-value="${CSS.escape(v)}"]`,
    );
    if (match) {
      // Use the label span text for custom fonts, or full text for built-in
      const label = match.querySelector(".custom-font-label");
      fontTrigger.textContent = label ? label.textContent : match.textContent;
    } else {
      fontTrigger.textContent = v;
    }
    opts.forEach((o) => o.classList.toggle("selected", o.dataset.value === v));
  },
});

const BUILTIN_FONTS = [
  { value: "system-ui", label: "System Default" },
  { value: "Georgia", label: "Georgia" },
  { value: "Consolas, monospace", label: "Consolas" },
  { value: "Arial", label: "Arial" },
  { value: "Verdana", label: "Verdana" },
  { value: "Times New Roman, serif", label: "Times New Roman" },
];

function rebuildFontDropdown() {
  fontOptionsContainer.innerHTML = "";

  // Built-in fonts
  const includedHdr = document.createElement("div");
  includedHdr.className = "dropdown-section-header";
  includedHdr.setAttribute("role", "presentation");
  includedHdr.textContent = "Included";
  fontOptionsContainer.appendChild(includedHdr);
  for (const f of BUILTIN_FONTS) {
    const opt = document.createElement("div");
    opt.className = "custom-select-option";
    opt.dataset.value = f.value;
    opt.setAttribute("role", "option");
    opt.textContent = f.label;
    fontOptionsContainer.appendChild(opt);
  }

  // Custom fonts
  const importedHdr = document.createElement("div");
  importedHdr.className = "dropdown-section-header";
  importedHdr.setAttribute("role", "presentation");
  importedHdr.textContent = "Imported";
  fontOptionsContainer.appendChild(importedHdr);

  if (state.customFonts.length === 0) {
    const hint = document.createElement("div");
    hint.className = "font-empty-hint";
    hint.textContent = "No custom fonts installed";
    fontOptionsContainer.appendChild(hint);
  } else {
    for (const f of state.customFonts) {
      const opt = document.createElement("div");
      opt.className = "custom-select-option custom-font-option";
      opt.dataset.value = `custom:${f.filename}`;
      opt.setAttribute("role", "option");

      const label = document.createElement("span");
      label.className = "custom-font-label";
      label.textContent = f.name;
      opt.appendChild(label);

      const removeBtn = document.createElement("button");
      removeBtn.className = "custom-font-remove";
      removeBtn.setAttribute("aria-label", `Remove ${f.name}`);
      removeBtn.title = `Remove ${f.name}`;
      removeBtn.innerHTML = "&#x2715;";
      opt.appendChild(removeBtn);

      fontOptionsContainer.appendChild(opt);
    }
  }

  // Re-highlight current selection
  const current = fontSelect.dataset.value || "";
  fontOptionsContainer
    .querySelectorAll(".custom-select-option")
    .forEach((o) => {
      o.classList.toggle("selected", o.dataset.value === current);
    });
}

// Event delegation for font dropdown clicks
fontOptionsContainer.addEventListener("click", async (e) => {
  const removeBtn = e.target.closest(".custom-font-remove");
  if (removeBtn) {
    e.stopPropagation();
    const opt = removeBtn.closest(".custom-select-option");
    const label = opt.querySelector(".custom-font-label");
    const fontName = label ? label.textContent : "this font";
    if (!confirm(`Remove "${fontName}"? The font file will be deleted.`))
      return;
    const filename = opt.dataset.value.slice(7); // strip "custom:"
    await invoke("remove_font", { filename });
    state.customFonts = await invoke("list_custom_fonts");
    // If the removed font was selected, fall back to system-ui
    if (fontSelect.dataset.value === opt.dataset.value) {
      fontSelect.value = "system-ui";
    }
    if (state.activeFontFilename === filename) state.activeFontFilename = null;
    rebuildFontDropdown();
    return;
  }

  const opt = e.target.closest(".custom-select-option");
  if (!opt) return;

  // Normal font selection
  fontSelect.value = opt.dataset.value;
  fontSelect.classList.remove("open");
  fontTrigger.setAttribute("aria-expanded", "false");
});

// ── Custom theme dropdown (dynamic) ───────────────────────────────────────
// Mirrors the Font dropdown: the options list is rebuilt from
// state.customThemes, with a remove (×) button per saved theme and an
// "Import theme…" action row. Unlike the other selects this one has no
// persisted "selected" value — config stores the raw color fields, not a
// theme reference — so the trigger always shows a static placeholder and
// the select exposes no .value property.
const CUSTOM_THEME_PLACEHOLDER = "Select a theme…";
const CUSTOM_THEME_DEFAULT_VALUE = "__default__";
const CUSTOM_THEME_DEFAULT_LIGHT_VALUE = "__default_light__";
const customThemeSelect = document.getElementById("setting-custom-theme");
const customThemeTrigger = customThemeSelect.querySelector(
  ".custom-select-trigger",
);
const customThemeOptionsContainer = customThemeSelect.querySelector(
  ".custom-select-options",
);
customThemeTrigger.textContent = CUSTOM_THEME_PLACEHOLDER;

// Tracks which saved theme (or Default) the dropdown should label. Empty
// = no selection (custom edits, or never picked). Value persists to
// config.custom_theme on Save so the label survives a restart.
function setCustomThemeSelection(value, label) {
  customThemeSelect.dataset.value = value || "";
  customThemeTrigger.textContent = value
    ? label || value
    : CUSTOM_THEME_PLACEHOLDER;
}
function clearCustomThemeSelection() {
  setCustomThemeSelection("", "");
}
// Resolves state.config.custom_theme into a trigger label. Called twice
// from openSettings — once from the cached themes list and once after
// list_custom_themes resolves — so the label upgrades from the raw
// filename to the saved display name as soon as the list is in.
function applyStoredCustomThemeSelection() {
  const ct = state.config?.custom_theme || "";
  if (!ct) {
    clearCustomThemeSelection();
    return;
  }
  if (ct === CUSTOM_THEME_DEFAULT_VALUE) {
    setCustomThemeSelection(CUSTOM_THEME_DEFAULT_VALUE, "Atom One Dark");
    return;
  }
  if (ct === CUSTOM_THEME_DEFAULT_LIGHT_VALUE) {
    setCustomThemeSelection(CUSTOM_THEME_DEFAULT_LIGHT_VALUE, "Atom One Light");
    return;
  }
  const match = findThemeByFilename(ct);
  // Missing reference (theme uninstalled, bundle slug renamed in an
  // update, etc.) — fall back to the placeholder rather than leaking
  // the raw sentinel/filename into the trigger.
  if (match) setCustomThemeSelection(ct, match.name);
  else clearCustomThemeSelection();
}

// ── Custom theme select open/close/keyboard ───────────────────────────────
function openCustomThemeSelect() {
  document.querySelectorAll(".custom-select.open").forEach((s) => {
    s.classList.remove("open");
    s.querySelector(".custom-select-trigger").setAttribute(
      "aria-expanded",
      "false",
    );
  });
  customThemeSelect.classList.add("open");
  customThemeTrigger.setAttribute("aria-expanded", "true");
}

function closeCustomThemeSelect() {
  customThemeSelect.classList.remove("open");
  customThemeTrigger.setAttribute("aria-expanded", "false");
  customThemeOptionsContainer
    .querySelectorAll(".custom-select-option")
    .forEach((o) => o.classList.remove("focused"));
}

customThemeTrigger.addEventListener("click", () => {
  if (customThemeSelect.classList.contains("open")) closeCustomThemeSelect();
  else openCustomThemeSelect();
});

customThemeTrigger.addEventListener("keydown", (e) => {
  const opts = Array.from(
    customThemeOptionsContainer.querySelectorAll(".custom-select-option"),
  );
  let focusedIdx = opts.findIndex((o) => o.classList.contains("focused"));

  switch (e.key) {
    case "Enter":
    case " ":
      e.preventDefault();
      if (customThemeSelect.classList.contains("open") && focusedIdx >= 0) {
        opts[focusedIdx].click();
      } else {
        openCustomThemeSelect();
      }
      break;
    case "ArrowDown":
      e.preventDefault();
      if (!customThemeSelect.classList.contains("open")) {
        openCustomThemeSelect();
        break;
      }
      focusedIdx = Math.min(focusedIdx + 1, opts.length - 1);
      opts.forEach((o, i) => o.classList.toggle("focused", i === focusedIdx));
      if (opts[focusedIdx])
        opts[focusedIdx].scrollIntoView({ block: "nearest" });
      break;
    case "ArrowUp":
      e.preventDefault();
      if (!customThemeSelect.classList.contains("open")) {
        openCustomThemeSelect();
        break;
      }
      focusedIdx = Math.max(focusedIdx - 1, 0);
      opts.forEach((o, i) => o.classList.toggle("focused", i === focusedIdx));
      if (opts[focusedIdx])
        opts[focusedIdx].scrollIntoView({ block: "nearest" });
      break;
    case "Escape":
      if (customThemeSelect.classList.contains("open")) {
        e.preventDefault();
        e.stopPropagation();
        closeCustomThemeSelect();
        customThemeTrigger.focus();
      }
      break;
    case "Tab":
      if (customThemeSelect.classList.contains("open"))
        closeCustomThemeSelect();
      break;
  }
});

// Finds a theme by its dropdown filename ID — bundled (`builtin:<slug>`)
// or user-imported (`<name>.json`). Returns undefined for the Default
// sentinel or anything else not in either list.
function findThemeByFilename(filename) {
  if (!filename) return undefined;
  return (
    state.builtinThemes.find((t) => t.filename === filename) ||
    state.customThemes.find((t) => t.filename === filename)
  );
}

// Stable selection IDs for the two bundled defaults. Kept as constants
// (referenced in dropdown rows, click handler, config persistence, and
// export) so the strings can't drift between the producer and consumer.
const ATOM_ONE_DARK = {
  name: "Atom One Dark",
  filename: CUSTOM_THEME_DEFAULT_VALUE,
};
const ATOM_ONE_LIGHT = {
  name: "Atom One Light",
  filename: CUSTOM_THEME_DEFAULT_LIGHT_VALUE,
};

// Renders one theme row into the dropdown. Bundled themes have no
// remove button; user imports do.
function appendThemeOption(theme) {
  const opt = document.createElement("div");
  opt.className = "custom-select-option custom-font-option";
  opt.dataset.value = theme.filename;
  opt.setAttribute("role", "option");

  const label = document.createElement("span");
  label.className = "custom-font-label";
  label.textContent = theme.name;
  opt.appendChild(label);

  if (!theme.builtin) {
    const removeBtn = document.createElement("button");
    removeBtn.className = "custom-font-remove";
    removeBtn.setAttribute("aria-label", `Remove ${theme.name}`);
    removeBtn.title = `Remove ${theme.name}`;
    removeBtn.innerHTML = "&#x2715;";
    opt.appendChild(removeBtn);
  }

  customThemeOptionsContainer.appendChild(opt);
}

// Rebuilds the options list, split into two sections: bundled themes
// under "Included" (Atom One Dark / Atom One Light via the
// CUSTOM_THEME_DEFAULT_VALUE / CUSTOM_THEME_DEFAULT_LIGHT_VALUE sentinels +
// the JSONs shipped in `src-tauri/themes/`) and user imports under
// "Imported". Each section sorts alphabetically (case-insensitive).
// Followed by the Import action.
function rebuildCustomThemeDropdown() {
  customThemeOptionsContainer.innerHTML = "";

  const byName = (a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  const included = [
    { ...ATOM_ONE_DARK, builtin: true },
    { ...ATOM_ONE_LIGHT, builtin: true },
    ...state.builtinThemes.map((t) => ({ ...t, builtin: true })),
  ].sort(byName);
  const imported = state.customThemes
    .map((t) => ({ ...t, builtin: false }))
    .sort(byName);

  const includedHdr = document.createElement("div");
  includedHdr.className = "dropdown-section-header";
  includedHdr.setAttribute("role", "presentation");
  includedHdr.textContent = "Included";
  customThemeOptionsContainer.appendChild(includedHdr);
  for (const t of included) appendThemeOption(t);

  const importedHdr = document.createElement("div");
  importedHdr.className = "dropdown-section-header";
  importedHdr.setAttribute("role", "presentation");
  importedHdr.textContent = "Imported";
  customThemeOptionsContainer.appendChild(importedHdr);
  if (imported.length === 0) {
    const hint = document.createElement("div");
    hint.className = "font-empty-hint";
    hint.textContent = "No imported themes";
    customThemeOptionsContainer.appendChild(hint);
  } else {
    for (const t of imported) appendThemeOption(t);
  }
}

// Event delegation for custom theme dropdown clicks
customThemeOptionsContainer.addEventListener("click", async (e) => {
  const removeBtn = e.target.closest(".custom-font-remove");
  if (removeBtn) {
    e.stopPropagation();
    const opt = removeBtn.closest(".custom-select-option");
    const label = opt.querySelector(".custom-font-label");
    const themeName = label ? label.textContent : "this theme";
    if (
      !confirm(`Remove "${themeName}"? The saved theme file will be deleted.`)
    )
      return;
    const filename = opt.dataset.value;
    await invoke("delete_custom_theme", { filename });
    state.customThemes = await invoke("list_custom_themes");
    if (customThemeSelect.dataset.value === filename)
      clearCustomThemeSelection();
    rebuildCustomThemeDropdown();
    return;
  }

  const opt = e.target.closest(".custom-select-option");
  if (!opt) return;

  // Atom One Dark / Atom One Light — the bundled-by-name handles for
  // the original built-in dark and light palettes + content defaults.
  // Each pins its own mode so the label always matches what the user
  // sees, no matter what was applied before.
  if (
    opt.dataset.value === CUSTOM_THEME_DEFAULT_VALUE ||
    opt.dataset.value === CUSTOM_THEME_DEFAULT_LIGHT_VALUE
  ) {
    const mode =
      opt.dataset.value === CUSTOM_THEME_DEFAULT_VALUE ? "dark" : "light";
    const defaults = await invoke("get_default_config");
    const colors = {
      theme: mode,
      ...DEFAULT_PALETTE[mode],
      h1_color: defaults.h1_color,
      h2_color: defaults.h2_color,
      h3_color: defaults.h3_color,
      bullet_color: defaults.bullet_color,
      code_bg_color: BG_DEFAULTS[mode].code_bg_color,
      code_accent_color: defaults.code_accent_color,
      note_bg_color: BG_DEFAULTS[mode].note_bg_color,
      note_accent_color: defaults.note_accent_color,
    };
    applyThemeToControls(colors);
    const pretty =
      opt.dataset.value === CUSTOM_THEME_DEFAULT_VALUE
        ? ATOM_ONE_DARK.name
        : ATOM_ONE_LIGHT.name;
    setCustomThemeSelection(opt.dataset.value, pretty);
    closeCustomThemeSelect();
    return;
  }

  // Normal theme selection: apply the picked theme's colors to the
  // Colors-tab controls + preview. Looks across bundled + imported lists
  // (both trusted: built-in JSON ships with the app, list_custom_themes
  // is the only writer of the user themes dir).
  const theme = findThemeByFilename(opt.dataset.value);
  if (theme) {
    applyThemeToControls(theme.colors);
    setCustomThemeSelection(theme.filename, theme.name);
  }
  closeCustomThemeSelect();
});

// Close custom selects when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".custom-select")) {
    document.querySelectorAll(".custom-select.open").forEach((s) => {
      s.classList.remove("open");
      s.querySelector(".custom-select-trigger").setAttribute(
        "aria-expanded",
        "false",
      );
    });
  }
});

// ── Segmented controls ─────────────────────────────────────────────────────
// Two-button pill with data-value on each segment; exposes a .value
// getter/setter like the custom-select above so settings save/load code
// can treat it as a regular form control.
document.querySelectorAll(".segmented").forEach((seg) => {
  const btns = Array.from(seg.querySelectorAll("button[data-value]"));

  Object.defineProperty(seg, "value", {
    get() {
      return seg.dataset.value ?? "";
    },
    set(v) {
      const str = String(v);
      seg.dataset.value = str;
      btns.forEach((b) => {
        const on = b.dataset.value === str;
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    },
  });

  btns.forEach((btn) => {
    btn.addEventListener("click", () => {
      seg.value = btn.dataset.value;
    });
  });
});

// ── Custom number inputs ───────────────────────────────────────────────────
document.querySelectorAll(".custom-number").forEach((num) => {
  const display = num.querySelector(".custom-number-value");
  const min = parseFloat(num.dataset.min ?? "8");
  const max = parseFloat(num.dataset.max ?? "48");
  const step = parseFloat(num.dataset.step ?? "1");
  const decimals = parseInt(num.dataset.decimals ?? "0", 10);
  const suffix = num.dataset.suffix ?? "";

  const quantize = (v) => {
    const steps = Math.round((v - min) / step);
    return parseFloat((min + steps * step).toFixed(decimals + 6));
  };
  const format = (v) => v.toFixed(decimals) + suffix;

  Object.defineProperty(num, "value", {
    get() {
      return parseFloat(num.dataset.value) || min;
    },
    set(v) {
      const parsed = parseFloat(v);
      const clamped = Math.min(
        max,
        Math.max(min, Number.isFinite(parsed) ? parsed : min),
      );
      const snapped = quantize(clamped);
      num.dataset.value = snapped;
      display.textContent = format(snapped);
    },
  });

  num.querySelector(".decrement").addEventListener("click", () => {
    num.value = num.value - step;
  });
  num.querySelector(".increment").addEventListener("click", () => {
    num.value = num.value + step;
  });
});

// ── Focus trap ─────────────────────────────────────────────────────────────
function trapFocus(container) {
  const focusableSelector =
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

  function handler(e) {
    if (e.key !== "Tab") return;
    const focusable = Array.from(
      container.querySelectorAll(focusableSelector),
    ).filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  container.addEventListener("keydown", handler);
  // Focus first focusable element
  const first = container.querySelector(focusableSelector);
  if (first) first.focus();

  return () => container.removeEventListener("keydown", handler);
}

// ── Shortcuts panel ────────────────────────────────────────────────────────
// Working copy of user overrides, mutated while the Shortcuts tab is open.
// Commits to state.config on Save; discarded on Cancel. Sparse map keyed
// by action id — missing entries fall back to the registry default.
let pendingOverrides = null;
let capturingId = null;

const shortcutsList = document.getElementById("shortcuts-list");
const shortcutsConflict = document.getElementById("shortcuts-conflict");
const RESET_ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>';

function showShortcutConflict(msg) {
  shortcutsConflict.textContent = msg;
  shortcutsConflict.classList.remove("hidden");
}
function hideShortcutConflict() {
  shortcutsConflict.textContent = "";
  shortcutsConflict.classList.add("hidden");
}
function formatAccelForDisplay(accel) {
  if (!accel) return "Not assigned";
  return accelToTokens(accel).join(" ");
}

function renderShortcutsPanel() {
  hideShortcutConflict();
  shortcutsList.innerHTML = "";
  const effective = effectiveBindings(pendingOverrides);

  // Group by category preserving registry order.
  const groups = [];
  const seen = new Map();
  for (const a of ACTIONS) {
    let g = seen.get(a.category);
    if (!g) {
      g = { name: a.category, actions: [] };
      seen.set(a.category, g);
      groups.push(g);
    }
    g.actions.push(a);
  }

  for (const g of groups) {
    const title = document.createElement("div");
    title.className = "shortcut-group-title";
    title.textContent = g.name;
    shortcutsList.appendChild(title);

    for (const a of g.actions) {
      const locked = isLinux && a.rebindableOnLinux === false;

      const row = document.createElement("div");
      row.className = "shortcut-edit-row" + (locked ? " locked" : "");
      row.dataset.actionId = a.id;

      const label = document.createElement("div");
      label.className = "shortcut-edit-label";
      label.textContent = a.label;
      if (locked) {
        const note = document.createElement("span");
        note.className = "shortcut-edit-label-note";
        note.textContent = "Fixed on Linux (handled by the window system)";
        label.appendChild(note);
      }
      row.appendChild(label);

      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "shortcut-edit-pill";
      pill.textContent = formatAccelForDisplay(effective[a.id]?.primary || "");
      pill.setAttribute("aria-label", `Change shortcut for ${a.label}`);
      if (locked) pill.disabled = true;
      row.appendChild(pill);

      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "shortcut-edit-reset";
      reset.setAttribute("aria-label", `Reset shortcut for ${a.label}`);
      reset.title = "Reset to default";
      reset.innerHTML = RESET_ICON_SVG;
      const overridden =
        pendingOverrides &&
        Object.prototype.hasOwnProperty.call(pendingOverrides, a.id);
      reset.disabled = !overridden || locked;
      row.appendChild(reset);

      shortcutsList.appendChild(row);

      if (locked) continue;

      pill.addEventListener("click", () => startShortcutCapture(a.id, pill));
      reset.addEventListener("click", () => {
        if (pendingOverrides) delete pendingOverrides[a.id];
        endShortcutCapture();
        renderShortcutsPanel();
      });
    }
  }
}

function startShortcutCapture(actionId, pill) {
  if (capturingId === actionId) return;
  if (capturingId) endShortcutCapture();
  capturingId = actionId;
  pill.classList.add("capturing");
  pill.textContent = "Press new shortcut\u2026";
  hideShortcutConflict();
  pill.focus();
}

function endShortcutCapture() {
  if (!capturingId) return;
  const row = shortcutsList.querySelector(
    `.shortcut-edit-row[data-action-id="${CSS.escape(capturingId)}"]`,
  );
  row?.querySelector(".shortcut-edit-pill")?.classList.remove("capturing");
  capturingId = null;
}

// Capture-phase so we absorb keydowns before the global dispatcher —
// otherwise trying to bind Mod+S would save the file mid-capture.
document.addEventListener(
  "keydown",
  (e) => {
    if (!capturingId) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      endShortcutCapture();
      renderShortcutsPanel();
      return;
    }
    if (MODIFIER_ONLY_KEYS.has(e.key)) return;

    const accel = eventToAccel(e);
    if (!accel) return;

    const action = ACTIONS.find((a) => a.id === capturingId);
    if (!action) return;

    const effective = effectiveBindings(pendingOverrides);
    const conflictId = findActionByAccel(effective, accel, capturingId);
    if (conflictId) {
      const other = ACTIONS.find((a) => a.id === conflictId);
      showShortcutConflict(
        `${accelToTokens(accel).join(" ")} is already assigned to "${other?.label || conflictId}". Reset that shortcut first or pick another combo.`,
      );
      return;
    }

    const defaultCanon = canonicalizeAccel(action.defaultAccel);
    if (accel === defaultCanon) {
      if (pendingOverrides) delete pendingOverrides[capturingId];
    } else {
      pendingOverrides = pendingOverrides || Object.create(null);
      pendingOverrides[capturingId] = accel;
    }
    endShortcutCapture();
    renderShortcutsPanel();
  },
  true,
);

// ── Settings ───────────────────────────────────────────────────────────────
const UPDATE_ICON_AVAILABLE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>';
const UPDATE_ICON_CURRENT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const UPDATE_ICON_ERROR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

function showUpdateStatus(kind, html) {
  const el = document.getElementById("update-status");
  el.className = `update-status ${kind}`;
  el.innerHTML = html;
  void el.offsetWidth; // restart animation
  el.classList.remove("hidden");
}

function hideUpdateStatus() {
  const el = document.getElementById("update-status");
  el.classList.add("hidden");
  el.innerHTML = "";
}

async function checkForUpdates() {
  const btn = document.getElementById("btn-check-updates");
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56"/><polyline points="21 3 21 9 15 9"/></svg>Checking\u2026';
  hideUpdateStatus();
  try {
    const result = await invoke("check_for_updates");
    if (result.available) {
      showUpdateStatus(
        "available",
        `
        ${UPDATE_ICON_AVAILABLE}
        <span class="update-message">Update available: <span class="update-version">v${result.version}</span></span>
        <button type="button" class="update-download">Download</button>
      `,
      );
      document
        .querySelector("#update-status .update-download")
        .addEventListener("click", () => {
          invoke("open_url", {
            url: "https://github.com/FenrirTheGray/OxideMD/releases/latest",
          });
        });
    } else {
      showUpdateStatus(
        "current",
        `${UPDATE_ICON_CURRENT}<span class="update-message">You are running the latest version.</span>`,
      );
    }
  } catch (e) {
    showUpdateStatus(
      "error",
      `${UPDATE_ICON_ERROR}<span class="update-message">Failed to check for updates: ${String(e).replace(/</g, "&lt;")}</span>`,
    );
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}

// Suppress the theme-select change handler while openSettings is
// populating inputs programmatically — otherwise the first setter
// would flip body class and swap bg inputs before they're populated.
let populatingSettings = false;

// Parses the comma-separated Markdown-extension field into a clean,
// normalized list: split on commas, trim, lowercase, strip every
// leading dot, drop empties, and dedupe. A field that normalizes to
// nothing falls back to the defaults so the folder browser never shows
// zero files.
function parseMdExtensions(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw || "").split(",")) {
    const ext = part.trim().toLowerCase().replace(/^\.+/, "");
    if (ext && !seen.has(ext)) {
      seen.add(ext);
      out.push(ext);
    }
  }
  return out.length ? out : [...MD_EXTS_DEFAULT];
}

export function openSettings(tabName) {
  // Close the search bar first so Settings can open over it.
  if (!searchBar.classList.contains("hidden")) closeSearch();
  if (hasActiveOverlay()) return;
  hideUpdateStatus();
  window.__TAURI__.app.getVersion().then((v) => {
    document.getElementById("settings-version").textContent = "v" + v;
  });
  populatingSettings = true;
  const resolved = resolvedTheme(state.config.theme);
  document.getElementById("setting-theme").value = state.config.theme;
  rebuildFontDropdown();
  fontSelect.value = state.config.font_family;
  document.getElementById("setting-size").value = state.config.font_size;
  document.getElementById("setting-line-height").value =
    state.config.line_height;
  document.getElementById("setting-reading-width").value =
    state.config.reading_width;
  document.getElementById("setting-h1").value = state.config.h1_color;
  document.getElementById("setting-h2").value = state.config.h2_color;
  document.getElementById("setting-h3").value = state.config.h3_color;
  document.getElementById("setting-bullet").value = state.config.bullet_color;
  document.getElementById("setting-code-bg").value = effectiveBgColor(
    state.config.code_bg_color,
    "code_bg_color",
    resolved,
  );
  document.getElementById("setting-code-accent").value =
    state.config.code_accent_color;
  document.getElementById("setting-note-bg").value = effectiveBgColor(
    state.config.note_bg_color,
    "note_bg_color",
    resolved,
  );
  document.getElementById("setting-note-accent").value =
    state.config.note_accent_color;
  document.getElementById("setting-toolbar-compact").value = state.config
    .toolbar_compact
    ? "true"
    : "false";
  document.getElementById("setting-show-recent-files").value =
    state.config.show_recent_files !== false ? "true" : "false";
  document.getElementById("setting-printer-friendly").value = state.config
    .printer_friendly
    ? "true"
    : "false";
  document.getElementById("setting-preserve-line-breaks").value = state.config
    .preserve_line_breaks
    ? "true"
    : "false";
  document.getElementById("setting-md-extensions").value = (
    Array.isArray(state.config.md_extensions) &&
    state.config.md_extensions.length
      ? state.config.md_extensions
      : MD_EXTS_DEFAULT
  ).join(", ");
  document.getElementById("setting-word-wrap").value =
    state.config.editor_word_wrap !== false ? "true" : "false";
  document.getElementById("setting-spell-check").value = state.config
    .editor_spell_check
    ? "true"
    : "false";
  document.getElementById("setting-line-numbers").value = state.config
    .editor_line_numbers
    ? "true"
    : "false";
  document.getElementById("setting-format-on-save").value = state.config
    .editor_format_on_save
    ? "true"
    : "false";
  // Interface-palette swatches — saved overrides over the theme defaults.
  const effPalette = effectivePalette(resolved, state.config.palette);
  for (const key of BASE_PALETTE_TOKENS) {
    document.getElementById(`setting-${key}`).value = effPalette[key];
  }
  populatingSettings = false;
  updatePreviewColors();
  updatePaletteHexLabels();
  // Seed the shortcuts working copy from the saved overrides so edits are
  // only committed on Save. Plain object, not state.config.keybindings
  // itself, so cancel leaves state untouched.
  pendingOverrides = Object.assign(
    Object.create(null),
    state.config.keybindings || {},
  );
  renderShortcutsPanel();
  // Render the custom-theme dropdown from whatever's cached, then refresh
  // both lists in the background (mirrors rebuildFontDropdown's
  // eager-then-lazy pattern). openSettings stays synchronous. Builtins
  // are static so they cache for the full session after the first fetch.
  applyStoredCustomThemeSelection();
  rebuildCustomThemeDropdown();
  const builtinPromise = state.builtinThemes.length
    ? Promise.resolve(state.builtinThemes)
    : invoke("list_builtin_themes").catch(() => []);
  Promise.all([
    builtinPromise,
    invoke("list_custom_themes").catch(() => []),
  ]).then(([builtins, customs]) => {
    state.builtinThemes = builtins;
    state.customThemes = customs;
    applyStoredCustomThemeSelection();
    rebuildCustomThemeDropdown();
    // Async refresh may have re-applied the same selection — keep
    // Save disabled if so, enable only when something actually drifted.
    refreshSaveButtonState();
  });
  activateSettingsTab(tabName || "general");
  settingsOverlay.classList.remove("hidden");
  state.releaseFocusTrap = trapFocus(
    document.getElementById("settings-dialog"),
  );
  // Form just mirrored state.config — nothing to save yet.
  refreshSaveButtonState();
}

function activateSettingsTab(name) {
  // Leaving the Shortcuts panel must cancel any in-progress capture so a
  // stray keypress in another panel doesn't get intercepted.
  if (name !== "shortcuts") endShortcutCapture();
  const tabs = document.querySelectorAll(".settings-tab");
  const panels = document.querySelectorAll(".settings-panel");
  tabs.forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
  });
  panels.forEach((p) => {
    const on = p.id === `settings-panel-${name}`;
    p.classList.toggle("active", on);
    p.hidden = !on;
  });
  document
    .getElementById("settings-dialog")
    .classList.toggle("on-about", name === "about");
  // Footer buttons follow the active tab: Reset only where there are
  // resettable settings (every tab in SETTINGS_TAB_LABELS — i.e. not
  // About); Save on every tab except About, which persists nothing.
  document.getElementById("settings-reset").hidden = !(
    name in SETTINGS_TAB_LABELS
  );
  document.getElementById("settings-save").hidden = name === "about";
}

function updatePreviewColors() {
  const body = document.body.style;
  const keys = [
    "h1",
    "h2",
    "h3",
    "bullet",
    "code-bg",
    "code-accent",
    "note-bg",
    "note-accent",
  ];
  keys.forEach((k) => {
    const v = document.getElementById(`setting-${k}`).value;
    body.setProperty(`--preview-${k}`, v);
    const hex = document.getElementById(`setting-${k}-hex`);
    if (hex) hex.textContent = v.toLowerCase();
  });
}

// Refresh the hex caption under every interface-palette swatch. The
// swatches themselves apply live to <body> (see the input listeners
// below), so unlike the content swatches there's no separate preview.
function updatePaletteHexLabels() {
  for (const key of BASE_PALETTE_TOKENS) {
    const hex = document.getElementById(`setting-${key}-hex`);
    if (hex)
      hex.textContent = document
        .getElementById(`setting-${key}`)
        .value.toLowerCase();
  }
}

// Reads the 27 interface swatches into a palette map. When every value
// still equals the built-in default for `resolved`, returns {} so an
// untouched palette keeps following dark/light mode switches; otherwise
// returns the full explicit map.
function collectPaletteFromInputs(resolved) {
  const map = {};
  let allDefault = true;
  for (const key of BASE_PALETTE_TOKENS) {
    const v = document.getElementById(`setting-${key}`).value;
    map[key] = v;
    if (v.toLowerCase() !== DEFAULT_PALETTE[resolved][key].toLowerCase())
      allDefault = false;
  }
  return allDefault ? {} : map;
}

// ── Custom theme import/export ─────────────────────────────────────────────
// Maps each color-config field name (as persisted in config.toml and used
// in the exported JSON) to the id of the Colors-tab control that holds it.
// This is the authoritative whitelist for import validation — any key not
// listed here is silently ignored.
const THEME_COLOR_FIELDS = {
  h1_color: "setting-h1",
  h2_color: "setting-h2",
  h3_color: "setting-h3",
  bullet_color: "setting-bullet",
  code_bg_color: "setting-code-bg",
  code_accent_color: "setting-code-accent",
  note_bg_color: "setting-note-bg",
  note_accent_color: "setting-note-accent",
};
const THEME_VALID_THEMES = ["dark", "light", "system"];
// #rgb or #rrggbb — the only shapes <input type="color"> accepts.
const THEME_HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// Surfaces a non-fatal settings error the same way loadCustomFont does:
// the shared status indicator, auto-cleared after a few seconds.
function showSettingsError(msg) {
  statusText.textContent = msg;
  statusIndicator.classList.remove("hidden", "status-loading");
  setTimeout(clearStatus, 4000);
}

// Gathers the CURRENT Colors-tab values (the in-dialog working copy, the
// same values saveSettings would persist) into the flat JSON shape and
// hands them to the backend's native save dialog.
async function exportTheme() {
  const theme = { theme: document.getElementById("setting-theme").value };
  // Inherit the currently-applied theme's display name when one is
  // selected so the export carries a meaningful label. Manual edits
  // clear the selection, in which case the backend falls back to the
  // saved file's stem.
  const ctValue = customThemeSelect.dataset.value || "";
  if (ctValue === CUSTOM_THEME_DEFAULT_VALUE) theme.name = ATOM_ONE_DARK.name;
  else if (ctValue === CUSTOM_THEME_DEFAULT_LIGHT_VALUE)
    theme.name = ATOM_ONE_LIGHT.name;
  else if (ctValue) {
    const match = findThemeByFilename(ctValue);
    if (match) theme.name = match.name;
  }
  for (const [field, id] of Object.entries(THEME_COLOR_FIELDS)) {
    theme[field] = document.getElementById(id).value;
  }
  // Carry the full base UI palette too, so an exported theme is a
  // complete skin rather than just the content colors.
  for (const key of BASE_PALETTE_TOKENS) {
    theme[key] = document.getElementById(`setting-${key}`).value;
  }
  try {
    await invoke("export_theme", { theme });
  } catch (e) {
    showSettingsError("Failed to export theme: " + e);
  }
}

// Native file picker → install → refresh dropdown → select. Triggered
// by the Import button next to the Font dropdown.
async function addFontFromDialog() {
  let result;
  try {
    result = await invoke("install_font");
  } catch (err) {
    showSettingsError("Failed to import font: " + err);
    return;
  }
  if (!result) return;
  state.customFonts = await invoke("list_custom_fonts");
  rebuildFontDropdown();
  fontSelect.value = `custom:${result.filename}`;
}

// Native open dialog → validate → persist → apply. Triggered by the
// Import theme button next to Export theme. Defensive validation matches
// the import branch the dropdown used to host.
async function importThemeFromDialog() {
  let imported;
  try {
    imported = await invoke("import_theme");
  } catch (err) {
    showSettingsError("Failed to import theme: " + err);
    return;
  }
  if (imported == null) return; // user cancelled the dialog

  const colors = imported.colors;
  if (typeof colors !== "object" || colors == null || Array.isArray(colors)) {
    showSettingsError("Invalid theme file: not a theme object.");
    return;
  }
  let recognized = 0;
  for (const [field] of Object.entries(THEME_COLOR_FIELDS)) {
    if (!(field in colors)) continue;
    const value = colors[field];
    if (typeof value !== "string" || !THEME_HEX_RE.test(value.trim())) {
      showSettingsError(`Invalid theme file: bad color for ${field}.`);
      return;
    }
    recognized++;
  }
  if ("theme" in colors) {
    const t = colors.theme;
    if (typeof t !== "string" || !THEME_VALID_THEMES.includes(t)) {
      showSettingsError("Invalid theme file: unknown theme value.");
      return;
    }
    recognized++;
  }
  for (const key of BASE_PALETTE_TOKENS) {
    if (!(key in colors)) continue;
    const value = colors[key];
    if (typeof value !== "string" || !THEME_HEX_RE.test(value.trim())) {
      showSettingsError(`Invalid theme file: bad color for ${key}.`);
      return;
    }
    recognized++;
  }
  if (recognized === 0) {
    showSettingsError("Invalid theme file: no recognized color settings.");
    return;
  }

  let saved;
  try {
    saved = await invoke("save_custom_theme", {
      name: imported.name,
      theme: colors,
    });
  } catch (err) {
    showSettingsError("Failed to save theme: " + err);
    return;
  }
  state.customThemes = await invoke("list_custom_themes");
  applyThemeToControls(colors);
  setCustomThemeSelection(saved.filename, saved.name);
  rebuildCustomThemeDropdown();
}

// Applies a flat theme color map to the Colors-tab controls and refreshes
// the live preview — without saving. Shared by the import-a-theme and
// select-a-saved-theme paths; both feed it an already-validated (or
// trusted, in the case of list_custom_themes results) map.
//
// `colors` is the flat field→hex shape (`h1_color`, `code_bg_color`, …)
// optionally including a `theme` key. Unknown keys are ignored. The user
// still confirms with Save (or discards with Cancel) like any other
// settings change.
function applyThemeToControls(colors) {
  // Apply under the populating flag so the theme select's change handler
  // (which rewrites the bg-color inputs via effectiveBgColor) early-returns
  // and doesn't clobber the incoming background values.
  populatingSettings = true;
  if (
    typeof colors.theme === "string" &&
    THEME_VALID_THEMES.includes(colors.theme)
  ) {
    document.getElementById("setting-theme").value = colors.theme;
    setBodyTheme(resolvedTheme(colors.theme));
  }
  for (const [field, id] of Object.entries(THEME_COLOR_FIELDS)) {
    const value = colors[field];
    if (typeof value === "string" && THEME_HEX_RE.test(value.trim())) {
      document.getElementById(id).value = value.trim();
    }
  }
  // Base UI palette tokens. Setting an <input type="color"> .value
  // doesn't fire `input`, so live-apply each one onto <body> here so the
  // window reskins immediately (closeSettings reverts on Cancel).
  for (const key of BASE_PALETTE_TOKENS) {
    const value = colors[key];
    if (typeof value === "string" && THEME_HEX_RE.test(value.trim())) {
      const input = document.getElementById(`setting-${key}`);
      input.value = value.trim();
      document.body.style.setProperty(`--${key}`, input.value);
    }
  }
  populatingSettings = false;
  updatePreviewColors();
  updatePaletteHexLabels();
}

export function closeSettings() {
  endShortcutCapture();
  if (state.releaseFocusTrap) {
    state.releaseFocusTrap();
    state.releaseFocusTrap = null;
  }
  if (
    settingsOverlay.classList.contains("hidden") ||
    settingsOverlay.classList.contains("closing")
  )
    return;
  // Revert any live preview changes — the theme-class swap and the
  // interface-palette swatches both apply live to <body> while the
  // dialog is open. Re-running applyConfig from the saved config undoes
  // any unsaved tweaks on Close; if the user clicked Save first,
  // state.config already holds the new values so this is a correct
  // no-op. (applyConfig only swaps the `theme-*` class, not the other
  // <body> state classes, so `editing`/`maximized`/etc. survive
  // closing Settings mid-edit.)
  applyConfig(state.config);
  settingsOverlay.classList.add("closing");
  settingsOverlay.addEventListener(
    "animationend",
    () => {
      settingsOverlay.classList.add("hidden");
      settingsOverlay.classList.remove("closing");
    },
    { once: true },
  );
}

// Build the candidate config from the current dialog state. Reused
// by `saveSettings` (commit path) and by `settingsAreDirty` (Save
// button enable check) so the two never drift.
function buildCandidateConfig() {
  return {
    ...state.config,
    theme: document.getElementById("setting-theme").value,
    font_family: fontSelect.value,
    font_size: parseInt(document.getElementById("setting-size").value, 10),
    line_height: parseFloat(
      document.getElementById("setting-line-height").value,
    ),
    reading_width: parseInt(
      document.getElementById("setting-reading-width").value,
      10,
    ),
    h1_color: document.getElementById("setting-h1").value,
    h2_color: document.getElementById("setting-h2").value,
    h3_color: document.getElementById("setting-h3").value,
    bullet_color: document.getElementById("setting-bullet").value,
    code_bg_color: document.getElementById("setting-code-bg").value,
    code_accent_color: document.getElementById("setting-code-accent").value,
    note_bg_color: document.getElementById("setting-note-bg").value,
    note_accent_color: document.getElementById("setting-note-accent").value,
    toolbar_compact:
      document.getElementById("setting-toolbar-compact").value === "true",
    show_recent_files:
      document.getElementById("setting-show-recent-files").value === "true",
    printer_friendly:
      document.getElementById("setting-printer-friendly").value === "true",
    preserve_line_breaks:
      document.getElementById("setting-preserve-line-breaks").value === "true",
    md_extensions: parseMdExtensions(
      document.getElementById("setting-md-extensions").value,
    ),
    editor_word_wrap:
      document.getElementById("setting-word-wrap").value === "true",
    editor_spell_check:
      document.getElementById("setting-spell-check").value === "true",
    editor_line_numbers:
      document.getElementById("setting-line-numbers").value === "true",
    editor_format_on_save:
      document.getElementById("setting-format-on-save").value === "true",
    keybindings: pendingOverrides ? { ...pendingOverrides } : {},
    // Compared against the theme being saved, so an in-dialog mode flip
    // is handled; an all-default palette collapses to {} (keeps tracking
    // dark/light), otherwise the full explicit map is stored.
    palette: collectPaletteFromInputs(
      resolvedTheme(document.getElementById("setting-theme").value),
    ),
    custom_theme: customThemeSelect.dataset.value || "",
  };
}

// Stable JSON used to compare candidate config against state.config:
// object key order isn't guaranteed equal between the spread-built
// candidate and the disk-loaded state.config, so a naive
// JSON.stringify diff would flag false positives.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
      .join(",") +
    "}"
  );
}

function settingsAreDirty() {
  return stableStringify(buildCandidateConfig()) !== stableStringify(state.config);
}

function refreshSaveButtonState() {
  const btn = document.getElementById("settings-save");
  if (!btn) return;
  btn.disabled = !settingsAreDirty();
}

async function saveSettings() {
  // Captured before state.config is replaced — preserve_line_breaks
  // changes the rendered HTML, so a change needs open docs re-rendered.
  const prevPreserveLineBreaks = state.config.preserve_line_breaks;
  const newConfig = buildCandidateConfig();
  setLoading();
  try {
    await invoke("save_config_cmd", { config: newConfig });
    if (newConfig.font_family.startsWith("custom:")) {
      await loadCustomFont(newConfig.font_family.slice(7));
    }
    state.config = newConfig;
    state.bindings = effectiveBindings(newConfig.keybindings);
    renderShortcutsUI();
    applyConfig(state.config);
    // Re-paint the welcome screen's recent-files panel so the toggle
    // takes effect immediately without needing to reopen the window.
    applyRecentFiles(state.recentFiles);
    const tab = activeTab();
    if (tab) applyZoom(tab.zoom);
    // preserve_line_breaks changes the rendered HTML itself (a <br> vs a
    // space for single newlines), not just CSS — so unlike the other
    // reading settings the open documents must be re-rendered for the
    // change to show. Re-render every tab's cached HTML from its source
    // buffer, then refresh whatever's currently on screen.
    if (prevPreserveLineBreaks !== newConfig.preserve_line_breaks) {
      for (const t of tabs) {
        if (!t.path && !(t.raw ?? "")) continue;
        try {
          t.html = await invoke("render_preview", {
            content: t.raw ?? "",
            path: t.path ?? "",
          });
        } catch (e) {
          // Keep the stale render for this tab rather than aborting the
          // loop; the active tab still gets refreshed below if it rendered.
          console.warn(
            "Failed to re-render tab after line-break setting change:",
            t.path ?? "(untitled)",
            e,
          );
        }
      }
      if (tab) {
        if (tab.editing) setPreviewHtml(tab.html);
        else renderContent(tab.html);
      }
    }
    // Save persists without closing the modal; the Close button is the
    // only way out. This lets the user iterate on settings while
    // watching the live preview behind the dialog without reopening
    // Settings between each tweak.
    refreshSaveButtonState();
  } catch (e) {
    alert("Failed to save settings: " + e);
  } finally {
    clearStatus();
  }
}

// Human-readable name for each settings tab, used in the reset confirm
// copy so the prompt names exactly what's about to be clobbered.
const SETTINGS_TAB_LABELS = {
  general: "General",
  reading: "Reading",
  editor: "Editor",
  colors: "Colors",
  shortcuts: "Shortcuts",
};

async function resetSettings() {
  const activeTabName = document.querySelector(".settings-tab.active")?.dataset
    .tab;
  // The About tab has no resettable settings — nothing to confirm or do.
  if (!activeTabName || !(activeTabName in SETTINGS_TAB_LABELS)) return;

  // Destructive: gate behind the shared confirm dialog before touching
  // any inputs. 'discard' = the user pressed "Reset"; anything else
  // (Cancel / Escape / overlay click) leaves the settings untouched.
  const decision = await promptResetSettings(
    SETTINGS_TAB_LABELS[activeTabName],
  );
  if (decision !== "discard") return;

  const defaults = await invoke("get_default_config");
  if (activeTabName === "general") {
    document.getElementById("setting-toolbar-compact").value =
      defaults.toolbar_compact ? "true" : "false";
    document.getElementById("setting-show-recent-files").value =
      defaults.show_recent_files !== false ? "true" : "false";
    document.getElementById("setting-printer-friendly").value =
      defaults.printer_friendly ? "true" : "false";
    document.getElementById("setting-md-extensions").value = (
      Array.isArray(defaults.md_extensions) && defaults.md_extensions.length
        ? defaults.md_extensions
        : MD_EXTS_DEFAULT
    ).join(", ");
  } else if (activeTabName === "reading") {
    rebuildFontDropdown();
    fontSelect.value = defaults.font_family;
    document.getElementById("setting-size").value = defaults.font_size;
    document.getElementById("setting-line-height").value = defaults.line_height;
    document.getElementById("setting-reading-width").value =
      defaults.reading_width;
    document.getElementById("setting-preserve-line-breaks").value =
      defaults.preserve_line_breaks ? "true" : "false";
  } else if (activeTabName === "editor") {
    document.getElementById("setting-word-wrap").value =
      defaults.editor_word_wrap !== false ? "true" : "false";
    document.getElementById("setting-spell-check").value =
      defaults.editor_spell_check ? "true" : "false";
    document.getElementById("setting-line-numbers").value =
      defaults.editor_line_numbers ? "true" : "false";
    document.getElementById("setting-format-on-save").value =
      defaults.editor_format_on_save ? "true" : "false";
  } else if (activeTabName === "colors") {
    document.getElementById("setting-theme").value = defaults.theme;
    document.getElementById("setting-h1").value = defaults.h1_color;
    document.getElementById("setting-h2").value = defaults.h2_color;
    document.getElementById("setting-h3").value = defaults.h3_color;
    document.getElementById("setting-bullet").value = defaults.bullet_color;
    // Bg defaults follow the currently-selected theme so Reset under
    // Light leaves readable light backgrounds rather than dark-on-dark.
    const resolved = resolvedTheme(
      document.getElementById("setting-theme").value,
    );
    document.getElementById("setting-code-bg").value =
      BG_DEFAULTS[resolved].code_bg_color;
    document.getElementById("setting-code-accent").value =
      defaults.code_accent_color;
    document.getElementById("setting-note-bg").value =
      BG_DEFAULTS[resolved].note_bg_color;
    document.getElementById("setting-note-accent").value =
      defaults.note_accent_color;
    updatePreviewColors();
    // Interface palette back to the built-in defaults for the resolved
    // theme, applied live so the reset is visible immediately.
    for (const key of BASE_PALETTE_TOKENS) {
      document.getElementById(`setting-${key}`).value =
        DEFAULT_PALETTE[resolved][key];
    }
    updatePaletteHexLabels();
    applyPaletteToBody(DEFAULT_PALETTE[resolved]);
    clearCustomThemeSelection();
  } else if (activeTabName === "shortcuts") {
    // Drop every override so every action falls back to its registry
    // default. Still a pending change until the user hits Save.
    pendingOverrides = Object.create(null);
    renderShortcutsPanel();
  }
}

// ── Settings event wiring ─────────────────────────────────────────────────
document
  .getElementById("settings-close")
  .addEventListener("click", closeSettings);
document
  .getElementById("settings-cancel")
  .addEventListener("click", closeSettings);
document
  .getElementById("settings-reset")
  .addEventListener("click", resetSettings);
document
  .getElementById("settings-save")
  .addEventListener("click", saveSettings);
document
  .getElementById("btn-check-updates")
  .addEventListener("click", checkForUpdates);
document
  .getElementById("btn-export-theme")
  .addEventListener("click", exportTheme);
document
  .getElementById("btn-import-theme")
  .addEventListener("click", importThemeFromDialog);
document
  .getElementById("btn-import-font")
  .addEventListener("click", addFontFromDialog);

// Save button is enabled only while the dialog state differs from the
// persisted config. The custom widgets (segmented pills, custom-select
// dropdowns, shortcut editor) mutate dataset attributes without
// dispatching native input/change events, so a click listener at the
// dialog root catches them via bubbling — we wait one rAF so the
// widget's own click handler has finished mutating before we diff.
{
  const dialog = document.getElementById("settings-dialog");
  let dirtyRafId = 0;
  const scheduleDirtyCheck = () => {
    if (dirtyRafId) return;
    dirtyRafId = requestAnimationFrame(() => {
      dirtyRafId = 0;
      refreshSaveButtonState();
    });
  };
  dialog.addEventListener("input", scheduleDirtyCheck);
  dialog.addEventListener("change", scheduleDirtyCheck);
  dialog.addEventListener("click", scheduleDirtyCheck);
  dialog.addEventListener("keyup", scheduleDirtyCheck);
}

// Settings tab switching
const settingsTabButtons = Array.from(
  document.querySelectorAll(".settings-tab"),
);
settingsTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => activateSettingsTab(btn.dataset.tab));
});
document.getElementById("settings-tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const idx = settingsTabButtons.findIndex((b) =>
    b.classList.contains("active"),
  );
  if (idx === -1) return;
  e.preventDefault();
  const delta = e.key === "ArrowRight" ? 1 : -1;
  const next =
    settingsTabButtons[
      (idx + delta + settingsTabButtons.length) % settingsTabButtons.length
    ];
  activateSettingsTab(next.dataset.tab);
  next.focus();
});

// Live preview updates. The trigger label tracks the *last applied*
// saved theme, so any manual color edit makes that label stale — clear
// it so the dropdown falls back to the placeholder.
[
  "setting-h1",
  "setting-h2",
  "setting-h3",
  "setting-bullet",
  "setting-code-bg",
  "setting-code-accent",
  "setting-note-bg",
  "setting-note-accent",
].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener("input", updatePreviewColors);
  el.addEventListener("input", clearCustomThemeSelection);
});

// Interface-palette swatches apply live to <body> as you drag them —
// the live app behind the dialog is their preview. closeSettings
// re-applies the saved config, so a Cancel reverts these edits.
for (const key of BASE_PALETTE_TOKENS) {
  document.getElementById(`setting-${key}`).addEventListener("input", (e) => {
    document.body.style.setProperty(`--${key}`, e.target.value);
    const hex = document.getElementById(`setting-${key}-hex`);
    if (hex) hex.textContent = e.target.value.toLowerCase();
    clearCustomThemeSelection();
  });
}

// About panel external link
document.querySelectorAll(".about-link[data-url]").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("open_url", { url: a.dataset.url });
  });
});
