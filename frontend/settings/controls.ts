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
// Wire a custom-select's trigger: click to toggle, full keyboard nav
// (Enter/Space/Arrows/Esc/Tab). Options are read live from the DOM each
// event, so dynamically-populated dropdowns (font, theme) share this too.
// "Selecting" just clicks the focused option, reusing whatever click
// handler that option carries. Returns { open, close } for callers that
// need to dismiss the menu from elsewhere.
export function wireCustomSelect(sel: HTMLElement) {
  const trigger = sel.querySelector(".custom-select-trigger") as HTMLElement;
  const opts = () =>
    Array.from(sel.querySelectorAll(".custom-select-option")) as HTMLElement[];
  const isOpen = () => sel.classList.contains("open");

  function close() {
    sel.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    opts().forEach((o) => o.classList.remove("focused"));
  }
  function open() {
    document.querySelectorAll(".custom-select.open").forEach((s) => {
      if (s === sel) return;
      s.classList.remove("open");
      s.querySelector(".custom-select-trigger")!.setAttribute("aria-expanded", "false");
    });
    sel.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    focus(opts().findIndex((o) => o.classList.contains("selected")));
  }
  function focus(i: number) {
    const list = opts();
    if (!list.length) return;
    const clamped = Math.min(list.length - 1, Math.max(0, i));
    list.forEach((o, n) => o.classList.toggle("focused", n === clamped));
    list[clamped].scrollIntoView({ block: "nearest" });
  }

  trigger.addEventListener("click", () => (isOpen() ? close() : open()));
  trigger.addEventListener("keydown", (e: KeyboardEvent) => {
    const i = opts().findIndex((o) => o.classList.contains("focused"));
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        if (isOpen() && i >= 0) opts()[i].click();
        else open();
        break;
      case "ArrowDown":
        e.preventDefault();
        isOpen() ? focus(i + 1) : open();
        break;
      case "ArrowUp":
        e.preventDefault();
        isOpen() ? focus(i - 1) : open();
        break;
      case "Escape":
        if (isOpen()) { e.preventDefault(); e.stopPropagation(); close(); trigger.focus(); }
        break;
      case "Tab":
        if (isOpen()) close();
        break;
    }
  });
  return { open, close };
}

document.querySelectorAll(".custom-select").forEach((el) => {
  const sel = el as HTMLElement;
  if (sel.id === "setting-font" || sel.id === "setting-custom-theme") return;
  const trigger = sel.querySelector(".custom-select-trigger") as HTMLElement;
  const options = sel.querySelectorAll(".custom-select-option") as NodeListOf<HTMLElement>;

  // Expose .value getter/setter so existing code works unchanged
  Object.defineProperty(sel, "value", {
    get() {
      return sel.dataset.value || "";
    },
    set(v: string) {
      const old = sel.dataset.value;
      sel.dataset.value = v;
      const match = sel.querySelector(
        `.custom-select-option[data-value="${CSS.escape(v)}"]`,
      ) as HTMLElement | null;
      trigger.textContent = match ? match.textContent : v;
      options.forEach((o) =>
        o.classList.toggle("selected", o.dataset.value === v),
      );
      if (old !== v) sel.dispatchEvent(new Event("change"));
    },
  });

  const ctl = wireCustomSelect(sel);
  options.forEach((opt) => {
    opt.addEventListener("click", () => {
      (sel as any).value = opt.dataset.value;
      ctl.close();
      trigger.focus();
    });
  });
});

// Close custom selects when clicking outside (covers the dynamic font /
// custom-theme selects too, since it matches any open `.custom-select`).
document.addEventListener("click", (e: MouseEvent) => {
  if (!(e.target as HTMLElement).closest(".custom-select")) {
    document.querySelectorAll(".custom-select.open").forEach((s) => {
      s.classList.remove("open");
      s.querySelector(".custom-select-trigger")!.setAttribute(
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
document.querySelectorAll(".segmented").forEach((el) => {
  const seg = el as HTMLElement;
  const btns = Array.from(seg.querySelectorAll("button[data-value]")) as HTMLButtonElement[];

  Object.defineProperty(seg, "value", {
    get() {
      return seg.dataset.value ?? "";
    },
    set(v: string | number) {
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
      (seg as any).value = btn.dataset.value;
    });
  });
});

// ── Custom number inputs ───────────────────────────────────────────────────
document.querySelectorAll(".custom-number").forEach((el) => {
  const num = el as HTMLElement;
  const display = num.querySelector(".custom-number-value") as HTMLElement;
  const min = parseFloat(num.dataset.min ?? "8");
  const max = parseFloat(num.dataset.max ?? "48");
  const step = parseFloat(num.dataset.step ?? "1");
  const decimals = parseInt(num.dataset.decimals ?? "0", 10);
  const suffix = num.dataset.suffix ?? "";

  const quantize = (v: number) => {
    const steps = Math.round((v - min) / step);
    return parseFloat((min + steps * step).toFixed(decimals + 6));
  };
  const format = (v: number) => v.toFixed(decimals) + suffix;

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
      num.dataset.value = String(snapped);
      display.textContent = format(snapped);
    },
  });

  (num.querySelector(".decrement") as HTMLElement).addEventListener("click", () => {
    (num as any).value = (num as any).value - step;
  });
  (num.querySelector(".increment") as HTMLElement).addEventListener("click", () => {
    (num as any).value = (num as any).value + step;
  });
});

// ── Tags field (token editor) ───────────────────────────────────────────────
// The Markdown-extension editor: a list of removable chips (the current
// value) sitting above a dedicated input for adding more — the list and the
// input are separate elements. Exposes a `.value` array getter/setter so the
// settings save/load code treats it like the other custom controls. Each
// token is normalized (trimmed, de-dotted, lowercased) and validated, so a
// typo can't silently become an unmatchable "extension"; duplicates collapse.
// Adding or removing a chip dispatches a bubbling `change` event, which the
// dialog's delegated dirty-state listener picks up — while programmatic
// `.value` assignment (the populate/reset path) stays silent so the dialog
// doesn't look dirty on open.
const TAG_TOKEN_RE = /^[a-z0-9][a-z0-9+_-]*$/;

function normalizeTagToken(raw: unknown) {
  return String(raw ?? "")
    .trim()
    .replace(/^\.+/, "")
    .toLowerCase();
}

document.querySelectorAll(".tags-field").forEach((el) => {
  const box = el as HTMLElement;
  const list = box.querySelector(".tags-list") as HTMLElement;
  const field = box.querySelector(".tags-input") as HTMLInputElement;
  const addBtn = box.querySelector(".tags-add-btn") as HTMLButtonElement;
  const errorEl = box.querySelector(".tags-error") as HTMLElement | null;
  const errorTextEl = box.querySelector(".tags-error-text") as HTMLElement | null;
  let tokens: string[] = [];

  // The Add button only makes sense with something to add.
  function syncAddButton() {
    addBtn.disabled = !field.value.trim();
  }

  // Surface a rejection reason both visibly and to screen readers (the
  // `.tags-error` node is a role="alert" live region), and mark the field
  // invalid — so the feedback isn't carried by the shake/red border alone.
  // Only the text span is updated so the warning icon beside it survives;
  // the `is-visible` class shows/hides the whole row.
  function setError(msg: string) {
    if (errorTextEl) errorTextEl.textContent = msg || "";
    if (errorEl) errorEl.classList.toggle("is-visible", Boolean(msg));
    if (msg) field.setAttribute("aria-invalid", "true");
    else field.removeAttribute("aria-invalid");
  }

  function render() {
    list.replaceChildren();
    for (const tok of tokens) {
      const chip = document.createElement("li");
      chip.className = "chip";

      const label = document.createElement("span");
      label.className = "chip-label";
      label.textContent = tok;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-remove";
      remove.setAttribute("aria-label", `Remove ${tok}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        removeToken(tok);
        field.focus();
      });

      chip.append(label, remove);
      list.append(chip);
    }
    if (tokens.length === 0) {
      const hint = document.createElement("li");
      hint.className = "tags-empty-hint";
      hint.textContent = "No custom extensions — defaults will be used";
      list.append(hint);
    }
  }

  function commit(next: string[]) {
    const before = tokens.join(",");
    tokens = next;
    render();
    if (tokens.join(",") !== before) {
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function removeToken(tok: string) {
    if (tokens.includes(tok)) commit(tokens.filter((t) => t !== tok));
  }

  function flashInvalid() {
    field.classList.remove("tags-input-invalid");
    void field.offsetWidth; // restart the animation if it's mid-flight
    field.classList.add("tags-input-invalid");
  }
  field.addEventListener("animationend", () =>
    field.classList.remove("tags-input-invalid"),
  );

  // Pull every token out of the field — split on commas/whitespace so a
  // pasted "md, markdown" lands as two chips — add the valid ones, and
  // leave any rejected text behind for the user to fix.
  function commitInput({ flash }: { flash?: boolean } = {}) {
    const parts = field.value.split(/[\s,]+/).filter(Boolean);
    if (!parts.length) return;
    const next = [...tokens];
    const rejected = [];
    for (const part of parts) {
      const tok = normalizeTagToken(part);
      if (!tok) continue;
      if (!TAG_TOKEN_RE.test(tok)) {
        rejected.push(part);
        continue;
      }
      if (!next.includes(tok)) next.push(tok);
    }
    if (next.length !== tokens.length) commit(next);
    field.value = rejected.join(" ");
    syncAddButton();
    if (rejected.length && flash) {
      setError(
        `Use letters and numbers only — "${rejected.join(", ")}" not added`,
      );
      flashInvalid();
    } else {
      setError("");
    }
  }

  Object.defineProperty(box, "value", {
    get() {
      return [...tokens];
    },
    set(v) {
      const incoming = Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/);
      const seen = new Set<string>();
      const next: string[] = [];
      for (const item of incoming) {
        const tok = normalizeTagToken(item);
        if (tok && TAG_TOKEN_RE.test(tok) && !seen.has(tok)) {
          seen.add(tok);
          next.push(tok);
        }
      }
      tokens = next;
      render();
      // Populate/reset are clean-state loads, so drop any uncommitted or
      // rejected text left in the field from a previous session.
      field.value = "";
      syncAddButton();
      setError("");
    },
  });

  // Typing dismisses a stale rejection message and re-evaluates the button.
  field.addEventListener("input", () => {
    syncAddButton();
    setError("");
  });

  field.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitInput({ flash: true });
    } else if (e.key === "Backspace" && !field.value && tokens.length) {
      commit(tokens.slice(0, -1));
    }
  });

  // Adding is explicit — Enter, comma, or the Add button. Focus leaving the
  // field (clicking Save, another control, anywhere) does NOT commit, so a
  // half-typed token is never silently turned into an extension.
  addBtn.addEventListener("click", () => {
    commitInput({ flash: true });
    field.focus();
  });

  syncAddButton();
});
