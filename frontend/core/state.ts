// Shared module-level state and DOM refs used across the frontend modules.
// Mutable values live on the `state` object so importers can read/write via
// `state.foo`; module-level `let` bindings from ES modules can't be
// reassigned by importers, so any value that gets replaced must go here.

// ── Tauri v2 API (available via withGlobalTauri: true) ────────────────────
export const { invoke, convertFileSrc } = window.__TAURI__.core;
export const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
export const appWindow = getCurrentWindow();

// ── Platform detection ────────────────────────────────────────────────────
export const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
export const isLinux = /Linux/i.test(navigator.platform) && !isMac;
export const modKey = isMac ? 'Cmd' : 'Ctrl';

// Canonical default Markdown extensions — must mirror MD_EXTS_DEFAULT in
// src-tauri/src/config.rs. Used as the fallback whenever config.md_extensions
// is missing (older config files) or empty.
export const MD_EXTS_DEFAULT = ['md', 'markdown', 'mdown', 'mkd'];

// The configured (or default) Markdown extension list, read live from
// state.config so a Settings save takes effect without a reload.
function mdExtensions() {
  const list = state.config?.md_extensions;
  return Array.isArray(list) && list.length ? list : MD_EXTS_DEFAULT;
}

export function pathExtension(p) {
  const dot = p.lastIndexOf('.');
  // No dot, or the last dot belongs to a directory name (it sits before
  // the final path separator) rather than the file's basename.
  const lastSep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (dot <= lastSep) return '';
  return p.slice(dot + 1).toLowerCase();
}

export function isMarkdownPath(p) {
  return typeof p === 'string' && mdExtensions().includes(pathExtension(p));
}

// Strips a recognized Markdown extension from a file name, leaving any
// other extension (or a dotless name) untouched. Used for export filenames.
export function stripMarkdownExtension(name) {
  if (typeof name !== 'string') return name;
  const ext = pathExtension(name);
  if (ext && mdExtensions().includes(ext)) {
    return name.slice(0, name.length - ext.length - 1);
  }
  return name;
}

// Prefix-match with a trailing separator so `C:\docs` doesn't match
// `C:\docs2\foo.md`. Handle both separator styles — notify can echo
// either depending on how the path was registered.
export function isPathInside(child, parent) {
  if (child === parent) return true;
  return child.startsWith(parent + '\\') || child.startsWith(parent + '/');
}

// Accept both Ctrl and Cmd (metaKey) so shortcuts work on macOS
export function hasMod(e) { return e.ctrlKey || e.metaKey; }

// ── Shared mutable state ─────────────────────────────────────────────────
// Arrays/Sets are never reassigned — only mutated in place — so they're
// safe as direct named exports. Primitive and object slots that get
// replaced live on `state`.
export const tabs = [];
export const expandedFolders = new Set();

export const state = {
  activeTabId: null,
  nextTabId: 1,
  currentFolder: null,
  config: null,
  searchRanges: [],
  searchCurrent: -1,
  searchCaseSensitive: false,
  customFonts: [],
  customThemes: [],
  builtinThemes: [],
  fontStyleEl: null,
  activeFontFilename: null,
  copyResetTimer: null,
  filePickerOpen: false,
  treeFilter: '',
  confirmDialogOpen: false,
  errorDialogOpen: false,
  // Resolved keybindings map, shape { [actionId]: { primary, aliases[] } }.
  // Set in app.js init() from state.config.keybindings, re-set after the
  // Shortcuts tab saves. Dispatcher reads this on every keydown.
  bindings: Object.create(null),
  // Timestamp (ms) of the last successful save. While this sits within
  // the debounce window, watcher fs-change events for that path are
  // ignored so saving doesn't immediately re-trigger a file reload.
  lastSaveAt: 0,
  lastSavedPath: null,
  // Last list returned by `list_recent_files` / `mark_recent_file`. The
  // welcome screen reads this on every showWelcome() so a fresh tab
  // close repaints with the up-to-date list.
  recentFiles: [],
};

// ── Zoom constants ────────────────────────────────────────────────────────
export const ZOOM_MIN  = 0.5;
export const ZOOM_MAX  = 2.0;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1.0;

// ── CSS Custom Highlight API registry ─────────────────────────────────────
// Painted via ::highlight() in style.css. Avoids mutating the DOM on
// search, so images, links, and event bindings survive a search untouched.
// `currentHighlight.priority` outranks the base match highlight so the
// "current" styling wins where they overlap.
export const supportsHighlights =
  typeof Highlight === 'function'
  && typeof CSS !== 'undefined'
  && CSS.highlights;
export const matchHighlight = supportsHighlights ? new Highlight() : null;
export const currentHighlight = supportsHighlights ? new Highlight() : null;
// Highlights the matched substring in the preview pane when a project-search
// result is opened (the editor uses a CM6 decoration for the same job).
export const revealHighlight = supportsHighlights ? new Highlight() : null;
if (supportsHighlights) {
  matchHighlight.priority = 0;
  currentHighlight.priority = 1;
  revealHighlight.priority = 2;
  CSS.highlights.set('oxide-match', matchHighlight);
  CSS.highlights.set('oxide-current', currentHighlight);
  CSS.highlights.set('oxide-reveal-match', revealHighlight);
}

// ── System dark/light preference ──────────────────────────────────────────
export const systemDarkMQ = window.matchMedia('(prefers-color-scheme: dark)');

// ── DOM refs ──────────────────────────────────────────────────────────────
export const tabBarEl        = document.getElementById('tab-area');
export const tabScrollLeftEl  = document.getElementById('tab-scroll-left');
export const tabScrollRightEl = document.getElementById('tab-scroll-right');
export const contentEl       = document.getElementById('content');
export const contentScroll   = document.getElementById('content-scroll');
export const editorSplit     = document.getElementById('editor-split');
export const editorPane      = document.getElementById('editor-pane');
export const previewPane     = document.getElementById('preview-pane');
export const splitDivider    = document.getElementById('split-divider');
export const btnNew          = document.getElementById('btn-new');
export const btnOpen         = document.getElementById('btn-open');
export const btnOpenFolder   = document.getElementById('btn-open-folder');
export const btnPrint        = document.getElementById('btn-print');
export const btnReload       = document.getElementById('btn-reload');
export const btnModeToggle   = document.getElementById('btn-mode-toggle');
export const btnSave         = document.getElementById('btn-save');
export const btnDiscard      = document.getElementById('btn-discard');
export const editToolbar     = document.getElementById('edit-toolbar');
export const btnSearch       = document.getElementById('btn-search');
export const btnOutline      = document.getElementById('btn-outline');
export const btnPreview      = document.getElementById('btn-preview');
export const btnSettings     = document.getElementById('btn-settings');
export const btnMinimize     = document.getElementById('btn-minimize');
export const btnMaximize     = document.getElementById('btn-maximize');
export const btnWinClose     = document.getElementById('btn-winclose');
export const filePathEl      = document.getElementById('file-path');
export const statusCountsEl  = document.getElementById('status-counts');
export const statusIndicator = document.getElementById('status-indicator');
export const statusText      = document.getElementById('status-text');
export const btnZoomOut      = document.getElementById('btn-zoom-out');
export const btnZoomIn       = document.getElementById('btn-zoom-in');
export const zoomLabel       = document.getElementById('zoom-label');
export const searchBar       = document.getElementById('search-bar');
export const searchInput     = document.getElementById('search-input');
export const searchCase      = document.getElementById('search-case');
export const searchPrev      = document.getElementById('search-prev');
export const searchNext      = document.getElementById('search-next');
export const searchClose     = document.getElementById('search-close');
export const searchCount     = document.getElementById('search-count');
export const searchReplaceInput = document.getElementById('search-replace-input');
export const searchReplace      = document.getElementById('search-replace');
export const searchReplaceAll   = document.getElementById('search-replace-all');
export const settingsOverlay = document.getElementById('settings-overlay') as HTMLDialogElement;
export const btnLogo         = document.getElementById('btn-logo');
export const shortcutsPopover = document.getElementById('shortcuts-popover');
export const outlineSidebar  = document.getElementById('outline-sidebar');
export const outlineSidebarBody = document.getElementById('outline-sidebar-body');
export const outlineSidebarCloseBtn = document.getElementById('outline-sidebar-close');
export const pickerBackdrop  = document.getElementById('picker-backdrop');
export const pickerLoader    = document.getElementById('picker-loader');
export const sidebarEl       = document.getElementById('sidebar');
export const sidebarDivider  = document.getElementById('sidebar-divider');
export const sidebarFolderName = document.getElementById('sidebar-folder-name');
export const sidebarTreeEl   = document.getElementById('sidebar-tree');
export const sidebarCloseBtn = document.getElementById('sidebar-close');
export const sidebarExpandAllBtn   = document.getElementById('sidebar-expand-all');
export const sidebarCollapseAllBtn = document.getElementById('sidebar-collapse-all');
export const sidebarFilterToggle   = document.getElementById('sidebar-filter-toggle');
export const sidebarFilterEl       = document.getElementById('sidebar-filter');
export const sidebarFilterInput    = document.getElementById('sidebar-filter-input');
export const sidebarFilterClearBtn = document.getElementById('sidebar-filter-clear');
export const sidebarSearchToggle   = document.getElementById('sidebar-search-toggle');
export const sidebarSearchPanel    = document.getElementById('sidebar-search-panel');
export const sidebarSearchInput    = document.getElementById('sidebar-search-input');
export const sidebarSearchClearBtn = document.getElementById('sidebar-search-clear');
export const sidebarSearchResultsEl = document.getElementById('sidebar-search-results');
export const confirmOverlay   = document.getElementById('confirm-overlay') as HTMLDialogElement;
export const confirmDialog    = document.getElementById('confirm-dialog');
export const confirmDialogTitle = document.getElementById('confirm-dialog-title');
export const confirmDialogBody  = document.getElementById('confirm-dialog-body');
export const confirmCancelBtn = document.getElementById('confirm-cancel');
export const confirmDiscardBtn = document.getElementById('confirm-discard');
export const confirmSaveBtn   = document.getElementById('confirm-save');
export const errorOverlay     = document.getElementById('error-overlay') as HTMLDialogElement;
export const errorDialogTitle = document.getElementById('error-dialog-title');
export const errorDialogBody  = document.getElementById('error-dialog-body');
export const errorOkBtn       = document.getElementById('error-ok');

// Capture the welcome screen HTML from the initial DOM (index.html) before
// any content is loaded, so showWelcome() can restore the full styled version.
export const WELCOME_HTML = contentEl.innerHTML;

// Only one overlay (file picker, search, settings, confirm, error) can be open at a time.
export function hasActiveOverlay() {
  return state.filePickerOpen
    || !searchBar.classList.contains('hidden')
    || settingsOverlay.open
    || confirmOverlay.open
    || errorOverlay.open;
}
