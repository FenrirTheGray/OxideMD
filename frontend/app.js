import {
  invoke, listen, appWindow,
  isMac, modKey, isMarkdownPath, hasMod,
  tabs, state,
  systemDarkMQ,
  tabBarEl, contentEl, contentScroll,
  btnOpen, btnOpenFolder, btnClose, btnReload, btnSearch, btnSettings,
  btnMinimize, btnMaximize, btnWinClose,
  filePathEl, statusIndicator, statusText,
  btnZoomOut, btnZoomIn, zoomLabel,
  searchBar, searchInput, searchCase, searchPrev, searchNext, searchClose,
  settingsOverlay,
  sidebarCloseBtn,
  hasActiveOverlay,
} from './state.js';
import {
  toggleSearch, closeSearch, clearSearch, runSearch, nextMatch, prevMatch,
} from './search.js';
import {
  openFolder, setFolder, closeFolder,
  handleFsChange,
} from './folder.js';
import {
  syncToolbar, activeTab, openInNewTab, switchToTab, closeTab,
  applyActiveTab, showWelcome, applyZoom, zoomIn, zoomOut, resetZoom,
  renderTabBar, updateTabOverflow,
  loadFile, reloadFile, handleAnchorClick, openFilePicker,
  setLoading, clearStatus,
} from './tabs.js';

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  state.config = await invoke('get_config');
  state.customFonts = await invoke('list_custom_fonts');
  if (state.config.font_family.startsWith('custom:')) {
    await loadCustomFont(state.config.font_family.slice(7));
  }
  applyConfig(state.config);

  // Open every file passed on the command line (Explorer "Open with…" can
  // pass multiple paths in a single launch).
  const cliFiles = await invoke('get_cli_files');
  for (const path of cliFiles) {
    if (isMarkdownPath(path)) await loadFile(path);
  }

  // A second instance of OxideMD was started (e.g. user double-clicked
  // another .md file in the OS); the backend forwards those paths here.
  await listen('open-files-from-instance', (e) => {
    const paths = Array.isArray(e.payload) ? e.payload : [];
    for (const path of paths) {
      if (isMarkdownPath(path)) loadFile(path);
    }
  });

  // Filesystem changes in any watched file/folder. The Rust watcher may
  // fire several events per save (editors write+truncate+rename); coalesce
  // them into a single reload per path.
  await listen('fs-changed', (e) => {
    if (typeof e.payload === 'string') handleFsChange(e.payload);
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { saveGeometry(); updateTabOverflow(); }, 600);
  });

  await appWindow.onDragDropEvent((e) => {
    if (e.payload.type === 'drop') {
      for (const path of e.payload.paths) {
        if (isMarkdownPath(path)) loadFile(path);
      }
    }
  });

  syncMaximizeIcon();
}

// ── Config / theme ─────────────────────────────────────────────────────────
function resolvedTheme(theme) {
  if (theme !== 'system') return theme;
  return systemDarkMQ.matches ? 'dark' : 'light';
}

async function loadCustomFont(filename) {
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

function applyConfig(cfg) {
  document.body.className = `theme-${resolvedTheme(cfg.theme)}`;
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
}

// Live update when the OS switches dark/light while theme is set to 'system'
systemDarkMQ.addEventListener('change', () => {
  if (state.config?.theme === 'system') applyConfig(state.config);
});

// ── Window geometry ────────────────────────────────────────────────────────
async function saveGeometry() {
  try {
    const maximized = await appWindow.isMaximized();
    if (maximized) {
      await invoke('save_window_geometry', { width: state.config.window_width, height: state.config.window_height, maximized: true });
    } else {
      const size = await appWindow.outerSize();
      await invoke('save_window_geometry', { width: size.width, height: size.height, maximized: false });
    }
  } catch {}
}

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
      sel.dataset.value = v;
      const match = sel.querySelector(`.custom-select-option[data-value="${CSS.escape(v)}"]`);
      trigger.textContent = match ? match.textContent : v;
      options.forEach(o => o.classList.toggle('selected', o.dataset.value === v));
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

function openSettings() {
  if (hasActiveOverlay()) return;
  hideUpdateStatus();
  window.__TAURI__.app.getVersion().then(v => {
    document.getElementById('settings-version').textContent = 'v' + v;
  });
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
  updatePreviewColors();
  activateSettingsTab('reading');
  settingsOverlay.classList.remove('hidden');
  state.releaseFocusTrap = trapFocus(document.getElementById('settings-dialog'));
}

function activateSettingsTab(name) {
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
  const keys = ['h1', 'h2', 'h3', 'bullet'];
  keys.forEach(k => {
    const v = document.getElementById(`setting-${k}`).value;
    body.setProperty(`--preview-${k}`, v);
    const hex = document.getElementById(`setting-${k}-hex`);
    if (hex) hex.textContent = v.toLowerCase();
  });
}

function closeSettings() {
  if (state.releaseFocusTrap) { state.releaseFocusTrap(); state.releaseFocusTrap = null; }
  if (settingsOverlay.classList.contains('hidden') || settingsOverlay.classList.contains('closing')) return;
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
  };
  setLoading();
  try {
    await invoke('save_config_cmd', { config: newConfig });
    if (newConfig.font_family.startsWith('custom:')) {
      await loadCustomFont(newConfig.font_family.slice(7));
    }
    state.config = newConfig;
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
  } else if (activeTabName === 'colors') {
    document.getElementById('setting-theme').value  = defaults.theme;
    document.getElementById('setting-h1').value     = defaults.h1_color;
    document.getElementById('setting-h2').value     = defaults.h2_color;
    document.getElementById('setting-h3').value     = defaults.h3_color;
    document.getElementById('setting-bullet').value = defaults.bullet_color;
    updatePreviewColors();
  }
}

// ── Event wiring ───────────────────────────────────────────────────────────
// ── Window controls ────────────────────────────────────────────────────────
const ICON_MAXIMIZE = `<rect x="4" y="4" width="16" height="16" rx="1"/>`;
const ICON_RESTORE  = `<rect x="2" y="6" width="14" height="14" rx="1"/><polyline points="6 6 6 2 22 2 22 16 18 16"/>`;

async function syncMaximizeIcon() {
  const isMax = await appWindow.isMaximized();
  btnMaximize.querySelector('svg').innerHTML = isMax ? ICON_RESTORE : ICON_MAXIMIZE;
  btnMaximize.title = isMax ? 'Restore' : 'Maximize';
  document.body.classList.toggle('maximized', isMax);
}

btnMinimize.addEventListener('click', () => appWindow.minimize());
btnMaximize.addEventListener('click', async () => { await appWindow.toggleMaximize(); syncMaximizeIcon(); });
btnWinClose.addEventListener('click', () => appWindow.close());
appWindow.onResized(syncMaximizeIcon);

btnOpen.addEventListener('click', openFilePicker);
btnOpenFolder.addEventListener('click', openFolder);
sidebarCloseBtn.addEventListener('click', closeFolder);

// Click the file path in the status bar to copy it to the clipboard.
filePathEl.addEventListener('click', async () => {
  const path = filePathEl.title;
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    return;
  }
  filePathEl.classList.add('copied');
  const originalText = path;
  filePathEl.textContent = 'Copied!';
  clearTimeout(state.copyResetTimer);
  state.copyResetTimer = setTimeout(() => {
    filePathEl.classList.remove('copied');
    filePathEl.textContent = originalText;
  }, 1200);
});
filePathEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (!filePathEl.classList.contains('clickable')) return;
  e.preventDefault();
  filePathEl.click();
});
// Delegated handler for clickable children of contentEl: the welcome button
// (re-created every time showWelcome() rewrites innerHTML) and every rendered
// anchor (re-created on every tab switch / search render). A single listener
// survives all DOM replacements inside contentEl.
contentEl.addEventListener('click', (e) => {
  if (e.target.closest('#welcome-open')) { openFilePicker(); return; }
  const anchor = e.target.closest('a');
  if (anchor && contentEl.contains(anchor)) {
    e.preventDefault();
    handleAnchorClick(anchor);
  }
});
btnClose.addEventListener('click', () => { if (state.activeTabId !== null) closeTab(state.activeTabId); });
btnReload.addEventListener('click', reloadFile);
btnSearch.addEventListener('click', toggleSearch);
btnSettings.addEventListener('click', openSettings);
btnZoomOut.addEventListener('click', zoomOut);
btnZoomIn.addEventListener('click', zoomIn);
zoomLabel.addEventListener('click', resetZoom);

searchCase.addEventListener('click', () => {
  state.searchCaseSensitive = !state.searchCaseSensitive;
  searchCase.classList.toggle('active', state.searchCaseSensitive);
  searchCase.setAttribute('aria-pressed', state.searchCaseSensitive);
  runSearch(searchInput.value);
});

let searchDebounceTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => runSearch(searchInput.value), 40);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.shiftKey ? prevMatch() : nextMatch(); e.preventDefault(); }
  if (e.key === 'Escape') { closeSearch(); e.preventDefault(); }
});
searchPrev.addEventListener('click', prevMatch);
searchNext.addEventListener('click', nextMatch);
searchClose.addEventListener('click', closeSearch);

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
['setting-h1', 'setting-h2', 'setting-h3', 'setting-bullet'].forEach(id => {
  document.getElementById(id).addEventListener('input', updatePreviewColors);
});

// About panel external link
document.querySelectorAll('.about-link[data-url]').forEach(a => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    invoke('open_url', { url: a.dataset.url });
  });
});

// ── Global keyboard shortcuts ──────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (hasMod(e) && e.key === 'f') { e.preventDefault(); toggleSearch(); return; }
  if (hasMod(e) && e.key === 'o') { e.preventDefault(); openFilePicker(); return; }
  if (hasMod(e) && e.key === 'r') { e.preventDefault(); reloadFile(); return; }
  if (hasMod(e) && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomIn();    return; }
  if (hasMod(e) && e.key === '-')                    { e.preventDefault(); zoomOut();   return; }
  if (hasMod(e) && e.key === '0')                    { e.preventDefault(); resetZoom(); return; }
  if (hasMod(e) && e.key === 'Tab') {
    e.preventDefault();
    if (tabs.length > 1) {
      const idx = tabs.findIndex(t => t.id === state.activeTabId);
      const next = e.shiftKey
        ? (idx - 1 + tabs.length) % tabs.length
        : (idx + 1) % tabs.length;
      switchToTab(tabs[next].id);
    }
    return;
  }
  if (hasMod(e) && e.shiftKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    if (tabs.length > 1) {
      const idx = tabs.findIndex(t => t.id === state.activeTabId);
      const target = (idx - 1 + tabs.length) % tabs.length;
      [tabs[idx], tabs[target]] = [tabs[target], tabs[idx]];
      renderTabBar();
    }
    return;
  }
  if (hasMod(e) && e.shiftKey && e.key === 'ArrowRight') {
    e.preventDefault();
    if (tabs.length > 1) {
      const idx = tabs.findIndex(t => t.id === state.activeTabId);
      const target = (idx + 1) % tabs.length;
      [tabs[idx], tabs[target]] = [tabs[target], tabs[idx]];
      renderTabBar();
    }
    return;
  }
  if (hasMod(e) && e.key === 'w') {
    e.preventDefault();
    if (state.activeTabId !== null) closeTab(state.activeTabId);
    return;
  }
  if (e.key === 'Escape') {
    if (!settingsOverlay.classList.contains('hidden')) { closeSettings(); return; }
    if (!searchBar.classList.contains('hidden'))       { closeSearch();   return; }
  }
  if (e.key === 'Home' && document.activeElement === document.body) {
    contentScroll.scrollTop = 0;
  }
});

// Some key combos are intercepted by WebKitGTK before JS sees them,
// so the Rust side registers hidden menu accelerators and emits events.
listen('prev-tab', () => {
  if (tabs.length > 1) {
    const idx = tabs.findIndex(t => t.id === state.activeTabId);
    const prev = (idx - 1 + tabs.length) % tabs.length;
    switchToTab(tabs[prev].id);
  }
});

listen('next-tab', () => {
  if (tabs.length > 1) {
    const idx = tabs.findIndex(t => t.id === state.activeTabId);
    const next = (idx + 1) % tabs.length;
    switchToTab(tabs[next].id);
  }
});

listen('move-tab-left', () => {
  if (tabs.length > 1) {
    const idx = tabs.findIndex(t => t.id === state.activeTabId);
    const target = (idx - 1 + tabs.length) % tabs.length;
    [tabs[idx], tabs[target]] = [tabs[target], tabs[idx]];
    renderTabBar();
  }
});

listen('move-tab-right', () => {
  if (tabs.length > 1) {
    const idx = tabs.findIndex(t => t.id === state.activeTabId);
    const target = (idx + 1) % tabs.length;
    [tabs[idx], tabs[target]] = [tabs[target], tabs[idx]];
    renderTabBar();
  }
});

// Prevent browser default drag-drop navigation
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// ── Platform-aware UI labels ──────────────────────────────────────────────
// Update tooltips and hints to show Cmd on macOS, Ctrl elsewhere
function applyPlatformLabels() {
  btnOpen.title       = `Open file (${modKey}+O)`;
  btnReload.title     = `Reload file (${modKey}+R)`;
  btnClose.title      = `Close tab (${modKey}+W)`;
  btnSearch.title     = `Search (${modKey}+F)`;
  btnZoomOut.title    = `Zoom out (${modKey}+-)`;
  btnZoomIn.title     = `Zoom in (${modKey}++)`;
  zoomLabel.title     = `Reset zoom (${modKey}+0)`;

  // Tab close buttons
  const tabCloses = tabBarEl.querySelectorAll('.tab-close');
  tabCloses.forEach(b => b.title = `Close (${modKey}+W)`);

  // Welcome screen: swap Ctrl → Cmd on macOS
  document.querySelectorAll('#welcome kbd.mod-key').forEach(k => {
    k.textContent = modKey;
  });
}

applyPlatformLabels();

// ── Start ──────────────────────────────────────────────────────────────────
init();
