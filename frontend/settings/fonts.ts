// Font dropdown (dynamic options) for the Reading tab.
//
// Split out of settings.js. Self-contained apart from `invoke`/`state`: it
// owns the #setting-font custom-select, builds its options from the built-in
// list + state.customFonts, and handles per-font removal. settings.js imports
// `fontSelect` (to read/write the selected value) and `rebuildFontDropdown`
// (to repopulate on open / reset / import). The actual @font-face loading
// (loadCustomFont) stays in settings.js since applyConfig/saveSettings own it.

import { invoke, state } from "../core/state.ts";
import { wireCustomSelect } from "./controls.ts";

const fontSelect = document.getElementById("setting-font");
const fontTrigger = fontSelect.querySelector(".custom-select-trigger");
const fontOptionsContainer = fontSelect.querySelector(".custom-select-options");

export { fontSelect };

// Trigger click + keyboard nav over the dynamic option list.
wireCustomSelect(fontSelect as HTMLElement);

// Override the value getter/setter for the font select to work with dynamic options
Object.defineProperty(fontSelect, "value", {
  get() {
    return fontSelect.dataset.value || "";
  },
  set(v) {
    fontSelect.dataset.value = v;
    const opts = fontSelect.querySelectorAll(".custom-select-option") as NodeListOf<HTMLElement>;
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
    .forEach((o: Element) => {
      const el = o as HTMLElement;
      el.classList.toggle("selected", el.dataset.value === current);
    });
}

// Event delegation for font dropdown clicks
fontOptionsContainer.addEventListener("click", async (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  const removeBtn = target.closest(".custom-font-remove");
  if (removeBtn) {
    e.stopPropagation();
    const opt = removeBtn.closest(".custom-select-option") as HTMLElement;
    const label = opt.querySelector(".custom-font-label");
    const fontName = label ? label.textContent : "this font";
    if (!confirm(`Remove "${fontName}"? The font file will be deleted.`))
      return;
    const filename = opt.dataset.value.slice(7); // strip "custom:"
    await invoke("remove_font", { filename });
    state.customFonts = await invoke("list_custom_fonts");
    // If the removed font was selected, fall back to system-ui
    if (fontSelect.dataset.value === opt.dataset.value) {
      (fontSelect as any).value = "system-ui";
    }
    if (state.activeFontFilename === filename) state.activeFontFilename = null;
    rebuildFontDropdown();
    return;
  }

  const opt = target.closest(".custom-select-option") as HTMLElement;
  if (!opt) return;

  // Normal font selection
  (fontSelect as any).value = opt.dataset.value;
  fontSelect.classList.remove("open");
  fontTrigger.setAttribute("aria-expanded", "false");
});
