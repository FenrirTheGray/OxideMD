// Font dropdown (dynamic options) for the Reading tab.
//
// Split out of settings.js. Self-contained apart from `invoke`/`state`: it
// owns the #setting-font custom-select, builds its options from the built-in
// list + state.customFonts, and handles per-font removal. settings.js imports
// `fontSelect` (to read/write the selected value) and `rebuildFontDropdown`
// (to repopulate on open / reset / import). The actual @font-face loading
// (loadCustomFont) stays in settings.js since applyConfig/saveSettings own it.

import { invoke, state } from "../state.js";

const fontSelect = document.getElementById("setting-font");
const fontTrigger = fontSelect.querySelector(".custom-select-trigger");
const fontOptionsContainer = fontSelect.querySelector(".custom-select-options");

export { fontSelect };

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

export function rebuildFontDropdown() {
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
