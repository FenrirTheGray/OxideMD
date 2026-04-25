import {
  invoke, state, systemDarkMQ, isLinux,
  statusText, statusIndicator, settingsOverlay, searchBar,
  hasActiveOverlay,
} from './state.js';
import { activeTab, applyZoom, setLoading, clearStatus } from './tabs.js';
import { closeSearch } from './search.js';
import {
  ACTIONS, effectiveBindings, findActionByAccel, eventToAccel,
  accelToTokens, canonicalizeAccel, MODIFIER_ONLY_KEYS,
} from './keybindings.js';
import { renderShortcutsUI } from './shortcuts-display.js';

// ── Config / theme ─────────────────────────────────────────────────────────
function resolvedTheme(theme) {
  if (theme !== 'system') return theme;
  return systemDarkMQ.matches ? 'dark' : 'light';
}

// Code/note backgrounds are the only colors where the dark defaults
// produce dark-on-dark text in light mode (text uses --fg, which is
// dark in light theme). Headings and accents read fine on either
// background, so they stay theme-agnostic.
const BG_DEFAULTS = {
  dark:  { code_bg_color: '#1e2127', note_bg_color: '#2a2f3a' },
  light: { code_bg_color: '#f0f0f0', note_bg_color: '#eaeef8' },
};

// If the saved value matches the *other* theme's default, swap to the
// resolved theme's default. Custom user picks pass through unchanged.
// Edge case: a user who deliberately chose the other theme's default
// hex sees it auto-swap on theme flip — accepted to avoid carrying a
// "this is custom" flag through the data model.
function effectiveBgColor(savedValue, field, resolved) {
  const other = resolved === 'dark' ? 'light' : 'dark';
  const lower = (savedValue || '').toLowerCase();
  if (lower === BG_DEFAULTS[other][field].toLowerCase()) {
    return BG_DEFAULTS[resolved][field];
  }
  return savedValue;
}

export async function loadCustomFont(filename) {
  if (state.activeFontFilename === filename) return;
  try {
    const b64 = await invoke('get_font_data', { filename });
    const ext = filename.split('.').pop().toLowerCase();
    const format = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[ext] || 'truetype';
    if (!state.fontStyleEl) {
      state.fontStyleEl = document.createElement('style');
      document.head.appendChild(state.fontStyleEl);
    }
    state.fontStyleEl.textContent = `@font-face { font-family: "OxideMD-Custom"; src: url("data:font/${ext};base64,${b64}") format("${format}"); }`;
    state.activeFontFilename = filename;
  } catch (err) {
    state.activeFontFilename = null;
    statusText.textContent = `Font error: ${err}`;
    statusIndicator.classList.remove('hidden', 'status-loading');
    setTimeout(clearStatus, 4000);
  }
}

export function applyConfig(cfg) {
  const resolved = resolvedTheme(cfg.theme);
  document.body.className = `theme-${resolved}`;
  if (cfg.font_family.startsWith('custom:')) {
    const filename = cfg.font_family.slice(7);
    if (state.activeFontFilename !== filename) loadCustomFont(filename);
    document.body.style.setProperty('--font-family', '"OxideMD-Custom", sans-serif');
  } else {
    document.body.style.setProperty('--font-family', `"${cfg.font_family}", sans-serif`);
  }
  document.body.style.setProperty('--font-size', `${cfg.font_size}px`);
  document.body.style.setProperty('--content-line-height', cfg.line_height);
  document.body.style.setProperty('--reading-width', `${cfg.reading_width}px`);
  document.body.style.setProperty('--h1-color', cfg.h1_color);
  document.body.style.setProperty('--h2-color', cfg.h2_color);
  document.body.style.setProperty('--h3-color', cfg.h3_color);
  document.body.style.setProperty('--bullet-color', cfg.bullet_color);
  document.body.style.setProperty('--code-bg', effectiveBgColor(cfg.code_bg_color, 'code_bg_color', resolved));
  document.body.style.setProperty('--code-accent', cfg.code_accent_color);
  document.body.style.setProperty('--note-bg', effectiveBgColor(cfg.note_bg_color, 'note_bg_color', resolved));
  document.body.style.setProperty('--note-accent', cfg.note_accent_color);
  document.body.style.setProperty('--sidebar-width', `${cfg.sidebar_width}px`);
  document.getElementById('toolbar-buttons').classList.toggle('compact', !!cfg.toolbar_compact);
}

// Live update when the OS switches dark/light while theme is set to 'system'
systemDarkMQ.addEventListener('change', () => {
  if (state.config?.theme === 'system') applyConfig(state.config);
});

// ── Custom selects ─────────────────────────────────────────────────────────
// The font select is managed separately (dynamic options), so skip it here.
document.querySelectorAll('.custom-select').forEach(sel => {
  if (sel.id === 'setting-font') return;
  const trigger = sel.querySelector('.custom-select-trigger');
  const options = sel.querySelectorAll('.custom-select-option');
  let focusedIndex = -1;

  // Expose .value getter/setter so existing code works unchanged
  Object.defineProperty(sel, 'value', {
    get() { return sel.dataset.value || ''; },
    set(v) {
      const old = sel.dataset.value;
      sel.dataset.value = v;
      const match = sel.querySelector(`.custom-select-option[data-value="${CSS.escape(v)}"]`);
      trigger.textContent = match ? match.textContent : v;
      options.forEach(o => o.classList.toggle('selected', o.dataset.value === v));
      if (old !== v) sel.dispatchEvent(new Event('change'));
    }
  });

  function openSelect() {
    document.querySelectorAll('.custom-select.open').forEach(s => { if (s !== sel) closeSelect(s); });
    sel.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    // Focus the currently selected option
    focusedIndex = Array.from(options).findIndex(o => o.classList.contains('selected'));
    if (focusedIndex === -1) focusedIndex = 0;
    updateOptionFocus();
  }

  function closeSelect(s) {
    s = s || sel;
    s.classList.remove('open');
    s.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false');
    s.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('focused'));
  }

  function updateOptionFocus() {
    options.forEach((o, i) => o.classList.toggle('focused', i === focusedIndex));
    if (focusedIndex >= 0) options[focusedIndex].scrollIntoView({ block: 'nearest' });
  }

  function selectFocused() {
    if (focusedIndex >= 0 && options[focusedIndex]) {
      sel.value = options[focusedIndex].dataset.value;
    }
    closeSelect();
    trigger.focus();
  }

  trigger.addEventListener('click', () => {
    if (sel.classList.contains('open')) closeSelect();
    else openSelect();
  });

  // Keyboard support
  trigger.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (sel.classList.contains('open')) selectFocused();
        else openSelect();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!sel.classList.contains('open')) { openSelect(); break; }
        focusedIndex = Math.min(focusedIndex + 1, options.length - 1);
        updateOptionFocus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!sel.classList.contains('open')) { openSelect(); break; }
        focusedIndex = Math.max(focusedIndex - 1, 0);
        updateOptionFocus();
        break;
      case 'Escape':
        if (sel.classList.contains('open')) { e.preventDefault(); e.stopPropagation(); closeSelect(); trigger.focus(); }
        break;
      case 'Tab':
        if (sel.classList.contains('open')) closeSelect();
        break;
    }
  });

  options.forEach(opt => {
    opt.addEventListener('click', () => {
      sel.value = opt.dataset.value;
      closeSelect();
      trigger.focus();
    });
  });
});

// ── Font dropdown (dynamic) ───────────────────────────────────────────────
const fontSelect = document.getElementById('setting-font');
const fontTrigger = fontSelect.querySelector('.custom-select-trigger');
const fontOptionsContainer = fontSelect.querySelector('.custom-select-options');

// ── Font select open/close/keyboard ───────────────────────────────────────
function openFontSelect() {
  document.querySelectorAll('.custom-select.open').forEach(s => {
    s.classList.remove('open');
    s.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false');
  });
  fontSelect.classList.add('open');
  fontTrigger.setAttribute('aria-expanded', 'true');
}

function closeFontSelect() {
  fontSelect.classList.remove('open');
  fontTrigger.setAttribute('aria-expanded', 'false');
  fontOptionsContainer.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('focused'));
}

fontTrigger.addEventListener('click', () => {
  if (fontSelect.classList.contains('open')) closeFontSelect();
  else openFontSelect();
});

fontTrigger.addEventListener('keydown', (e) => {
  const opts = Array.from(fontOptionsContainer.querySelectorAll('.custom-select-option'));
  let focusedIdx = opts.findIndex(o => o.classList.contains('focused'));

  switch (e.key) {
    case 'Enter': case ' ':
      e.preventDefault();
      if (fontSelect.classList.contains('open') && focusedIdx >= 0) {
        opts[focusedIdx].click();
      } else {
        openFontSelect();
      }
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (!fontSelect.classList.contains('open')) { openFontSelect(); break; }
      focusedIdx = Math.min(focusedIdx + 1, opts.length - 1);
      opts.forEach((o, i) => o.classList.toggle('focused', i === focusedIdx));
      if (opts[focusedIdx]) opts[focusedIdx].scrollIntoView({ block: 'nearest' });
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (!fontSelect.classList.contains('open')) { openFontSelect(); break; }
      focusedIdx = Math.max(focusedIdx - 1, 0);
      opts.forEach((o, i) => o.classList.toggle('focused', i === focusedIdx));
      if (opts[focusedIdx]) opts[focusedIdx].scrollIntoView({ block: 'nearest' });
      break;
    case 'Escape':
      if (fontSelect.classList.contains('open')) { e.preventDefault(); e.stopPropagation(); closeFontSelect(); fontTrigger.focus(); }
      break;
    case 'Tab':
      if (fontSelect.classList.contains('open')) closeFontSelect();
      break;
  }
});

// Override the value getter/setter for the font select to work with dynamic options
Object.defineProperty(fontSelect, 'value', {
  get() { return fontSelect.dataset.value || ''; },
  set(v) {
    fontSelect.dataset.value = v;
    const opts = fontSelect.querySelectorAll('.custom-select-option');
    const match = fontSelect.querySelector(`.custom-select-option[data-value="${CSS.escape(v)}"]`);
    if (match) {
      // Use the label span text for custom fonts, or full text for built-in
      const label = match.querySelector('.custom-font-label');
      fontTrigger.textContent = label ? label.textContent : match.textContent;
    } else {
      fontTrigger.textContent = v;
    }
    opts.forEach(o => o.classList.toggle('selected', o.dataset.value === v));
  }
});

const BUILTIN_FONTS = [
  { value: 'system-ui',                label: 'System Default' },
  { value: 'Georgia',                  label: 'Georgia' },
  { value: 'Consolas, monospace',      label: 'Consolas' },
  { value: 'Arial',                    label: 'Arial' },
  { value: 'Verdana',                  label: 'Verdana' },
  { value: 'Times New Roman, serif',   label: 'Times New Roman' },
];

function rebuildFontDropdown() {
  fontOptionsContainer.innerHTML = '';

  // Built-in fonts
  for (const f of BUILTIN_FONTS) {
    const opt = document.createElement('div');
    opt.className = 'custom-select-option';
    opt.dataset.value = f.value;
    opt.setAttribute('role', 'option');
    opt.textContent = f.label;
    fontOptionsContainer.appendChild(opt);
  }

  // Custom fonts
  const sep = document.createElement('div');
  sep.className = 'font-options-sep';
  fontOptionsContainer.appendChild(sep);

  if (state.customFonts.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'font-empty-hint';
    hint.textContent = 'No custom fonts installed';
    fontOptionsContainer.appendChild(hint);
  } else {
    for (const f of state.customFonts) {
      const opt = document.createElement('div');
      opt.className = 'custom-select-option custom-font-option';
      opt.dataset.value = `custom:${f.filename}`;
      opt.setAttribute('role', 'option');

      const label = document.createElement('span');
      label.className = 'custom-font-label';
      label.textContent = f.name;
      opt.appendChild(label);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'custom-font-remove';
      removeBtn.setAttribute('aria-label', `Remove ${f.name}`);
      removeBtn.title = `Remove ${f.name}`;
      removeBtn.innerHTML = '&#x2715;';
      opt.appendChild(removeBtn);

      fontOptionsContainer.appendChild(opt);
    }
  }

  // "Add font…" action
  const sep2 = document.createElement('div');
  sep2.className = 'font-options-sep';
  fontOptionsContainer.appendChild(sep2);

  const addOpt = document.createElement('div');
  addOpt.className = 'custom-select-option font-add-option';
  addOpt.dataset.value = '__add_font__';
  addOpt.setAttribute('role', 'option');
  addOpt.textContent = 'Add font\u2026';
  fontOptionsContainer.appendChild(addOpt);

  // Re-highlight current selection
  const current = fontSelect.dataset.value || '';
  fontOptionsContainer.querySelectorAll('.custom-select-option').forEach(o => {
    o.classList.toggle('selected', o.dataset.value === current);
  });
}

// Event delegation for font dropdown clicks
fontOptionsContainer.addEventListener('click', async (e) => {
  const removeBtn = e.target.closest('.custom-font-remove');
  if (removeBtn) {
    e.stopPropagation();
    const opt = removeBtn.closest('.custom-select-option');
    const label = opt.querySelector('.custom-font-label');
    const fontName = label ? label.textContent : 'this font';
    if (!confirm(`Remove "${fontName}"? The font file will be deleted.`)) return;
    const filename = opt.dataset.value.slice(7); // strip "custom:"
    await invoke('remove_font', { filename });
    state.customFonts = await invoke('list_custom_fonts');
    // If the removed font was selected, fall back to system-ui
    if (fontSelect.dataset.value === opt.dataset.value) {
      fontSelect.value = 'system-ui';
    }
    if (state.activeFontFilename === filename) state.activeFontFilename = null;
    rebuildFontDropdown();
    return;
  }

  const opt = e.target.closest('.custom-select-option');
  if (!opt) return;

  if (opt.dataset.value === '__add_font__') {
    e.stopPropagation();
    // Close dropdown, open file picker
    fontSelect.classList.remove('open');
    fontTrigger.setAttribute('aria-expanded', 'false');
    const result = await invoke('install_font');
    if (result) {
      state.customFonts = await invoke('list_custom_fonts');
      rebuildFontDropdown();
      fontSelect.value = `custom:${result.filename}`;
    }
    return;
  }

  // Normal font selection
  fontSelect.value = opt.dataset.value;
  fontSelect.classList.remove('open');
  fontTrigger.setAttribute('aria-expanded', 'false');
});

// Close custom selects when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.custom-select')) {
    document.querySelectorAll('.custom-select.open').forEach(s => {
      s.classList.remove('open');
      s.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false');
    });
  }
});

// ── Segmented controls ─────────────────────────────────────────────────────
// Two-button pill with data-value on each segment; exposes a .value
// getter/setter like the custom-select above so settings save/load code
// can treat it as a regular form control.
document.querySelectorAll('.segmented').forEach(seg => {
  const btns = Array.from(seg.querySelectorAll('button[data-value]'));

  Object.defineProperty(seg, 'value', {
    get() { return seg.dataset.value ?? ''; },
    set(v) {
      const str = String(v);
      seg.dataset.value = str;
      btns.forEach(b => {
        const on = b.dataset.value === str;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
  });

  btns.forEach(btn => {
    btn.addEventListener('click', () => { seg.value = btn.dataset.value; });
  });
});

// ── Custom number inputs ───────────────────────────────────────────────────
document.querySelectorAll('.custom-number').forEach(num => {
  const display  = num.querySelector('.custom-number-value');
  const min      = parseFloat(num.dataset.min  ?? '8');
  const max      = parseFloat(num.dataset.max  ?? '48');
  const step     = parseFloat(num.dataset.step ?? '1');
  const decimals = parseInt(num.dataset.decimals ?? '0', 10);
  const suffix   = num.dataset.suffix ?? '';

  const quantize = v => {
    const steps = Math.round((v - min) / step);
    return parseFloat((min + steps * step).toFixed(decimals + 6));
  };
  const format = v => v.toFixed(decimals) + suffix;

  Object.defineProperty(num, 'value', {
    get() { return parseFloat(num.dataset.value) || min; },
    set(v) {
      const parsed = parseFloat(v);
      const clamped = Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : min));
      const snapped = quantize(clamped);
      num.dataset.value = snapped;
      display.textContent = format(snapped);
    }
  });

  num.querySelector('.decrement').addEventListener('click', () => { num.value = num.value - step; });
  num.querySelector('.increment').addEventListener('click', () => { num.value = num.value + step; });
});

// ── Focus trap ─────────────────────────────────────────────────────────────
function trapFocus(container) {
  const focusableSelector = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

  function handler(e) {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(container.querySelectorAll(focusableSelector)).filter(el => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  container.addEventListener('keydown', handler);
  // Focus first focusable element
  const first = container.querySelector(focusableSelector);
  if (first) first.focus();

  return () => container.removeEventListener('keydown', handler);
}

// ── Shortcuts panel ────────────────────────────────────────────────────────
// Working copy of user overrides, mutated while the Shortcuts tab is open.
// Commits to state.config on Save; discarded on Cancel. Sparse map keyed
// by action id — missing entries fall back to the registry default.
let pendingOverrides = null;
let capturingId = null;

const shortcutsList = document.getElementById('shortcuts-list');
const shortcutsConflict = document.getElementById('shortcuts-conflict');
const RESET_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>';

function showShortcutConflict(msg) {
  shortcutsConflict.textContent = msg;
  shortcutsConflict.classList.remove('hidden');
}
function hideShortcutConflict() {
  shortcutsConflict.textContent = '';
  shortcutsConflict.classList.add('hidden');
}
function formatAccelForDisplay(accel) {
  if (!accel) return 'Not assigned';
  return accelToTokens(accel).join(' ');
}

function renderShortcutsPanel() {
  hideShortcutConflict();
  shortcutsList.innerHTML = '';
  const effective = effectiveBindings(pendingOverrides);

  // Group by category preserving registry order.
  const groups = [];
  const seen = new Map();
  for (const a of ACTIONS) {
    let g = seen.get(a.category);
    if (!g) { g = { name: a.category, actions: [] }; seen.set(a.category, g); groups.push(g); }
    g.actions.push(a);
  }

  for (const g of groups) {
    const title = document.createElement('div');
    title.className = 'shortcut-group-title';
    title.textContent = g.name;
    shortcutsList.appendChild(title);

    for (const a of g.actions) {
      const locked = isLinux && a.rebindableOnLinux === false;

      const row = document.createElement('div');
      row.className = 'shortcut-edit-row' + (locked ? ' locked' : '');
      row.dataset.actionId = a.id;

      const label = document.createElement('div');
      label.className = 'shortcut-edit-label';
      label.textContent = a.label;
      if (locked) {
        const note = document.createElement('span');
        note.className = 'shortcut-edit-label-note';
        note.textContent = 'Fixed on Linux (handled by the window system)';
        label.appendChild(note);
      }
      row.appendChild(label);

      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'shortcut-edit-pill';
      pill.textContent = formatAccelForDisplay(effective[a.id]?.primary || '');
      pill.setAttribute('aria-label', `Change shortcut for ${a.label}`);
      if (locked) pill.disabled = true;
      row.appendChild(pill);

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'shortcut-edit-reset';
      reset.setAttribute('aria-label', `Reset shortcut for ${a.label}`);
      reset.title = 'Reset to default';
      reset.innerHTML = RESET_ICON_SVG;
      const overridden = pendingOverrides
        && Object.prototype.hasOwnProperty.call(pendingOverrides, a.id);
      reset.disabled = !overridden || locked;
      row.appendChild(reset);

      shortcutsList.appendChild(row);

      if (locked) continue;

      pill.addEventListener('click', () => startShortcutCapture(a.id, pill));
      reset.addEventListener('click', () => {
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
  pill.classList.add('capturing');
  pill.textContent = 'Press new shortcut\u2026';
  hideShortcutConflict();
  pill.focus();
}

function endShortcutCapture() {
  if (!capturingId) return;
  const row = shortcutsList.querySelector(
    `.shortcut-edit-row[data-action-id="${CSS.escape(capturingId)}"]`);
  row?.querySelector('.shortcut-edit-pill')?.classList.remove('capturing');
  capturingId = null;
}

// Capture-phase so we absorb keydowns before the global dispatcher —
// otherwise trying to bind Mod+S would save the file mid-capture.
document.addEventListener('keydown', (e) => {
  if (!capturingId) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') { endShortcutCapture(); renderShortcutsPanel(); return; }
  if (MODIFIER_ONLY_KEYS.has(e.key)) return;

  const accel = eventToAccel(e);
  if (!accel) return;

  const action = ACTIONS.find(a => a.id === capturingId);
  if (!action) return;

  const effective = effectiveBindings(pendingOverrides);
  const conflictId = findActionByAccel(effective, accel, capturingId);
  if (conflictId) {
    const other = ACTIONS.find(a => a.id === conflictId);
    showShortcutConflict(
      `${accelToTokens(accel).join(' ')} is already assigned to "${other?.label || conflictId}". Reset that shortcut first or pick another combo.`
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
}, true);

// ── Settings ───────────────────────────────────────────────────────────────
const UPDATE_ICON_AVAILABLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>';
const UPDATE_ICON_CURRENT   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const UPDATE_ICON_ERROR     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

function showUpdateStatus(kind, html) {
  const el = document.getElementById('update-status');
  el.className = `update-status ${kind}`;
  el.innerHTML = html;
  void el.offsetWidth; // restart animation
  el.classList.remove('hidden');
}

function hideUpdateStatus() {
  const el = document.getElementById('update-status');
  el.classList.add('hidden');
  el.innerHTML = '';
}

async function checkForUpdates() {
  const btn = document.getElementById('btn-check-updates');
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56"/><polyline points="21 3 21 9 15 9"/></svg>Checking\u2026';
  hideUpdateStatus();
  try {
    const result = await invoke('check_for_updates');
    if (result.available) {
      showUpdateStatus('available', `
        ${UPDATE_ICON_AVAILABLE}
        <span class="update-message">Update available: <span class="update-version">v${result.version}</span></span>
        <button type="button" class="update-download">Download</button>
      `);
      document.querySelector('#update-status .update-download').addEventListener('click', () => {
        invoke('open_url', { url: 'https://github.com/FenrirTheGray/OxideMD/releases/latest' });
      });
    } else {
      showUpdateStatus('current', `${UPDATE_ICON_CURRENT}<span class="update-message">You are running the latest version.</span>`);
    }
  } catch (e) {
    showUpdateStatus('error', `${UPDATE_ICON_ERROR}<span class="update-message">Failed to check for updates: ${String(e).replace(/</g, '&lt;')}</span>`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}

// Suppress the theme-select change handler while openSettings is
// populating inputs programmatically — otherwise the first setter
// would flip body class and swap bg inputs before they're populated.
let populatingSettings = false;

export function openSettings() {
  // Close the search bar first so Settings can open over it.
  if (!searchBar.classList.contains('hidden')) closeSearch();
  if (hasActiveOverlay()) return;
  hideUpdateStatus();
  window.__TAURI__.app.getVersion().then(v => {
    document.getElementById('settings-version').textContent = 'v' + v;
  });
  populatingSettings = true;
  const resolved = resolvedTheme(state.config.theme);
  document.getElementById('setting-theme').value         = state.config.theme;
  rebuildFontDropdown();
  fontSelect.value = state.config.font_family;
  document.getElementById('setting-size').value          = state.config.font_size;
  document.getElementById('setting-line-height').value   = state.config.line_height;
  document.getElementById('setting-reading-width').value = state.config.reading_width;
  document.getElementById('setting-h1').value            = state.config.h1_color;
  document.getElementById('setting-h2').value            = state.config.h2_color;
  document.getElementById('setting-h3').value            = state.config.h3_color;
  document.getElementById('setting-bullet').value        = state.config.bullet_color;
  document.getElementById('setting-code-bg').value       = effectiveBgColor(state.config.code_bg_color, 'code_bg_color', resolved);
  document.getElementById('setting-code-accent').value   = state.config.code_accent_color;
  document.getElementById('setting-note-bg').value       = effectiveBgColor(state.config.note_bg_color, 'note_bg_color', resolved);
  document.getElementById('setting-note-accent').value   = state.config.note_accent_color;
  document.getElementById('setting-toolbar-compact').value = state.config.toolbar_compact ? 'true' : 'false';
  populatingSettings = false;
  updatePreviewColors();
  // Seed the shortcuts working copy from the saved overrides so edits are
  // only committed on Save. Plain object, not state.config.keybindings
  // itself, so cancel leaves state untouched.
  pendingOverrides = Object.assign(Object.create(null), state.config.keybindings || {});
  renderShortcutsPanel();
  activateSettingsTab('reading');
  settingsOverlay.classList.remove('hidden');
  state.releaseFocusTrap = trapFocus(document.getElementById('settings-dialog'));
}

function activateSettingsTab(name) {
  // Leaving the Shortcuts panel must cancel any in-progress capture so a
  // stray keypress in another panel doesn't get intercepted.
  if (name !== 'shortcuts') endShortcutCapture();
  const tabs = document.querySelectorAll('.settings-tab');
  const panels = document.querySelectorAll('.settings-panel');
  tabs.forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
  });
  panels.forEach(p => {
    const on = p.id === `settings-panel-${name}`;
    p.classList.toggle('active', on);
    p.hidden = !on;
  });
  document.getElementById('settings-dialog').classList.toggle('on-about', name === 'about');
}

function updatePreviewColors() {
  const body = document.body.style;
  const keys = ['h1', 'h2', 'h3', 'bullet', 'code-bg', 'code-accent', 'note-bg', 'note-accent'];
  keys.forEach(k => {
    const v = document.getElementById(`setting-${k}`).value;
    body.setProperty(`--preview-${k}`, v);
    const hex = document.getElementById(`setting-${k}-hex`);
    if (hex) hex.textContent = v.toLowerCase();
  });
}

export function closeSettings() {
  endShortcutCapture();
  if (state.releaseFocusTrap) { state.releaseFocusTrap(); state.releaseFocusTrap = null; }
  if (settingsOverlay.classList.contains('hidden') || settingsOverlay.classList.contains('closing')) return;
  // Revert any live theme-preview class change. If Save ran, state.config
  // already reflects the new theme so this is a no-op; on Cancel it
  // restores the original theme class.
  document.body.className = `theme-${resolvedTheme(state.config.theme)}`;
  settingsOverlay.classList.add('closing');
  settingsOverlay.addEventListener('animationend', () => {
    settingsOverlay.classList.add('hidden');
    settingsOverlay.classList.remove('closing');
  }, { once: true });
}

async function saveSettings() {
  const newConfig = {
    ...state.config,
    theme:          document.getElementById('setting-theme').value,
    font_family:    fontSelect.value,
    font_size:      parseInt(document.getElementById('setting-size').value, 10),
    line_height:    parseFloat(document.getElementById('setting-line-height').value),
    reading_width:  parseInt(document.getElementById('setting-reading-width').value, 10),
    h1_color:       document.getElementById('setting-h1').value,
    h2_color:       document.getElementById('setting-h2').value,
    h3_color:       document.getElementById('setting-h3').value,
    bullet_color:   document.getElementById('setting-bullet').value,
    code_bg_color:  document.getElementById('setting-code-bg').value,
    code_accent_color: document.getElementById('setting-code-accent').value,
    note_bg_color:  document.getElementById('setting-note-bg').value,
    note_accent_color: document.getElementById('setting-note-accent').value,
    toolbar_compact: document.getElementById('setting-toolbar-compact').value === 'true',
    keybindings: pendingOverrides ? { ...pendingOverrides } : {},
  };
  setLoading();
  try {
    await invoke('save_config_cmd', { config: newConfig });
    if (newConfig.font_family.startsWith('custom:')) {
      await loadCustomFont(newConfig.font_family.slice(7));
    }
    state.config = newConfig;
    state.bindings = effectiveBindings(newConfig.keybindings);
    renderShortcutsUI();
    applyConfig(state.config);
    const tab = activeTab();
    if (tab) applyZoom(tab.zoom);
    closeSettings();
  } catch (e) {
    alert('Failed to save settings: ' + e);
  } finally {
    clearStatus();
  }
}

async function resetSettings() {
  const defaults = await invoke('get_default_config');
  const activeTabName = document.querySelector('.settings-tab.active')?.dataset.tab;
  if (activeTabName === 'reading') {
    rebuildFontDropdown();
    fontSelect.value = defaults.font_family;
    document.getElementById('setting-size').value          = defaults.font_size;
    document.getElementById('setting-line-height').value   = defaults.line_height;
    document.getElementById('setting-reading-width').value = defaults.reading_width;
    document.getElementById('setting-toolbar-compact').value = defaults.toolbar_compact ? 'true' : 'false';
  } else if (activeTabName === 'colors') {
    document.getElementById('setting-theme').value  = defaults.theme;
    document.getElementById('setting-h1').value     = defaults.h1_color;
    document.getElementById('setting-h2').value     = defaults.h2_color;
    document.getElementById('setting-h3').value     = defaults.h3_color;
    document.getElementById('setting-bullet').value = defaults.bullet_color;
    // Bg defaults follow the currently-selected theme so Reset under
    // Light leaves readable light backgrounds rather than dark-on-dark.
    const resolved = resolvedTheme(document.getElementById('setting-theme').value);
    document.getElementById('setting-code-bg').value     = BG_DEFAULTS[resolved].code_bg_color;
    document.getElementById('setting-code-accent').value = defaults.code_accent_color;
    document.getElementById('setting-note-bg').value     = BG_DEFAULTS[resolved].note_bg_color;
    document.getElementById('setting-note-accent').value = defaults.note_accent_color;
    updatePreviewColors();
  } else if (activeTabName === 'shortcuts') {
    // Drop every override so every action falls back to its registry
    // default. Still a pending change until the user hits Save.
    pendingOverrides = Object.create(null);
    renderShortcutsPanel();
  }
}

// ── Settings event wiring ─────────────────────────────────────────────────
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-cancel').addEventListener('click', closeSettings);
document.getElementById('settings-reset').addEventListener('click', resetSettings);
document.getElementById('settings-save').addEventListener('click', saveSettings);
document.getElementById('btn-check-updates').addEventListener('click', checkForUpdates);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });

// Settings tab switching
const settingsTabButtons = Array.from(document.querySelectorAll('.settings-tab'));
settingsTabButtons.forEach(btn => {
  btn.addEventListener('click', () => activateSettingsTab(btn.dataset.tab));
});
document.getElementById('settings-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const idx = settingsTabButtons.findIndex(b => b.classList.contains('active'));
  if (idx === -1) return;
  e.preventDefault();
  const delta = e.key === 'ArrowRight' ? 1 : -1;
  const next = settingsTabButtons[(idx + delta + settingsTabButtons.length) % settingsTabButtons.length];
  activateSettingsTab(next.dataset.tab);
  next.focus();
});

// Live preview updates
['setting-h1', 'setting-h2', 'setting-h3', 'setting-bullet', 'setting-code-bg', 'setting-code-accent', 'setting-note-bg', 'setting-note-accent'].forEach(id => {
  document.getElementById(id).addEventListener('input', updatePreviewColors);
});

// Keep body class and bg defaults in sync with the in-flight theme
// pick so the preview's --fg contrast and the bg swatches match what
// the user will see after Save. closeSettings reverts the class if
// Save isn't clicked.
document.getElementById('setting-theme').addEventListener('change', () => {
  if (populatingSettings) return;
  const resolved = resolvedTheme(document.getElementById('setting-theme').value);
  document.body.className = `theme-${resolved}`;
  for (const field of ['code_bg_color', 'note_bg_color']) {
    const id = field === 'code_bg_color' ? 'setting-code-bg' : 'setting-note-bg';
    const input = document.getElementById(id);
    input.value = effectiveBgColor(input.value, field, resolved);
  }
  updatePreviewColors();
});

// About panel external link
document.querySelectorAll('.about-link[data-url]').forEach(a => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    invoke('open_url', { url: a.dataset.url });
  });
});
