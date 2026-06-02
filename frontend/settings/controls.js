// Generic custom form controls for the Settings dialog: the custom-select
// dropdowns, the segmented (pill) toggles, and the custom-number steppers,
// plus the dialog focus trap.
//
// Split out of settings.js. Each initializer runs as an import-time side
// effect over the static markup in index.html and exposes a `.value`
// getter/setter on the element so the settings save/load code can treat
// these widgets like native form controls. The font and custom-theme
// selects have dynamic options and are managed in fonts.js / settings.js,
// so the generic custom-select loop skips them by id.

// ── Custom selects ─────────────────────────────────────────────────────────
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

// Close custom selects when clicking outside (covers the dynamic font /
// custom-theme selects too, since it matches any open `.custom-select`).
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
export function trapFocus(container) {
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
