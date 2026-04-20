import {
  invoke, listen, appWindow,
  isMarkdownPath, hasMod,
  tabs, state,
  contentEl, contentScroll, previewPane,
  btnOpen, btnOpenFolder, btnReload, btnSearch, btnSettings,
  btnModeToggle, btnSave,
  btnMinimize, btnMaximize, btnWinClose,
  filePathEl,
  btnZoomOut, btnZoomIn, zoomLabel,
  searchBar, searchInput, searchCase, searchPrev, searchNext, searchClose,
  settingsOverlay, btnLogo, shortcutsPopover,
  sidebarCloseBtn, sidebarExpandAllBtn, sidebarCollapseAllBtn,
  sidebarFilterInput, sidebarFilterClearBtn, sidebarTreeEl,
  confirmOverlay,
} from './state.js';
import { effectiveBindings, registerHandler, dispatchKey, runAction } from './keybindings.js';
import { renderShortcutsUI } from './shortcuts-display.js';
import {
  toggleSearch, closeSearch, runSearch, nextMatch, prevMatch,
} from './search.js';
import { openFolder, closeFolder, expandAllFolders, collapseAllFolders, setTreeFilter, clearTreeFilter, handleFsChange } from './folder.js';
import {
  switchToTab, closeTab,
  zoomIn, zoomOut, resetZoom,
  renderTabBar, updateTabOverflow,
  loadFile, reloadFile, handleAnchorClick, openFilePicker,
} from './tabs.js';
import { loadCustomFont, applyConfig, openSettings, closeSettings } from './settings.js';
import { enterEditMode, exitEditMode, saveActiveFile, tryOpenEditorSearch } from './editor.js';
import { activeTab } from './tabs.js';
import './contextmenu.js';
import './window-size.js';
import './outline.js';

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  state.config = await invoke('get_config');
  state.bindings = effectiveBindings(state.config.keybindings);
  renderShortcutsUI();
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

// ── Shortcuts popover (anchored to the logo) ──────────────────────────
// Opens on hover or click/focus. A small grace timer bridges the gap
// between the logo and the popover so the user can move from one to
// the other without the popover flickering shut.
let shortcutsHoverTimer = null;
let shortcutsPinned = false;   // latched open on click/focus-visible

function positionShortcutsPopover() {
  const rect = btnLogo.getBoundingClientRect();
  shortcutsPopover.style.top = `${Math.round(rect.bottom + 4)}px`;
  shortcutsPopover.style.left = `${Math.round(rect.left + 4)}px`;
}
function openShortcutsPopover() {
  positionShortcutsPopover();
  shortcutsPopover.classList.remove('hidden');
  shortcutsPopover.setAttribute('aria-hidden', 'false');
  btnLogo.setAttribute('aria-expanded', 'true');
}
function closeShortcutsPopover() {
  shortcutsPopover.classList.add('hidden');
  shortcutsPopover.setAttribute('aria-hidden', 'true');
  btnLogo.setAttribute('aria-expanded', 'false');
  shortcutsPinned = false;
}
function scheduleClose() {
  if (shortcutsPinned) return;
  clearTimeout(shortcutsHoverTimer);
  shortcutsHoverTimer = setTimeout(closeShortcutsPopover, 180);
}
function cancelScheduledClose() {
  clearTimeout(shortcutsHoverTimer);
}

btnLogo.addEventListener('mouseenter', () => { cancelScheduledClose(); openShortcutsPopover(); });
btnLogo.addEventListener('mouseleave', scheduleClose);
shortcutsPopover.addEventListener('mouseenter', cancelScheduledClose);
shortcutsPopover.addEventListener('mouseleave', scheduleClose);

btnLogo.addEventListener('click', (e) => {
  e.preventDefault();
  if (shortcutsPopover.classList.contains('hidden')) {
    openShortcutsPopover();
    shortcutsPinned = true;
  } else if (shortcutsPinned) {
    closeShortcutsPopover();
  } else {
    shortcutsPinned = true;
  }
});

// Click outside closes the pinned popover.
document.addEventListener('mousedown', (e) => {
  if (shortcutsPopover.classList.contains('hidden')) return;
  if (shortcutsPopover.contains(e.target) || btnLogo.contains(e.target)) return;
  closeShortcutsPopover();
});

// Keep popover anchored to the logo across window resizes (maximize,
// snap, manual resize). The listener is cheap and only reads/writes
// two style properties when the popover is open.
window.addEventListener('resize', () => {
  if (shortcutsPopover.classList.contains('hidden')) return;
  positionShortcutsPopover();
});

btnOpen.addEventListener('click', openFilePicker);
btnOpenFolder.addEventListener('click', openFolder);
sidebarCloseBtn.addEventListener('click', closeFolder);
sidebarExpandAllBtn.addEventListener('click', expandAllFolders);
sidebarCollapseAllBtn.addEventListener('click', collapseAllFolders);

let treeFilterTimer;
sidebarFilterInput.addEventListener('input', () => {
  clearTimeout(treeFilterTimer);
  const value = sidebarFilterInput.value;
  sidebarFilterClearBtn.classList.toggle('hidden', value === '');
  treeFilterTimer = setTimeout(() => setTreeFilter(value), 80);
});
sidebarFilterInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (sidebarFilterInput.value) {
      clearTreeFilter();
    } else {
      sidebarFilterInput.blur();
    }
  } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
    const firstRow = sidebarTreeEl.querySelector('.tree-row');
    if (firstRow) { e.preventDefault(); firstRow.focus(); }
  }
});
sidebarFilterClearBtn.addEventListener('click', () => {
  clearTreeFilter();
  sidebarFilterInput.focus();
});

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
  if (e.target.closest('#welcome-open-folder')) { openFolder(); return; }
  if (e.target.closest('#welcome-open'))        { openFilePicker(); return; }
  const anchor = e.target.closest('a');
  if (anchor && contentEl.contains(anchor)) {
    e.preventDefault();
    handleAnchorClick(anchor);
  }
});
// Same treatment for anchors inside the live preview pane — without this,
// clicking a link would let the webview navigate away and take the whole
// app with it.
if (previewPane) {
  previewPane.addEventListener('click', (e) => {
    const anchor = e.target.closest('a');
    if (anchor && previewPane.contains(anchor)) {
      e.preventDefault();
      handleAnchorClick(anchor);
    }
  });
}
btnReload.addEventListener('click', reloadFile);
btnSearch.addEventListener('click', toggleSearch);
btnSettings.addEventListener('click', openSettings);
btnModeToggle.addEventListener('click', () => {
  const tab = activeTab();
  if (!tab || !tab.path) return;
  if (tab.editing) exitEditMode(); else enterEditMode();
});
btnSave.addEventListener('click', saveActiveFile);
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

// ── Action handlers ───────────────────────────────────────────────────────
// Each handler wraps an action body with its preventDefault + any guards
// that determine whether the event is consumed. Dispatcher matches the
// accelerator; these functions own the semantics.

function shiftActiveTab(direction) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex(t => t.id === state.activeTabId);
  const target = (idx + direction + tabs.length) % tabs.length;
  [tabs[idx], tabs[target]] = [tabs[target], tabs[idx]];
  renderTabBar();
}

function switchTabBy(direction) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex(t => t.id === state.activeTabId);
  const next = (idx + direction + tabs.length) % tabs.length;
  switchToTab(tabs[next].id);
}

registerHandler('openFile',    (e) => { e?.preventDefault(); openFilePicker(); });
registerHandler('openFolder',  (e) => { e?.preventDefault(); openFolder(); });
registerHandler('closeFolder', (e) => {
  if (!state.currentFolder) return;   // no folder → let the key pass through
  e?.preventDefault();
  closeFolder();
});
registerHandler('save', (e) => {
  e?.preventDefault();
  const tab = activeTab();
  if (tab?.editing) saveActiveFile();
});
registerHandler('reload', (e) => { e?.preventDefault(); reloadFile(); });

registerHandler('toggleEdit', (e) => {
  e?.preventDefault();
  const tab = activeTab();
  if (!tab?.path) return;
  if (tab.editing) exitEditMode(); else enterEditMode();
});
registerHandler('toggleSearch', (e) => {
  e?.preventDefault();
  if (tryOpenEditorSearch()) return;
  toggleSearch();
});
registerHandler('zoomIn',    (e) => { e?.preventDefault(); zoomIn(); });
registerHandler('zoomOut',   (e) => { e?.preventDefault(); zoomOut(); });
registerHandler('zoomReset', (e) => { e?.preventDefault(); resetZoom(); });

registerHandler('nextTab',      (e) => { e?.preventDefault(); switchTabBy(+1); });
registerHandler('prevTab',      (e) => { e?.preventDefault(); switchTabBy(-1); });
registerHandler('moveTabLeft',  (e) => { e?.preventDefault(); shiftActiveTab(-1); });
registerHandler('moveTabRight', (e) => { e?.preventDefault(); shiftActiveTab(+1); });
registerHandler('closeTab', (e) => {
  e?.preventDefault();
  if (state.activeTabId !== null) closeTab(state.activeTabId);
});

// ── Global keyboard shortcuts ──────────────────────────────────────────────
// The registry (keybindings.js) owns the Mod+X actions. Escape/Home and the
// confirm-dialog guard live here because they're UI-state keys, not
// rebindable commands.
document.addEventListener('keydown', (e) => {
  // While the unsaved-changes confirm is up, let editor.js handle Enter/
  // Escape and swallow everything else. Otherwise Ctrl+S from within the
  // prompt would save, defeating the point of the "cancel" choice.
  if (state.confirmDialogOpen) return;

  if (e.key === 'Escape') {
    if (!confirmOverlay.classList.contains('hidden')) { /* handled in editor.js */ return; }
    if (!shortcutsPopover.classList.contains('hidden')) { closeShortcutsPopover(); btnLogo.focus(); return; }
    if (!settingsOverlay.classList.contains('hidden')) { closeSettings(); return; }
    if (!searchBar.classList.contains('hidden'))       { closeSearch();   return; }
    return;
  }
  if (e.key === 'Home' && document.activeElement === document.body) {
    contentScroll.scrollTop = 0;
    return;
  }

  dispatchKey(e, state.bindings, 'global');
});

// Some key combos are intercepted by WebKitGTK before JS sees them,
// so the Rust side registers hidden menu accelerators and emits events.
// These must call the same action handlers as the Ctrl+Tab path so a
// rebind of an adjacent action can't leave the GTK-intercepted default
// firing a stale implementation.
listen('prev-tab',       () => runAction('prevTab'));
listen('next-tab',       () => runAction('nextTab'));
listen('move-tab-left',  () => runAction('moveTabLeft'));
listen('move-tab-right', () => runAction('moveTabRight'));

// Prevent browser default drag-drop navigation
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Ctrl/Cmd + wheel → zoom the active tab. Must be non-passive so
// preventDefault suppresses the webview's default page-zoom behavior.
window.addEventListener('wheel', (e) => {
  if (!hasMod(e)) return;
  if (state.activeTabId === null) return;
  e.preventDefault();
  if (e.deltaY < 0) zoomIn(); else if (e.deltaY > 0) zoomOut();
}, { passive: false });

// ── Start ──────────────────────────────────────────────────────────────────
init();
