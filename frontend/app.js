import {
  invoke, listen, appWindow,
  modKey, isMarkdownPath, hasMod,
  tabs, state,
  tabBarEl, contentEl, contentScroll,
  btnOpen, btnOpenFolder, btnClose, btnReload, btnSearch, btnSettings,
  btnMinimize, btnMaximize, btnWinClose,
  filePathEl,
  btnZoomOut, btnZoomIn, zoomLabel,
  searchBar, searchInput, searchCase, searchPrev, searchNext, searchClose,
  settingsOverlay,
  sidebarCloseBtn,
} from './state.js';
import {
  toggleSearch, closeSearch, runSearch, nextMatch, prevMatch,
} from './search.js';
import { openFolder, closeFolder, handleFsChange } from './folder.js';
import {
  switchToTab, closeTab,
  zoomIn, zoomOut, resetZoom,
  renderTabBar, updateTabOverflow,
  loadFile, reloadFile, handleAnchorClick, openFilePicker,
} from './tabs.js';
import { loadCustomFont, applyConfig, openSettings, closeSettings } from './settings.js';

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
