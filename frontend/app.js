// Tauri v2 API (available via withGlobalTauri: true)
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const appWindow = getCurrentWindow();

// ── Platform detection ────────────────────────────────────────────────────
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
const modKey = isMac ? 'Cmd' : 'Ctrl';

// ── Tab state ──────────────────────────────────────────────────────────────
// Each tab: { id, path, title, html, scrollTop }
let tabs = [];
let activeTabId = null;
let nextTabId = 1;

// ── Global state ───────────────────────────────────────────────────────────
let config = null;
let searchMatches = [];
let searchCurrent = -1;
let searchCaseSensitive = false;
let originalContent = '';

// ── DOM refs ───────────────────────────────────────────────────────────────
const tabBarEl        = document.getElementById('tab-area');
const contentEl       = document.getElementById('content');
const contentScroll   = document.getElementById('content-scroll');
const btnOpen         = document.getElementById('btn-open');
const btnClose        = document.getElementById('btn-close');
const btnReload       = document.getElementById('btn-reload');
const btnSearch       = document.getElementById('btn-search');
const btnSettings     = document.getElementById('btn-settings');
const btnMinimize     = document.getElementById('btn-minimize');
const btnMaximize     = document.getElementById('btn-maximize');
const btnWinClose     = document.getElementById('btn-winclose');
const filePathEl      = document.getElementById('file-path');
const statusIndicator = document.getElementById('status-indicator');
const statusText      = document.getElementById('status-text');
const btnZoomOut      = document.getElementById('btn-zoom-out');
const btnZoomIn       = document.getElementById('btn-zoom-in');
const zoomLabel       = document.getElementById('zoom-label');
const searchBar       = document.getElementById('search-bar');
const searchInput     = document.getElementById('search-input');
const searchCase      = document.getElementById('search-case');
const searchPrev      = document.getElementById('search-prev');
const searchNext      = document.getElementById('search-next');
const searchClose     = document.getElementById('search-close');
const searchCount     = document.getElementById('search-count');
const settingsOverlay = document.getElementById('settings-overlay');
const pickerBackdrop  = document.getElementById('picker-backdrop');

const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 2.0;
const ZOOM_STEP = 0.1;
const ZOOM_DEFAULT = 1.0;

// Capture the welcome screen HTML from the initial DOM (index.html) before
// any content is loaded, so showWelcome() can restore the full styled version.
const WELCOME_HTML = contentEl.innerHTML;

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  config = await invoke('get_config');
  applyConfig(config);

  // Open a file passed as a CLI argument (no timing hack needed)
  const cliFile = await invoke('get_cli_file');
  if (cliFile) loadFile(cliFile);

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(saveGeometry, 600);
  });

  await appWindow.onDragDropEvent((e) => {
    if (e.payload.type === 'drop') {
      const mdExtensions = /\.(md|markdown|mdown|mkd)$/i;
      for (const path of e.payload.paths) {
        if (mdExtensions.test(path)) loadFile(path);
      }
    }
  });
}

// ── Config / theme ─────────────────────────────────────────────────────────
const systemDarkMQ = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedTheme(theme) {
  if (theme !== 'system') return theme;
  return systemDarkMQ.matches ? 'dark' : 'light';
}

function applyConfig(cfg) {
  document.body.className = `theme-${resolvedTheme(cfg.theme)}`;
  document.body.style.setProperty('--font-family', `"${cfg.font_family}", sans-serif`);
  document.body.style.setProperty('--font-size', `${cfg.font_size}px`);
  document.body.style.setProperty('--h1-color', cfg.h1_color);
  document.body.style.setProperty('--h2-color', cfg.h2_color);
  document.body.style.setProperty('--h3-color', cfg.h3_color);
  document.body.style.setProperty('--bullet-color', cfg.bullet_color);
}

// Live update when the OS switches dark/light while theme is set to 'system'
systemDarkMQ.addEventListener('change', () => {
  if (config?.theme === 'system') applyConfig(config);
});

// ── Window geometry ────────────────────────────────────────────────────────
async function saveGeometry() {
  try {
    const maximized = await appWindow.isMaximized();
    if (maximized) {
      await invoke('save_window_geometry', { width: config.window_width, height: config.window_height, maximized: true });
    } else {
      const size = await appWindow.outerSize();
      await invoke('save_window_geometry', { width: size.width, height: size.height, maximized: false });
    }
  } catch {}
}

// ── Toolbar state ──────────────────────────────────────────────────────────
function syncToolbar() {
  const hasTab = activeTabId !== null;
  btnClose.disabled  = !hasTab;
  btnReload.disabled = !hasTab;
  btnSearch.disabled = !hasTab;
}

// ── Tab management ─────────────────────────────────────────────────────────
function activeTab() {
  return tabs.find(t => t.id === activeTabId) ?? null;
}

function openInNewTab(path, title, html) {
  // Switch to existing tab if this path is already open
  if (path) {
    const existing = tabs.find(t => t.path === path);
    if (existing) {
      switchToTab(existing.id);
      return;
    }
  }
  const id = nextTabId++;
  tabs.push({ id, path, title, html, scrollTop: 0, zoom: ZOOM_DEFAULT });
  activeTabId = id;
  syncToolbar();
  renderTabBar();
  applyActiveTab();
}

function switchToTab(id) {
  // Save scroll position of current tab before leaving
  const cur = activeTab();
  if (cur) cur.scrollTop = contentScroll.scrollTop;

  activeTabId = id;
  clearSearch();
  renderTabBar();
  applyActiveTab();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;

  // Save scroll before closing if it's active
  if (id === activeTabId) {
    tabs[idx].scrollTop = contentScroll.scrollTop;
  }

  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    activeTabId = null;
    clearSearch();
    syncToolbar();
    renderTabBar();
    showWelcome();
  } else if (id === activeTabId) {
    activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
    clearSearch();
    syncToolbar();
    renderTabBar();
    applyActiveTab();
  } else {
    renderTabBar();
  }
}

function applyActiveTab() {
  const tab = activeTab();
  if (!tab) { showWelcome(); return; }

  contentEl.innerHTML = tab.html;
  originalContent = tab.html;
  wireLinks();
  appWindow.setTitle(tab.title);
  document.title = tab.title;
  filePathEl.textContent = tab.path || '';
  filePathEl.title = tab.path || '';
  applyZoom(tab.zoom);

  // Restore scroll position after layout
  requestAnimationFrame(() => {
    contentScroll.scrollTop = tab.scrollTop;
  });
}

function showWelcome() {
  contentEl.innerHTML = WELCOME_HTML;
  // Re-patch the welcome hint for the correct modifier key (WELCOME_HTML
  // was captured before applyPlatformLabels ran, so it always says "Ctrl").
  const hintEl = contentEl.querySelector('.welcome-hint');
  if (hintEl) {
    hintEl.innerHTML = `<kbd>${modKey}+O</kbd> to open &nbsp;&middot;&nbsp; or drag a <kbd>.md</kbd> file here`;
  }
  contentEl.style.fontSize = '';
  originalContent = '';
  appWindow.setTitle('OxideMD');
  document.title = 'OxideMD';
  filePathEl.textContent = '';
  filePathEl.title = '';
  zoomLabel.textContent = '100%';
  btnZoomIn.disabled = false;
  btnZoomOut.disabled = false;
  clearStatus();
}

// ── Zoom ───────────────────────────────────────────────────────────────────
function applyZoom(zoom) {
  contentEl.style.fontSize = `calc(var(--font-size) * ${zoom.toFixed(2)})`;
  contentEl.style.maxWidth = `${Math.round(800 * zoom)}px`;
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  btnZoomOut.disabled = zoom <= ZOOM_MIN;
  btnZoomIn.disabled  = zoom >= ZOOM_MAX;
}

function zoomIn() {
  const tab = activeTab();
  if (!tab) return;
  tab.zoom = Math.min(ZOOM_MAX, parseFloat((tab.zoom + ZOOM_STEP).toFixed(2)));
  applyZoom(tab.zoom);
}

function zoomOut() {
  const tab = activeTab();
  if (!tab) return;
  tab.zoom = Math.max(ZOOM_MIN, parseFloat((tab.zoom - ZOOM_STEP).toFixed(2)));
  applyZoom(tab.zoom);
}

function resetZoom() {
  const tab = activeTab();
  if (!tab) return;
  tab.zoom = ZOOM_DEFAULT;
  applyZoom(tab.zoom);
}

function renderTabBar() {
  tabBarEl.innerHTML = '';

  if (tabs.length === 0) return;

  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title';
    titleSpan.textContent = tab.title;
    titleSpan.title = tab.path || tab.title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
    closeBtn.title = `Close (${modKey}+W)`;

    el.appendChild(titleSpan);
    el.appendChild(closeBtn);
    tabBarEl.appendChild(el);

    el.addEventListener('click', (e) => {
      if (!e.target.closest('.tab-close')) switchToTab(tab.id);
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
  }

  // Scroll active tab into view
  const activeEl = tabBarEl.querySelector('.tab.active');
  if (activeEl) activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// ── File loading ───────────────────────────────────────────────────────────
async function loadFile(path) {
  setLoading();
  try {
    const result = await invoke('open_file', { path });
    openInNewTab(path, result.title, result.html);
  } catch (e) {
    showError(String(e));
  } finally {
    clearStatus();
  }
}

async function reloadFile() {
  const tab = activeTab();
  if (!tab?.path) return;
  setLoading();
  try {
    const result = await invoke('open_file', { path: tab.path });
    tab.html = result.html;
    tab.title = result.title;
    applyActiveTab();
    renderTabBar();
  } catch (e) {
    showError(String(e));
  } finally {
    clearStatus();
  }
}

function showError(msg) {
  const p = document.createElement('p');
  p.style.cssText = 'color:#e06c75;margin-top:2em;font-family:monospace;';
  p.textContent = 'Error: ' + msg;
  contentEl.replaceChildren(p);
}

function setLoading() {
  statusText.textContent = 'Loading';
  statusIndicator.classList.remove('hidden');
  statusIndicator.classList.add('status-loading');
}

function setReady() {
  statusText.textContent = 'Ready';
  statusIndicator.classList.remove('hidden', 'status-loading');
}

function clearStatus() {
  if (tabs.length === 0) {
    statusIndicator.classList.add('hidden');
    statusIndicator.classList.remove('status-loading');
  } else {
    setReady();
  }
}

// ── Link handling ──────────────────────────────────────────────────────────
function wireLinks() {
  contentEl.querySelectorAll('a').forEach(a => a.addEventListener('click', handleLinkClick));
}

async function handleLinkClick(e) {
  e.preventDefault();
  const href = e.currentTarget.getAttribute('href') || '';
  if (href.startsWith('#')) {
    const target = document.getElementById(href.slice(1));
    if (target) target.scrollIntoView({ behavior: 'smooth' });
  } else if (href) {
    try { await invoke('open_url', { url: href }); } catch {}
  }
}

// ── Overlay exclusivity ────────────────────────────────────────────────────
// Only one overlay (file picker, search, settings) can be open at a time.
let filePickerOpen = false;
function hasActiveOverlay() {
  return filePickerOpen
    || !searchBar.classList.contains('hidden')
    || !settingsOverlay.classList.contains('hidden');
}

// ── Open dialog ────────────────────────────────────────────────────────────
async function openFilePicker() {
  if (hasActiveOverlay()) return;
  filePickerOpen = true;
  pickerBackdrop.classList.remove('hidden');
  try {
    const paths = await invoke('pick_file');
    for (const path of paths) await loadFile(path);
  } catch {} finally {
    pickerBackdrop.classList.add('hidden');
    filePickerOpen = false;
  }
}

// ── Search ─────────────────────────────────────────────────────────────────
function toggleSearch() {
  if (!searchBar.classList.contains('hidden')) { closeSearch(); return; }
  if (hasActiveOverlay()) return;
  searchBar.classList.remove('hidden');
  btnSearch.classList.add('active');
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchBar.classList.add('hidden');
  btnSearch.classList.remove('active');
  clearSearch();
  searchInput.value = '';
  searchCaseSensitive = false;
  searchCase.classList.remove('active');
  searchCase.setAttribute('aria-pressed', 'false');
}

function clearSearch() {
  if (originalContent) {
    contentEl.innerHTML = originalContent;
    wireLinks();
  }
  searchMatches = [];
  searchCurrent = -1;
  searchCount.textContent = '';
}

function runSearch(query) {
  if (originalContent) {
    contentEl.innerHTML = originalContent;
    wireLinks();
  }
  searchMatches = [];
  searchCurrent = -1;

  if (!query) { searchCount.textContent = ''; return; }

  const needle = searchCaseSensitive ? query : query.toLowerCase();
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.parentElement.closest('pre')) textNodes.push(node);
  }

  for (const tn of textNodes) {
    const text = tn.nodeValue;
    const haystack = searchCaseSensitive ? text : text.toLowerCase();
    let idx = 0;
    let found = false;
    const frag = document.createDocumentFragment();

    while (idx < text.length) {
      const pos = haystack.indexOf(needle, idx);
      if (pos === -1) { frag.appendChild(document.createTextNode(text.slice(idx))); break; }
      found = true;
      if (pos > idx) frag.appendChild(document.createTextNode(text.slice(idx, pos)));
      const mark = document.createElement('mark');
      mark.className = 'search-match';
      mark.textContent = text.slice(pos, pos + query.length);
      searchMatches.push(mark);
      frag.appendChild(mark);
      idx = pos + query.length;
    }

    if (found) tn.parentNode.replaceChild(frag, tn);
  }

  if (searchMatches.length > 0) { searchCurrent = 0; highlightCurrent(); }
  updateSearchCount();
}

function highlightCurrent() {
  searchMatches.forEach((m, i) => m.classList.toggle('current', i === searchCurrent));
  if (searchCurrent >= 0 && searchMatches[searchCurrent]) {
    searchMatches[searchCurrent].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function nextMatch() {
  if (!searchMatches.length) return;
  searchCurrent = (searchCurrent + 1) % searchMatches.length;
  highlightCurrent();
  updateSearchCount();
}

function prevMatch() {
  if (!searchMatches.length) return;
  searchCurrent = (searchCurrent - 1 + searchMatches.length) % searchMatches.length;
  highlightCurrent();
  updateSearchCount();
}

function updateSearchCount() {
  searchCount.textContent = searchMatches.length
    ? `${searchCurrent + 1} / ${searchMatches.length}`
    : (searchInput.value ? 'No matches' : '');
}

// ── Custom selects ─────────────────────────────────────────────────────────
document.querySelectorAll('.custom-select').forEach(sel => {
  const trigger = sel.querySelector('.custom-select-trigger');
  const options = sel.querySelectorAll('.custom-select-option');

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

  trigger.addEventListener('click', () => {
    // Close any other open selects
    document.querySelectorAll('.custom-select.open').forEach(s => { if (s !== sel) s.classList.remove('open'); });
    sel.classList.toggle('open');
  });

  options.forEach(opt => {
    opt.addEventListener('click', () => {
      sel.value = opt.dataset.value;
      sel.classList.remove('open');
    });
  });
});

// Close custom selects when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.custom-select')) {
    document.querySelectorAll('.custom-select.open').forEach(s => s.classList.remove('open'));
  }
});

// ── Custom number inputs ───────────────────────────────────────────────────
document.querySelectorAll('.custom-number').forEach(num => {
  const display = num.querySelector('.custom-number-value');
  const min = 8, max = 48, step = 1;

  Object.defineProperty(num, 'value', {
    get() { return parseInt(num.dataset.value, 10) || min; },
    set(v) {
      const clamped = Math.min(max, Math.max(min, parseInt(v, 10) || min));
      num.dataset.value = clamped;
      display.textContent = clamped;
    }
  });

  num.querySelector('.decrement').addEventListener('click', () => { num.value = num.value - step; });
  num.querySelector('.increment').addEventListener('click', () => { num.value = num.value + step; });
});

// ── Settings ───────────────────────────────────────────────────────────────
function openSettings() {
  if (hasActiveOverlay()) return;
  document.getElementById('setting-theme').value  = config.theme;
  document.getElementById('setting-font').value   = config.font_family;
  document.getElementById('setting-size').value   = config.font_size;
  document.getElementById('setting-h1').value     = config.h1_color;
  document.getElementById('setting-h2').value     = config.h2_color;
  document.getElementById('setting-h3').value     = config.h3_color;
  document.getElementById('setting-bullet').value = config.bullet_color;
  settingsOverlay.classList.remove('hidden');
}

function closeSettings() { settingsOverlay.classList.add('hidden'); }

async function saveSettings() {
  const newConfig = {
    ...config,
    theme:        document.getElementById('setting-theme').value,
    font_family:  document.getElementById('setting-font').value,
    font_size:    parseInt(document.getElementById('setting-size').value, 10),
    h1_color:     document.getElementById('setting-h1').value,
    h2_color:     document.getElementById('setting-h2').value,
    h3_color:     document.getElementById('setting-h3').value,
    bullet_color: document.getElementById('setting-bullet').value,
  };
  setLoading();
  try {
    await invoke('save_config_cmd', { config: newConfig });
    config = newConfig;
    applyConfig(config);
    closeSettings();
  } catch (e) {
    alert('Failed to save settings: ' + e);
  } finally {
    clearStatus();
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
}

btnMinimize.addEventListener('click', () => appWindow.minimize());
btnMaximize.addEventListener('click', async () => { await appWindow.toggleMaximize(); syncMaximizeIcon(); });
btnWinClose.addEventListener('click', () => appWindow.close());
appWindow.onResized(syncMaximizeIcon);

btnOpen.addEventListener('click', openFilePicker);
btnClose.addEventListener('click', () => { if (activeTabId !== null) closeTab(activeTabId); });
btnReload.addEventListener('click', reloadFile);
btnSearch.addEventListener('click', toggleSearch);
btnSettings.addEventListener('click', openSettings);
btnZoomOut.addEventListener('click', zoomOut);
btnZoomIn.addEventListener('click', zoomIn);
zoomLabel.addEventListener('click', resetZoom);

searchCase.addEventListener('click', () => {
  searchCaseSensitive = !searchCaseSensitive;
  searchCase.classList.toggle('active', searchCaseSensitive);
  searchCase.setAttribute('aria-pressed', searchCaseSensitive);
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
document.getElementById('settings-save').addEventListener('click', saveSettings);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });

// ── Global keyboard shortcuts ──────────────────────────────────────────────
// Accept both Ctrl and Cmd (metaKey) so shortcuts work on macOS
function hasMod(e) { return e.ctrlKey || e.metaKey; }

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
      const idx = tabs.findIndex(t => t.id === activeTabId);
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
      const idx = tabs.findIndex(t => t.id === activeTabId);
      const target = (idx - 1 + tabs.length) % tabs.length;
      [tabs[idx], tabs[target]] = [tabs[target], tabs[idx]];
      renderTabBar();
    }
    return;
  }
  if (hasMod(e) && e.shiftKey && e.key === 'ArrowRight') {
    e.preventDefault();
    if (tabs.length > 1) {
      const idx = tabs.findIndex(t => t.id === activeTabId);
      const target = (idx + 1) % tabs.length;
      [tabs[idx], tabs[target]] = [tabs[target], tabs[idx]];
      renderTabBar();
    }
    return;
  }
  if (hasMod(e) && e.key === 'w') {
    e.preventDefault();
    if (activeTabId !== null) closeTab(activeTabId);
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
    const idx = tabs.findIndex(t => t.id === activeTabId);
    const prev = (idx - 1 + tabs.length) % tabs.length;
    switchToTab(tabs[prev].id);
  }
});

listen('next-tab', () => {
  if (tabs.length > 1) {
    const idx = tabs.findIndex(t => t.id === activeTabId);
    const next = (idx + 1) % tabs.length;
    switchToTab(tabs[next].id);
  }
});

listen('move-tab-left', () => {
  if (tabs.length > 1) {
    const idx = tabs.findIndex(t => t.id === activeTabId);
    const target = (idx - 1 + tabs.length) % tabs.length;
    [tabs[idx], tabs[target]] = [tabs[target], tabs[idx]];
    renderTabBar();
  }
});

listen('move-tab-right', () => {
  if (tabs.length > 1) {
    const idx = tabs.findIndex(t => t.id === activeTabId);
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

  // Welcome hint
  const hintEl = document.querySelector('.welcome-hint');
  if (hintEl) {
    hintEl.innerHTML = `<kbd>${modKey}+O</kbd> to open &nbsp;&middot;&nbsp; or drag a <kbd>.md</kbd> file here`;
  }
}

applyPlatformLabels();

// ── Start ──────────────────────────────────────────────────────────────────
init();
