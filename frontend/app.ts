// Installs window-level error / unhandled-rejection listeners that
// forward into tauri-plugin-log. Must come before any other import so
// errors thrown during the rest of the init sequence are captured.
import "./core/logger.js";
import { logError } from "./core/logger.ts";
import { showErrorModal } from "./ui/error-modal.ts";

import {
  invoke, listen, appWindow,
  isMarkdownPath, stripMarkdownExtension, hasMod,
  tabs, state,
  contentEl, contentScroll, previewPane,
  btnNew, btnOpen, btnOpenFolder, btnReload, btnSearch, btnSettings,
  btnPrint, btnModeToggle, btnSave,
  btnMinimize, btnMaximize, btnWinClose,
  filePathEl,
  btnZoomOut, btnZoomIn, zoomLabel,
  searchBar, searchInput, searchCase, searchPrev, searchNext, searchClose,
  searchReplaceInput, searchReplace, searchReplaceAll,
  settingsOverlay, btnLogo, shortcutsPopover,
  sidebarCloseBtn, sidebarExpandAllBtn, sidebarCollapseAllBtn,
  sidebarFilterToggle, sidebarFilterInput, sidebarFilterClearBtn, sidebarTreeEl,
  confirmOverlay,
} from "./core/state.ts";
import { effectiveBindings, registerHandler, dispatchKey, runAction } from "./core/keybindings.ts";
import { debounce } from "./lib/timing.ts";
import { renderShortcutsUI } from "./ui/shortcuts-display.ts";
import {
  toggleSearch, closeSearch, runSearch, nextMatch, prevMatch,
  replaceCurrent, replaceAllMatches,
} from "./features/search.ts";
import { openFolder, closeFolder, expandAllFolders, collapseAllFolders, setTreeFilter, clearTreeFilter, toggleFilterMode, closeFilterMode, handleFsChange, toggleSidebarDrawer, collapseSidebarDrawer } from "./ui/folder.ts";
import { openProjectSearch } from "./features/search-project.ts";
import {
  switchToTab, closeTab,
  zoomIn, zoomOut, resetZoom,
  renderTabBar,
  loadFile, reloadFile, handleAnchorClick, openFilePicker, createNewFile,
  applyRecentFiles,
} from "./ui/tabs.ts";
import { loadCustomFont, applyConfig, openSettings, closeSettings } from "./settings/index.ts";
// The editor module (and with it all of CodeMirror) loads lazily on the
// first action that needs it; see editor/lazy.ts. Sync call sites use
// editorModule()?. — a null module means no editor exists, so the no-op
// is the correct behavior.
import { editorModule, loadEditorModule } from "./editor/lazy.ts";
import { activeTab } from "./ui/tabs.ts";
import { printActiveTab } from "./features/print.ts";
import { showToast } from "./ui/toast.ts";
import "./ui/error-modal.ts";
import "./ui/contextmenu.js";
import "./ui/window-size.js";
import { applyOutlineVisibility, closeOutline } from "./ui/outline.ts";

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  // The three startup reads are independent — issue them concurrently so
  // first paint waits on one IPC round-trip, not three in sequence.
  const [config, customFonts, cliFiles] = await Promise.all([
    invoke('get_config'),
    invoke('list_custom_fonts'),
    invoke('get_cli_files'),
  ]);
  state.config = config;
  state.bindings = effectiveBindings(state.config.keybindings);
  renderShortcutsUI();
  state.customFonts = customFonts;
  if (state.config.font_family.startsWith('custom:')) {
    await loadCustomFont(state.config.font_family.slice(7));
  }
  applyConfig(state.config);
  // Restore the right-side outline sidebar's persisted open/closed state.
  applyOutlineVisibility();

  invoke('list_recent_files').then(applyRecentFiles).catch(() => {});

  // Open every file passed on the command line (Explorer "Open with…" can
  // pass multiple paths in a single launch).
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

  // The new instance that triggered the single-instance bounce stamped
  // a different version into `.running_version` than this still-running
  // process is on. That means an update was installed on disk but the
  // user is still seeing the old build — common after `dnf upgrade` /
  // `apt upgrade` / AppImage swap when the running app was never
  // closed. Longer-than-default lifetime so the notice doesn't blink past.
  await listen('version-mismatch', (e) => {
    const installed = typeof e.payload === 'string' ? e.payload : '';
    const msg = installed
      ? `OxideMD ${installed} is installed. Restart to apply the update.`
      : 'A newer OxideMD is installed. Restart to apply the update.';
    showToast(msg, 'success', { lifetimeMs: 15000 });
  });

  // Filesystem changes in any watched file/folder. The Rust watcher may
  // fire several events per save (editors write+truncate+rename); coalesce
  // them into a single reload per path.
  await listen('fs-changed', (e) => {
    if (typeof e.payload === 'string') handleFsChange(e.payload);
  });

  await appWindow.onDragDropEvent(async (e) => {
    const p = e.payload;
    if (p.type === 'leave') {
      editorModule()?.clearEditorDropHint();
      return;
    }
    if (p.type === 'enter' || p.type === 'over') {
      const { x, y } = dropClientPoint(p.position);
      editorModule()?.updateEditorDropHint(x, y);
      return;
    }
    if (p.type === 'drop') {
      editorModule()?.clearEditorDropHint();
      const { x, y } = dropClientPoint(p.position);
      // An image dropped onto the editor inserts a markdown reference;
      // anything else (or a drop elsewhere) keeps the existing behavior of
      // opening dropped .md files.
      if (await editorModule()?.dropImagesIntoEditor(p.paths, x, y)) return;
      for (const path of p.paths) {
        if (isMarkdownPath(path)) loadFile(path);
      }
    }
  });

  syncMaximizeIcon();
}

// Tauri reports drag-drop coordinates in physical pixels relative to the
// webview's client area; convert to CSS pixels so they match DOM hit-testing
// (elementFromPoint / posAtCoords).
function dropClientPoint(position) {
  const dpr = window.devicePixelRatio || 1;
  return { x: position.x / dpr, y: position.y / dpr };
}

// ── Event wiring ───────────────────────────────────────────────────────────
// ── Window controls ────────────────────────────────────────────────────────
const ICON_MAXIMIZE = `<rect x="4" y="4" width="16" height="16" rx="1"/>`;
const ICON_RESTORE  = `<rect x="2" y="6" width="14" height="14" rx="1"/><polyline points="6 6 6 2 22 2 22 16 18 16"/>`;

async function syncMaximizeIcon() {
  // Two states matter for chrome behavior:
  //  - maximized: drives the toolbar icon + hides the resize handles
  //    (resizing a maximized window is a no-op on every platform).
  //  - fullscreen: separate from maximize on macOS (Cmd+Ctrl+F enters
  //    native fullscreen without going through "zoom"); on Windows /
  //    Linux it's reachable via WM tools. In either case the window
  //    can't be resized, so we hide the handles for both.
  const [isMax, isFull] = await Promise.all([
    appWindow.isMaximized(),
    appWindow.isFullscreen(),
  ]);
  btnMaximize.querySelector('svg').innerHTML = isMax ? ICON_RESTORE : ICON_MAXIMIZE;
  btnMaximize.title = isMax ? 'Restore' : 'Maximize';
  document.body.classList.toggle('maximized', isMax);
  document.body.classList.toggle('fullscreen', isFull);
}

btnMinimize.addEventListener('click', () => appWindow.minimize());
btnMaximize.addEventListener('click', async () => { await appWindow.toggleMaximize(); syncMaximizeIcon(); });
btnWinClose.addEventListener('click', () => appWindow.close());
// `onResized` fires on every pixel of a drag-resize. `isMaximized()` is
// an async IPC round-trip, and the icon / `body.maximized` only matter
// at rest — so debounce to the trailing edge so a long drag does one
// IPC call when the user lets go, not dozens per second.
appWindow.onResized(debounce(syncMaximizeIcon, 120));

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
  if (shortcutsPopover.contains(e.target as Node) || btnLogo.contains(e.target as Node)) return;
  closeShortcutsPopover();
});

// Keep popover anchored to the logo across window resizes (maximize,
// snap, manual resize). The listener is cheap and only reads/writes
// two style properties when the popover is open.
window.addEventListener('resize', () => {
  if (shortcutsPopover.classList.contains('hidden')) return;
  positionShortcutsPopover();
});

btnNew.addEventListener('click', () => createNewFile());
btnOpen.addEventListener('click', openFilePicker);
// In narrow (drawer) mode with a folder already open, the folder button
// toggles the file-tree drawer rather than re-opening the OS picker —
// it's the affordance for bringing the tree back after it auto-collapsed.
// Otherwise it opens a folder as usual.
btnOpenFolder.addEventListener('click', () => {
  if (document.body.classList.contains('narrow') && state.currentFolder) {
    toggleSidebarDrawer();
  } else {
    openFolder();
  }
});
sidebarCloseBtn.addEventListener('click', closeFolder);

// Tapping the dimmed backdrop closes whichever drawer is open (narrow
// mode only — it's display:none otherwise so this never fires when docked).
const drawerBackdrop = document.getElementById('drawer-backdrop');
if (drawerBackdrop) {
  drawerBackdrop.addEventListener('click', () => {
    collapseSidebarDrawer();
    closeOutline();
  });
}
sidebarExpandAllBtn.addEventListener('click', expandAllFolders);
sidebarCollapseAllBtn.addEventListener('click', collapseAllFolders);
if (sidebarFilterToggle) sidebarFilterToggle.addEventListener('click', toggleFilterMode);

// The clear-button toggle runs on every keystroke; only the (heavier)
// tree re-filter is debounced.
const debouncedTreeFilter = debounce(setTreeFilter, 80);
sidebarFilterInput.addEventListener('input', () => {
  const value = (sidebarFilterInput as HTMLInputElement).value;
  sidebarFilterClearBtn.classList.toggle('hidden', value === '');
  debouncedTreeFilter(value);
});
sidebarFilterInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if ((sidebarFilterInput as HTMLInputElement).value) {
      clearTreeFilter();
    } else {
      // Empty filter → Escape collapses the filter mode entirely, back
      // to the plain tree (matches the content-search panel's Escape).
      closeFilterMode();
    }
  } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
    const firstRow = sidebarTreeEl.querySelector('.tree-row');
    if (firstRow) { e.preventDefault(); (firstRow as HTMLElement).focus(); }
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
  const target = e.target as HTMLElement;
  if (target.closest('#welcome-new'))         { createNewFile(); return; }
  if (target.closest('#welcome-open-folder')) { openFolder(); return; }
  if (target.closest('#welcome-open'))        { openFilePicker(); return; }
  const recentClear = target.closest('#welcome-recent-clear');
  if (recentClear) {
    invoke('clear_recent_files')
      .then(() => applyRecentFiles([]))
      .catch(() => {});
    return;
  }
  const recentForget = target.closest('.welcome-recent-forget') as HTMLElement;
  if (recentForget) {
    e.stopPropagation();
    invoke('forget_recent_file', { path: recentForget.dataset.path })
      .then(applyRecentFiles)
      .catch(() => {});
    return;
  }
  const recentLink = target.closest('.welcome-recent-link') as HTMLElement;
  if (recentLink) {
    loadFile(recentLink.dataset.path);
    return;
  }
  const copyBtn = target.closest('.codeblock-copy');
  if (copyBtn) {
    e.preventDefault();
    copyCodeBlock(copyBtn);
    return;
  }
  const anchor = target.closest('a');
  if (anchor && contentEl.contains(anchor)) {
    e.preventDefault();
    handleAnchorClick(anchor);
  }
});

if (previewPane) {
  previewPane.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const copyBtn = target.closest('.codeblock-copy');
    if (copyBtn) {
      e.preventDefault();
      copyCodeBlock(copyBtn);
    }
  }, true);
}

async function copyCodeBlock(btn) {
  const block = btn.closest('.codeblock');
  if (!block) return;
  // The Rust renderer stuffs the raw source into data-code so we don't
  // have to reverse syntect spans to get copy-friendly text. The
  // browser already decoded the attribute's HTML entities for us, so
  // dataset.code is the original bytes.
  const raw = block.dataset.code || '';
  try {
    await navigator.clipboard.writeText(raw);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1200);
  } catch (err) {
    logError('copy-code', 'clipboard write failed', err);
  }
}
// Same treatment for anchors inside the live preview pane — without this,
// clicking a link would let the webview navigate away and take the whole
// app with it.
if (previewPane) {
  previewPane.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest('a');
    if (anchor && previewPane.contains(anchor)) {
      e.preventDefault();
      handleAnchorClick(anchor);
    }
  });
}
btnReload.addEventListener('click', reloadFile);
btnSearch.addEventListener('click', toggleSearch);
btnPrint.addEventListener('click', printActiveTab);
btnSettings.addEventListener('click', () => openSettings(undefined as any));
btnModeToggle.addEventListener('click', () => {
  const tab = activeTab();
  if (!tab || !tab.path) return;
  if (tab.editing) editorModule()?.exitEditMode();
  else loadEditorModule().then((m) => m.enterEditMode());
});
btnSave.addEventListener('click', () => editorModule()?.saveActiveFile());
btnZoomOut.addEventListener('click', zoomOut);
btnZoomIn.addEventListener('click', zoomIn);
zoomLabel.addEventListener('click', resetZoom);

searchCase.addEventListener('click', () => {
  state.searchCaseSensitive = !state.searchCaseSensitive;
  searchCase.classList.toggle('active', state.searchCaseSensitive);
  searchCase.setAttribute('aria-pressed', state.searchCaseSensitive ? 'true' : 'false');
  runSearch((searchInput as HTMLInputElement).value);
});

searchInput.addEventListener('input', debounce(() => runSearch((searchInput as HTMLInputElement).value), 40));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.shiftKey ? prevMatch() : nextMatch(); e.preventDefault(); }
  if (e.key === 'Escape') { closeSearch(); e.preventDefault(); }
});
searchPrev.addEventListener('click', prevMatch);
searchNext.addEventListener('click', nextMatch);
searchClose.addEventListener('click', closeSearch);

// Replace row (edit mode only — hidden in read mode).
searchReplace.addEventListener('click', replaceCurrent);
searchReplaceAll.addEventListener('click', replaceAllMatches);
searchReplaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { replaceCurrent(); e.preventDefault(); }
  if (e.key === 'Escape') { closeSearch(); e.preventDefault(); }
});

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

registerHandler('newFile',     (e) => { e?.preventDefault(); createNewFile(); });
registerHandler('openFile',    (e) => { e?.preventDefault(); openFilePicker(); });
registerHandler('openFolder',  (e) => { e?.preventDefault(); openFolder(); });
registerHandler('closeFolder', (e) => {
  if (!state.currentFolder) return;   // no folder → let the key pass through
  e?.preventDefault();
  closeFolder();
});
registerHandler('searchInFolder', (e) => {
  if (!state.currentFolder) return;   // no folder → let the key pass through
  e?.preventDefault();
  openProjectSearch();
});
registerHandler('save', (e) => {
  e?.preventDefault();
  const tab = activeTab();
  if (tab?.editing) editorModule()?.saveActiveFile();
});
registerHandler('reload', (e) => { e?.preventDefault(); reloadFile(); });
registerHandler('print',  (e) => { e?.preventDefault(); printActiveTab(); });
registerHandler('exportHtml', async (e) => {
  e?.preventDefault();
  const tab = activeTab();
  if (!tab?.path) return;
  // Use the live editor buffer when one is mounted so the export
  // includes unsaved edits — otherwise tab.raw equals savedRaw.
  const source = tab.raw ?? '';
  const baseName = stripMarkdownExtension(tab.title || 'document');
  try {
    const outPath = await invoke('pick_export_path', { suggestedName: `${baseName}.html` });
    if (!outPath) return;
    await invoke('export_html', {
      source,
      basePath: tab.path,
      outPath,
      title: baseName,
    });
  } catch (err) {
    showErrorModal('Export failed', 'Could not export the file as HTML.', err);
  }
});

registerHandler('toggleEdit', (e) => {
  e?.preventDefault();
  const tab = activeTab();
  if (!tab?.path) return;
  if (tab.editing) editorModule()?.exitEditMode();
  else loadEditorModule().then((m) => m.enterEditMode());
});
registerHandler('toggleSearch', (e) => {
  e?.preventDefault();
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
  if (state.errorDialogOpen) return;

  if (e.key === 'Escape') {
    // Escape closes exactly one thing: the topmost open overlay, in
    // strict precedence order. Each branch consumes the event
    // (preventDefault + stopPropagation) so it can't also reach a
    // lower-priority handler or the edit-mode toggle. With nothing
    // open, Escape is a no-op here and falls through untouched.
    //   confirm dialog > shortcuts popover > settings > search bar
    // The confirm dialog is handled in editor.js (it owns the
    // resolve-on-key promise); we just stop here so settings/search
    // below don't also fire.
    if (!confirmOverlay.classList.contains('hidden')) { return; }
    if (!shortcutsPopover.classList.contains('hidden')) {
      e.preventDefault(); e.stopPropagation();
      closeShortcutsPopover(); btnLogo.focus(); return;
    }
    if (!settingsOverlay.classList.contains('hidden')) {
      e.preventDefault(); e.stopPropagation();
      closeSettings(); return;
    }
    if (!searchBar.classList.contains('hidden')) {
      e.preventDefault(); e.stopPropagation();
      closeSearch(); return;
    }
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
