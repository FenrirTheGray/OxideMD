import {
  invoke,
  listen,
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
} from "../core/state.ts";
import {
  activeTab,
  applyZoom,
  setLoading,
  clearStatus,
  renderContent,
  applyRecentFiles,
} from "../ui/tabs.ts";
import { editorModule } from "../editor/lazy.ts";
import { promptResetSettings, promptDiscardSettings } from "../ui/confirm.ts";
import { closeSearch } from "../features/search.ts";
import {
  ACTIONS,
  effectiveBindings,
  findActionByAccel,
  eventToAccel,
  accelToTokens,
  canonicalizeAccel,
  MODIFIER_ONLY_KEYS,
} from "../core/keybindings.ts";
import { renderShortcutsUI } from "../ui/shortcuts-display.ts";
import { updateToolbarLayout } from "../ui/window-size.ts";
import { logWarn } from "../core/logger.ts";
import {
  BG_DEFAULTS,
  effectiveBgColor,
  BASE_PALETTE_TOKENS,
  DEFAULT_PALETTE,
  effectivePalette,
  applyPaletteToBody,
  setBodyTheme,
} from "./palette.ts";
import { checkForUpdates, hideUpdateStatus } from "./updates.ts";
import { trapFocus } from "./controls.ts";
import { fontSelect, rebuildFontDropdown } from "./fonts.ts";

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
  // Re-evaluate the responsive toolbar — toggling the user preference off
  // while the window is narrow should still leave labels hidden / buttons
  // overflowed, and toggling it on shouldn't strand a stale class either way.
  updateToolbarLayout();
}

// Live update when the OS switches dark/light while theme is set to 'system'
systemDarkMQ.addEventListener("change", () => {
  if (state.config?.theme === "system") applyConfig(state.config);
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
  (customThemeSelect as HTMLElement).dataset.value = value || "";
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

  switch ((e as KeyboardEvent).key) {
    case "Enter":
    case " ":
      e.preventDefault();
      if (customThemeSelect.classList.contains("open") && focusedIdx >= 0) {
        (opts[focusedIdx] as HTMLElement).click();
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
        (opts[focusedIdx] as HTMLElement).scrollIntoView({ block: "nearest" });
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
        (opts[focusedIdx] as HTMLElement).scrollIntoView({ block: "nearest" });
      break;
    case "Escape":
      if (customThemeSelect.classList.contains("open")) {
        e.preventDefault();
        e.stopPropagation();
        closeCustomThemeSelect();
        (customThemeTrigger as HTMLElement).focus();
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
  (opt as HTMLElement).dataset.value = theme.filename;
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
  const removeBtn = (e.target as HTMLElement).closest(".custom-font-remove");
  if (removeBtn) {
    e.stopPropagation();
    const opt = removeBtn.closest(".custom-select-option");
    const label = opt.querySelector(".custom-font-label");
    const themeName = label ? label.textContent : "this theme";
    if (
      !confirm(`Remove "${themeName}"? The saved theme file will be deleted.`)
    )
      return;
    const filename = (opt as HTMLElement).dataset.value;
    await invoke("delete_custom_theme", { filename });
    state.customThemes = await invoke("list_custom_themes");
    if ((customThemeSelect as HTMLElement).dataset.value === filename)
      clearCustomThemeSelection();
    rebuildCustomThemeDropdown();
    return;
  }

  const opt = (e.target as HTMLElement).closest(".custom-select-option");
  if (!opt) return;

  // Atom One Dark / Atom One Light — the bundled-by-name handles for
  // the original built-in dark and light palettes + content defaults.
  // Each pins its own mode so the label always matches what the user
  // sees, no matter what was applied before.
  if (
    (opt as HTMLElement).dataset.value === CUSTOM_THEME_DEFAULT_VALUE ||
    (opt as HTMLElement).dataset.value === CUSTOM_THEME_DEFAULT_LIGHT_VALUE
  ) {
    const mode =
      (opt as HTMLElement).dataset.value === CUSTOM_THEME_DEFAULT_VALUE ? "dark" : "light";
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
      (opt as HTMLElement).dataset.value === CUSTOM_THEME_DEFAULT_VALUE
        ? ATOM_ONE_DARK.name
        : ATOM_ONE_LIGHT.name;
    setCustomThemeSelection((opt as HTMLElement).dataset.value, pretty);
    closeCustomThemeSelect();
    // This path awaited get_default_config before applying, so the dialog's
    // delegated click dirty-check already ran against the pre-apply state.
    // Recompute explicitly or Save stays stale until the next interaction.
    refreshSaveButtonState();
    return;
  }

  // Normal theme selection: apply the picked theme's colors to the
  // Colors-tab controls + preview. Looks across bundled + imported lists
  // (both trusted: built-in JSON ships with the app, list_custom_themes
  // is the only writer of the user themes dir).
  const theme = findThemeByFilename((opt as HTMLElement).dataset.value);
  if (theme) {
    applyThemeToControls(theme.colors);
    setCustomThemeSelection(theme.filename, theme.name);
  }
  closeCustomThemeSelect();
});

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

    if ((e as KeyboardEvent).key === "Escape") {
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
  // Accepts either the chips control's normalized array (`.value`) or a
  // raw comma string, so the same fallback-to-defaults logic covers both.
  const parts = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const seen = new Set();
  const out = [];
  for (const part of parts) {
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
  (document.getElementById("setting-theme") as HTMLInputElement).value = state.config.theme;
  rebuildFontDropdown();
  (fontSelect as HTMLSelectElement).value = state.config.font_family;
  (document.getElementById("setting-size") as HTMLInputElement).value = state.config.font_size;
  (document.getElementById("setting-line-height") as HTMLInputElement).value =
    state.config.line_height;
  (document.getElementById("setting-reading-width") as HTMLInputElement).value =
    state.config.reading_width;
  (document.getElementById("setting-h1") as HTMLInputElement).value = state.config.h1_color;
  (document.getElementById("setting-h2") as HTMLInputElement).value = state.config.h2_color;
  (document.getElementById("setting-h3") as HTMLInputElement).value = state.config.h3_color;
  (document.getElementById("setting-bullet") as HTMLInputElement).value = state.config.bullet_color;
  (document.getElementById("setting-code-bg") as HTMLInputElement).value = effectiveBgColor(
    state.config.code_bg_color,
    "code_bg_color",
    resolved,
  );
  (document.getElementById("setting-code-accent") as HTMLInputElement).value =
    state.config.code_accent_color;
  (document.getElementById("setting-note-bg") as HTMLInputElement).value = effectiveBgColor(
    state.config.note_bg_color,
    "note_bg_color",
    resolved,
  );
  (document.getElementById("setting-note-accent") as HTMLInputElement).value =
    state.config.note_accent_color;
  (document.getElementById("setting-toolbar-compact") as HTMLInputElement).value = state.config
    .toolbar_compact
    ? "true"
    : "false";
  (document.getElementById("setting-show-recent-files") as HTMLInputElement).value =
    state.config.show_recent_files !== false ? "true" : "false";
  (document.getElementById("setting-printer-friendly") as HTMLInputElement).value = state.config
    .printer_friendly
    ? "true"
    : "false";
  (document.getElementById("setting-preserve-line-breaks") as HTMLInputElement).value = state.config
    .preserve_line_breaks
    ? "true"
    : "false";
  (document.getElementById("setting-load-remote-images") as HTMLInputElement).value = state.config
    .load_remote_images
    ? "true"
    : "false";
  (document.getElementById("setting-md-extensions") as HTMLInputElement).value =
    Array.isArray(state.config.md_extensions) &&
    state.config.md_extensions.length
      ? state.config.md_extensions
      : MD_EXTS_DEFAULT;
  (document.getElementById("setting-word-wrap") as HTMLInputElement).value =
    state.config.editor_word_wrap !== false ? "true" : "false";
  (document.getElementById("setting-spell-check") as HTMLInputElement).value = state.config
    .editor_spell_check
    ? "true"
    : "false";
  (document.getElementById("setting-line-numbers") as HTMLInputElement).value = state.config
    .editor_line_numbers
    ? "true"
    : "false";
  (document.getElementById("setting-format-on-save") as HTMLInputElement).value = state.config
    .editor_format_on_save
    ? "true"
    : "false";
  // Interface-palette swatches — saved overrides over the theme defaults.
  const effPalette = effectivePalette(resolved, state.config.palette);
  for (const key of BASE_PALETTE_TOKENS) {
    (document.getElementById(`setting-${key}`) as HTMLInputElement).value = effPalette[key];
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
  // showModal() traps focus + inerts the background natively, and restores
  // focus to the trigger on close(). Escape routes through closeSettings
  // (see the global handler in app.ts) for the unsaved-changes prompt; the
  // cancel listener below blocks the native instant-close that would skip it.
  settingsOverlay.showModal();
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
    const on = (t as HTMLElement).dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    (t as HTMLElement).tabIndex = on ? 0 : -1;
  });
  panels.forEach((p) => {
    const on = p.id === `settings-panel-${name}`;
    p.classList.toggle("active", on);
    (p as HTMLElement).hidden = !on;
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
    const v = (document.getElementById(`setting-${k}`) as HTMLInputElement).value;
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
      hex.textContent = (document
        .getElementById(`setting-${key}`) as HTMLInputElement)
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
    const v = (document.getElementById(`setting-${key}`) as HTMLInputElement).value;
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
  const theme: any = { theme: (document.getElementById("setting-theme") as HTMLInputElement).value };
  // Inherit the currently-applied theme's display name when one is
  // selected so the export carries a meaningful label. Manual edits
  // clear the selection, in which case the backend falls back to the
  // saved file's stem.
  const ctValue = (customThemeSelect as HTMLElement).dataset.value || "";
  if (ctValue === CUSTOM_THEME_DEFAULT_VALUE) theme.name = ATOM_ONE_DARK.name;
  else if (ctValue === CUSTOM_THEME_DEFAULT_LIGHT_VALUE)
    theme.name = ATOM_ONE_LIGHT.name;
  else if (ctValue) {
    const match = findThemeByFilename(ctValue);
    if (match) theme.name = match.name;
  }
  for (const [field, id] of Object.entries(THEME_COLOR_FIELDS)) {
    theme[field] = (document.getElementById(id) as HTMLInputElement).value;
  }
  // Carry the full base UI palette too, so an exported theme is a
  // complete skin rather than just the content colors.
  for (const key of BASE_PALETTE_TOKENS) {
    theme[key] = (document.getElementById(`setting-${key}`) as HTMLInputElement).value;
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
  (fontSelect as HTMLSelectElement).value = `custom:${result.filename}`;
  // This selection happens asynchronously, after the Import click was
  // already diffed by the dialog's delegated listeners, and it mutates
  // the dropdown programmatically (no input/change event). Recompute the
  // dirty state explicitly or the Save button stays stale until the next
  // interaction.
  refreshSaveButtonState();
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
  // Same async/programmatic-mutation caveat as addFontFromDialog: these
  // updates land after the Import click was diffed and fire no events, so
  // recompute the dirty state to enable Save without an extra interaction.
  refreshSaveButtonState();
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
    (document.getElementById("setting-theme") as HTMLInputElement).value = colors.theme;
    setBodyTheme(resolvedTheme(colors.theme));
  }
  for (const [field, id] of Object.entries(THEME_COLOR_FIELDS)) {
    const value = colors[field];
    if (typeof value === "string" && THEME_HEX_RE.test(value.trim())) {
      (document.getElementById(id) as HTMLInputElement).value = value.trim();
    }
  }
  // Base UI palette tokens. Setting an <input type="color"> .value
  // doesn't fire `input`, so live-apply each one onto <body> here so the
  // window reskins immediately (closeSettings reverts on Cancel).
  for (const key of BASE_PALETTE_TOKENS) {
    const value = colors[key];
    if (typeof value === "string" && THEME_HEX_RE.test(value.trim())) {
      const input = document.getElementById(`setting-${key}`) as HTMLInputElement;
      input.value = value.trim();
      document.body.style.setProperty(`--${key}`, input.value);
    }
  }
  populatingSettings = false;
  updatePreviewColors();
  updatePaletteHexLabels();
}

export async function closeSettings() {
  endShortcutCapture();
  if (!settingsOverlay.open || settingsOverlay.classList.contains("closing"))
    return;
  // Unsaved changes → confirm before discarding them. Save commits and then
  // closes; Discard closes losing the tweaks; Cancel keeps the dialog open.
  if (settingsAreDirty()) {
    const decision = await promptDiscardSettings();
    if (decision === "cancel") return;
    if (decision === "save") await saveSettings();
    // "discard" falls through to the revert-and-close path below.
  }
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
      settingsOverlay.close();
      settingsOverlay.classList.remove("closing");
    },
    { once: true },
  );
}

// Escape routes through the global handler's closeSettings (for the
// unsaved-changes prompt); block the native dialog Escape so it can't
// close instantly and skip that prompt.
settingsOverlay.addEventListener("cancel", (e) => e.preventDefault());

// Build the candidate config from the current dialog state. Reused
// by `saveSettings` (commit path) and by `settingsAreDirty` (Save
// button enable check) so the two never drift.
function buildCandidateConfig() {
  return {
    ...state.config,
    theme: (document.getElementById("setting-theme") as HTMLInputElement).value,
    font_family: (fontSelect as HTMLSelectElement).value,
    font_size: parseInt((document.getElementById("setting-size") as HTMLInputElement).value, 10),
    line_height: parseFloat(
      (document.getElementById("setting-line-height") as HTMLInputElement).value,
    ),
    reading_width: parseInt(
      (document.getElementById("setting-reading-width") as HTMLInputElement).value,
      10,
    ),
    h1_color: (document.getElementById("setting-h1") as HTMLInputElement).value,
    h2_color: (document.getElementById("setting-h2") as HTMLInputElement).value,
    h3_color: (document.getElementById("setting-h3") as HTMLInputElement).value,
    bullet_color: (document.getElementById("setting-bullet") as HTMLInputElement).value,
    code_bg_color: (document.getElementById("setting-code-bg") as HTMLInputElement).value,
    code_accent_color: (document.getElementById("setting-code-accent") as HTMLInputElement).value,
    note_bg_color: (document.getElementById("setting-note-bg") as HTMLInputElement).value,
    note_accent_color: (document.getElementById("setting-note-accent") as HTMLInputElement).value,
    toolbar_compact:
      (document.getElementById("setting-toolbar-compact") as HTMLInputElement).value === "true",
    show_recent_files:
      (document.getElementById("setting-show-recent-files") as HTMLInputElement).value === "true",
    printer_friendly:
      (document.getElementById("setting-printer-friendly") as HTMLInputElement).value === "true",
    preserve_line_breaks:
      (document.getElementById("setting-preserve-line-breaks") as HTMLInputElement).value === "true",
    load_remote_images:
      (document.getElementById("setting-load-remote-images") as HTMLInputElement).value === "true",
    md_extensions: parseMdExtensions(
      (document.getElementById("setting-md-extensions") as HTMLInputElement).value,
    ),
    editor_word_wrap:
      (document.getElementById("setting-word-wrap") as HTMLInputElement).value === "true",
    editor_spell_check:
      (document.getElementById("setting-spell-check") as HTMLInputElement).value === "true",
    editor_line_numbers:
      (document.getElementById("setting-line-numbers") as HTMLInputElement).value === "true",
    editor_format_on_save:
      (document.getElementById("setting-format-on-save") as HTMLInputElement).value === "true",
    keybindings: pendingOverrides ? { ...pendingOverrides } : {},
    // Compared against the theme being saved, so an in-dialog mode flip
    // is handled; an all-default palette collapses to {} (keeps tracking
    // dark/light), otherwise the full explicit map is stored.
    palette: collectPaletteFromInputs(
      resolvedTheme((document.getElementById("setting-theme") as HTMLInputElement).value),
    ),
    custom_theme: (customThemeSelect as HTMLElement).dataset.value || "",
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
  const btn = document.getElementById("settings-save") as HTMLButtonElement;
  if (!btn) return;
  btn.disabled = !settingsAreDirty();
}

async function saveSettings() {
  // Captured before state.config is replaced — preserve_line_breaks
  // changes the rendered HTML, so a change needs open docs re-rendered.
  const prevPreserveLineBreaks = state.config.preserve_line_breaks;
  // load_remote_images doesn't change the cached HTML (the renderer always
  // emits inert remote-image placeholders); flipping it just re-hydrates
  // the visible view to load or drop the live srcs.
  const prevLoadRemoteImages = state.config.load_remote_images;
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
          logWarn(
            'settings',
            `re-render after line-break change failed for ${t.path ?? '(untitled)'}`,
            e,
          );
        }
      }
      if (tab) {
        if (tab.editing) editorModule()?.setPreviewHtml(tab.html);
        else renderContent(tab.html);
      }
    }
    // load_remote_images flips which remote images are live without
    // changing the cached HTML, so just re-mount the active view to re-run
    // image hydration with the new setting — loading remote images, or
    // dropping them back to inert placeholders. Skipped when the line-break
    // re-render above already refreshed the same view.
    if (
      prevLoadRemoteImages !== newConfig.load_remote_images &&
      prevPreserveLineBreaks === newConfig.preserve_line_breaks &&
      tab
    ) {
      if (tab.editing) editorModule()?.setPreviewHtml(tab.html);
      else renderContent(tab.html);
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
const SETTINGS_TAB_LABELS: Record<string, string> = {
  general: "General",
  associations: "Associations",
  reading: "Reading",
  editor: "Editor",
  colors: "Colors",
  shortcuts: "Shortcuts",
};

async function resetSettings() {
  const activeTabName = (document.querySelector(".settings-tab.active") as HTMLElement)?.dataset
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
    (document.getElementById("setting-toolbar-compact") as HTMLInputElement).value =
      defaults.toolbar_compact ? "true" : "false";
    (document.getElementById("setting-show-recent-files") as HTMLInputElement).value =
      defaults.show_recent_files !== false ? "true" : "false";
    (document.getElementById("setting-printer-friendly") as HTMLInputElement).value =
      defaults.printer_friendly ? "true" : "false";
  } else if (activeTabName === "associations") {
    (document.getElementById("setting-md-extensions") as HTMLInputElement).value =
      Array.isArray(defaults.md_extensions) && defaults.md_extensions.length
        ? defaults.md_extensions
        : MD_EXTS_DEFAULT;
  } else if (activeTabName === "reading") {
    rebuildFontDropdown();
    (fontSelect as HTMLSelectElement).value = defaults.font_family;
    (document.getElementById("setting-size") as HTMLInputElement).value = defaults.font_size;
    (document.getElementById("setting-line-height") as HTMLInputElement).value = defaults.line_height;
    (document.getElementById("setting-reading-width") as HTMLInputElement).value =
      defaults.reading_width;
    (document.getElementById("setting-preserve-line-breaks") as HTMLInputElement).value =
      defaults.preserve_line_breaks ? "true" : "false";
  } else if (activeTabName === "editor") {
    (document.getElementById("setting-word-wrap") as HTMLInputElement).value =
      defaults.editor_word_wrap !== false ? "true" : "false";
    (document.getElementById("setting-spell-check") as HTMLInputElement).value =
      defaults.editor_spell_check ? "true" : "false";
    (document.getElementById("setting-line-numbers") as HTMLInputElement).value =
      defaults.editor_line_numbers ? "true" : "false";
    (document.getElementById("setting-format-on-save") as HTMLInputElement).value =
      defaults.editor_format_on_save ? "true" : "false";
  } else if (activeTabName === "colors") {
    (document.getElementById("setting-theme") as HTMLInputElement).value = defaults.theme;
    (document.getElementById("setting-h1") as HTMLInputElement).value = defaults.h1_color;
    (document.getElementById("setting-h2") as HTMLInputElement).value = defaults.h2_color;
    (document.getElementById("setting-h3") as HTMLInputElement).value = defaults.h3_color;
    (document.getElementById("setting-bullet") as HTMLInputElement).value = defaults.bullet_color;
    // Bg defaults follow the currently-selected theme so Reset under
    // Light leaves readable light backgrounds rather than dark-on-dark.
    const resolved = resolvedTheme(
      (document.getElementById("setting-theme") as HTMLInputElement).value,
    );
    (document.getElementById("setting-code-bg") as HTMLInputElement).value =
      BG_DEFAULTS[resolved].code_bg_color;
    (document.getElementById("setting-code-accent") as HTMLInputElement).value =
      defaults.code_accent_color;
    (document.getElementById("setting-note-bg") as HTMLInputElement).value =
      BG_DEFAULTS[resolved].note_bg_color;
    (document.getElementById("setting-note-accent") as HTMLInputElement).value =
      defaults.note_accent_color;
    updatePreviewColors();
    // Interface palette back to the built-in defaults for the resolved
    // theme, applied live so the reset is visible immediately.
    for (const key of BASE_PALETTE_TOKENS) {
      (document.getElementById(`setting-${key}`) as HTMLInputElement).value =
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
  btn.addEventListener("click", () => activateSettingsTab((btn as HTMLElement).dataset.tab));
});
document.getElementById("settings-tabs").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key !== "ArrowLeft" && (e as KeyboardEvent).key !== "ArrowRight") return;
  const idx = settingsTabButtons.findIndex((b) =>
    b.classList.contains("active"),
  );
  if (idx === -1) return;
  e.preventDefault();
  const delta = (e as KeyboardEvent).key === "ArrowRight" ? 1 : -1;
  const next =
    settingsTabButtons[
      (idx + delta + settingsTabButtons.length) % settingsTabButtons.length
    ];
  activateSettingsTab((next as HTMLElement).dataset.tab);
  (next as HTMLElement).focus();
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
    document.body.style.setProperty(`--${key}`, (e.target as HTMLInputElement).value);
    const hex = document.getElementById(`setting-${key}-hex`);
    if (hex) hex.textContent = (e.target as HTMLInputElement).value.toLowerCase();
    clearCustomThemeSelection();
  });
}

// About panel external link
document.querySelectorAll(".about-link[data-url]").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("open_url", { url: (a as HTMLElement).dataset.url });
  });
});
