import {
  invoke, convertFileSrc, listen, appWindow,
  isMac, modKey, isMarkdownPath, isPathInside, hasMod,
  tabs, expandedFolders, state,
  ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, ZOOM_DEFAULT,
  supportsHighlights, matchHighlight, currentHighlight,
  systemDarkMQ,
  tabBarEl, contentEl, contentScroll,
  btnOpen, btnOpenFolder, btnClose, btnReload, btnSearch, btnSettings,
  btnMinimize, btnMaximize, btnWinClose,
  filePathEl, statusIndicator, statusText,
  btnZoomOut, btnZoomIn, zoomLabel,
  searchBar, searchInput, searchCase, searchPrev, searchNext, searchClose, searchCount,
  settingsOverlay, pickerBackdrop,
  sidebarEl, sidebarFolderName, sidebarTreeEl, sidebarCloseBtn,
  WELCOME_HTML,
  hasActiveOverlay,
} from './state.js';
import {
  toggleSearch, closeSearch, clearSearch, runSearch, nextMatch, prevMatch,
} from './search.js';

// Local images are emitted by the Rust renderer as `<img data-oxide-src="…">`
// with an absolute path. The webview can't load a raw filesystem path, so we
// rewrite it to an asset:// URL here. Remote images already carry a real `src`
// and are untouched.
function renderContent(html) {
  // Any existing search highlights point to about-to-be-detached text nodes.
  // Drop them so the registry doesn't hold refs to orphaned ranges.
  if (state.searchRanges.length || (supportsHighlights && currentHighlight.size)) {
    state.searchRanges = [];
    state.searchCurrent = -1;
    if (supportsHighlights) {
      matchHighlight.clear();
      currentHighlight.clear();
    }
  }
  contentEl.innerHTML = html;
  for (const img of contentEl.querySelectorAll('img[data-oxide-src]')) {
    img.src = convertFileSrc(img.dataset.oxideSrc);
  }
}

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

// ── Toolbar state ──────────────────────────────────────────────────────────
function syncToolbar() {
  const hasTab = state.activeTabId !== null;
  btnClose.disabled  = !hasTab;
  btnReload.disabled = !hasTab;
  btnSearch.disabled = !hasTab;
  btnZoomIn.disabled  = !hasTab;
  btnZoomOut.disabled = !hasTab;
  zoomLabel.disabled  = !hasTab;
}

// ── File-system watcher sync ─────────────────────────────────────────────
// Whenever the set of interesting paths changes (tab opened/closed or a
// folder picked/closed), push the new set to the Rust-side watcher. The
// backend replaces the previous watcher in one step, so this is safe to
// call on every mutation.
function syncWatcher() {
  const paths = new Set();
  for (const t of tabs) if (t.path) paths.add(t.path);
  if (state.currentFolder?.root) paths.add(state.currentFolder.root);
  invoke('watch_paths', { paths: [...paths] }).catch(() => {});
}

// Prefix-match with a trailing separator so `C:\docs` doesn't match
// `C:\docs2\foo.md`. Handle both separator styles — notify can echo
// either depending on how the path was registered.
function isPathInside(child, parent) {
  if (child === parent) return true;
  return child.startsWith(parent + '\\') || child.startsWith(parent + '/');
}

const pendingFsChanges = new Set();
let fsChangeTimer = null;
function handleFsChange(path) {
  pendingFsChanges.add(path);
  if (fsChangeTimer) clearTimeout(fsChangeTimer);
  fsChangeTimer = setTimeout(flushFsChanges, 200);
}

async function flushFsChanges() {
  fsChangeTimer = null;
  const paths = [...pendingFsChanges];
  pendingFsChanges.clear();

  let folderDirty = false;
  const folderRoot = state.currentFolder?.root ?? null;

  for (const p of paths) {
    const tab = tabs.find(t => t.path === p);
    if (tab) {
      try {
        const result = await invoke('open_file', { path: p });
        tab.html = result.html;
        tab.title = result.title;
        if (tab.id === state.activeTabId) {
          const scrollTop = contentScroll.scrollTop;
          renderContent(result.html);
          state.originalContent = result.html;
          requestAnimationFrame(() => { contentScroll.scrollTop = scrollTop; });
        }
      } catch { /* file vanished; leave tab as-is */ }
    }
    if (folderRoot && isPathInside(p, folderRoot)) folderDirty = true;
  }

  if (folderDirty && folderRoot) {
    try {
      const tree = await invoke('read_folder_tree', { path: folderRoot });
      state.currentFolder = tree;
      renderFolderTree();
    } catch { /* folder gone */ }
  }
}

// ── Tab management ─────────────────────────────────────────────────────────
function activeTab() {
  return tabs.find(t => t.id === state.activeTabId) ?? null;
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
  const id = state.nextTabId++;
  tabs.push({ id, path, title, html, scrollTop: 0, zoom: ZOOM_DEFAULT });
  state.activeTabId = id;
  syncToolbar();
  renderTabBar();
  applyActiveTab();
  syncWatcher();
}

function switchToTab(id) {
  // Save scroll position of current tab before leaving
  const cur = activeTab();
  if (cur) cur.scrollTop = contentScroll.scrollTop;

  state.activeTabId = id;
  clearSearch();
  renderTabBar();
  applyActiveTab();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;

  // Save scroll before closing if it's active
  if (id === state.activeTabId) {
    tabs[idx].scrollTop = contentScroll.scrollTop;
  }

  tabs.splice(idx, 1);
  syncWatcher();

  if (tabs.length === 0) {
    state.activeTabId = null;
    clearSearch();
    syncToolbar();
    renderTabBar();
    showWelcome();
  } else if (id === state.activeTabId) {
    state.activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
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

  renderContent(tab.html);
  state.originalContent = tab.html;
  appWindow.setTitle(tab.title);
  document.title = tab.title;
  setStatusFilePath(tab.path || '');
  applyZoom(tab.zoom);
  highlightActiveTreeItem();

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
  state.originalContent = '';
  appWindow.setTitle('OxideMD');
  document.title = 'OxideMD';
  setStatusFilePath('');
  zoomLabel.textContent = '100%';
  highlightActiveTreeItem();
  clearStatus();
}

function setStatusFilePath(path) {
  if (state.copyResetTimer) { clearTimeout(state.copyResetTimer); state.copyResetTimer = null; }
  filePathEl.textContent = path || '';
  filePathEl.title = path || '';
  filePathEl.classList.toggle('clickable', !!path);
  filePathEl.classList.remove('copied');
  if (path) {
    filePathEl.setAttribute('role', 'button');
    filePathEl.setAttribute('tabindex', '0');
    filePathEl.setAttribute('aria-label', `Copy path to clipboard: ${path}`);
  } else {
    filePathEl.removeAttribute('role');
    filePathEl.removeAttribute('tabindex');
    filePathEl.removeAttribute('aria-label');
  }
}

// ── Zoom ───────────────────────────────────────────────────────────────────
function applyZoom(zoom) {
  contentEl.style.fontSize = `calc(var(--font-size) * ${zoom.toFixed(2)})`;
  contentEl.style.maxWidth = `${Math.round((state.config?.reading_width ?? 800) * zoom)}px`;
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
    const isActive = tab.id === state.activeTabId;
    const el = document.createElement('div');
    el.className = 'tab' + (isActive ? ' active' : '');
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', isActive ? 'true' : 'false');
    el.setAttribute('aria-label', tab.title);
    el.tabIndex = isActive ? 0 : -1;
    el.dataset.tabId = String(tab.id);

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title';
    titleSpan.textContent = tab.title;
    titleSpan.title = tab.path || tab.title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.setAttribute('aria-label', `Close ${tab.title}`);
    closeBtn.tabIndex = -1;
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

  updateTabOverflow();
}

tabBarEl.addEventListener('keydown', (e) => {
  const targetTab = e.target.closest('.tab');
  if (!targetTab || !tabBarEl.contains(targetTab)) return;
  const allTabs = Array.from(tabBarEl.querySelectorAll('.tab'));
  const idx = allTabs.indexOf(targetTab);
  if (idx === -1) return;

  let nextIdx = -1;
  if (e.key === 'ArrowLeft')      nextIdx = (idx - 1 + allTabs.length) % allTabs.length;
  else if (e.key === 'ArrowRight') nextIdx = (idx + 1) % allTabs.length;
  else if (e.key === 'Home')       nextIdx = 0;
  else if (e.key === 'End')        nextIdx = allTabs.length - 1;
  else if (e.key === 'Delete') {
    e.preventDefault();
    const id = Number(targetTab.dataset.tabId);
    if (!Number.isNaN(id)) {
      closeTab(id);
      const newActive = tabBarEl.querySelector('.tab.active');
      if (newActive) newActive.focus();
    }
    return;
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const id = Number(targetTab.dataset.tabId);
    if (!Number.isNaN(id)) switchToTab(id);
    return;
  } else {
    return;
  }

  e.preventDefault();
  const nextTab = allTabs[nextIdx];
  const id = Number(nextTab.dataset.tabId);
  if (!Number.isNaN(id)) switchToTab(id);
  nextTab.focus();
});

function updateTabOverflow() {
  const hasOverflow = tabBarEl.scrollWidth > tabBarEl.clientWidth;
  if (!hasOverflow) {
    tabBarEl.classList.remove('has-overflow-left', 'has-overflow-right');
    return;
  }
  const scrollLeft = tabBarEl.scrollLeft;
  const maxScroll = tabBarEl.scrollWidth - tabBarEl.clientWidth;
  tabBarEl.classList.toggle('has-overflow-left', scrollLeft > 2);
  tabBarEl.classList.toggle('has-overflow-right', scrollLeft < maxScroll - 2);
}

tabBarEl.addEventListener('scroll', updateTabOverflow);

// ── Folder / sidebar ───────────────────────────────────────────────────────
const SVG_TWISTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
const SVG_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const SVG_FILE   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

async function openFolder() {
  if (hasActiveOverlay()) return;
  state.filePickerOpen = true;
  pickerBackdrop.classList.remove('hidden');
  let tree = null;
  try {
    tree = await invoke('pick_folder');
  } catch {} finally {
    pickerBackdrop.classList.add('hidden');
    state.filePickerOpen = false;
  }
  if (tree) setFolder(tree);
}

function setFolder(tree) {
  state.currentFolder = tree;
  expandedFolders.clear();
  sidebarFolderName.textContent = tree.name || tree.root;
  sidebarFolderName.title = tree.root;
  sidebarEl.classList.remove('hidden');
  renderFolderTree();
  syncWatcher();
}

function closeFolder() {
  state.currentFolder = null;
  expandedFolders.clear();
  sidebarTreeEl.innerHTML = '';
  sidebarFolderName.textContent = '';
  sidebarFolderName.title = '';
  sidebarEl.classList.add('hidden');
  syncWatcher();
}

function renderFolderTree() {
  sidebarTreeEl.innerHTML = '';
  if (!state.currentFolder) return;
  if (!state.currentFolder.entries || state.currentFolder.entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'No Markdown files in this folder.';
    sidebarTreeEl.appendChild(empty);
    return;
  }
  for (const entry of state.currentFolder.entries) {
    sidebarTreeEl.appendChild(buildTreeNode(entry));
  }
  if (state.currentFolder.truncated) {
    const hint = document.createElement('div');
    hint.className = 'tree-truncated';
    hint.textContent = 'Folder too large — some entries are not shown.';
    sidebarTreeEl.appendChild(hint);
  }
  highlightActiveTreeItem();
  // Roving tabindex: set the active row (or first) as the focus entry point
  const active = sidebarTreeEl.querySelector('.tree-row.active');
  const first = sidebarTreeEl.querySelector('.tree-row');
  const entry = active || first;
  if (entry) entry.tabIndex = 0;
}

function buildTreeNode(node) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node' + (node.isDir ? ' tree-dir' : ' tree-file');
  wrap.dataset.path = node.path;
  if (node.isDir && expandedFolders.has(node.path)) wrap.classList.add('expanded');

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.setAttribute('role', 'treeitem');
  row.tabIndex = -1;
  if (node.isDir) {
    row.setAttribute('aria-expanded', expandedFolders.has(node.path) ? 'true' : 'false');
  }
  row.title = node.path;

  const twisty = document.createElement('span');
  twisty.className = 'tree-twisty' + (node.isDir ? '' : ' empty');
  twisty.innerHTML = node.isDir ? SVG_TWISTY : '';
  row.appendChild(twisty);

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = node.isDir ? SVG_FOLDER : SVG_FILE;
  row.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = node.name;
  row.appendChild(label);

  wrap.appendChild(row);

  if (node.isDir) {
    const children = document.createElement('div');
    children.className = 'tree-children';
    for (const child of node.children || []) {
      children.appendChild(buildTreeNode(child));
    }
    wrap.appendChild(children);

    row.addEventListener('click', () => {
      const isExpanded = wrap.classList.toggle('expanded');
      if (isExpanded) expandedFolders.add(node.path);
      else expandedFolders.delete(node.path);
      row.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    });
  } else {
    row.addEventListener('click', () => loadFile(node.path));
  }

  return wrap;
}

function visibleTreeRows() {
  return Array.from(sidebarTreeEl.querySelectorAll('.tree-row')).filter(r => r.offsetParent !== null);
}

function focusTreeRow(row) {
  if (!row) return;
  sidebarTreeEl.querySelectorAll('.tree-row[tabindex="0"]').forEach(r => { r.tabIndex = -1; });
  row.tabIndex = 0;
  row.focus();
  row.scrollIntoView({ block: 'nearest' });
}

sidebarTreeEl.addEventListener('focusin', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row) return;
  sidebarTreeEl.querySelectorAll('.tree-row[tabindex="0"]').forEach(r => {
    if (r !== row) r.tabIndex = -1;
  });
  row.tabIndex = 0;
});

sidebarTreeEl.addEventListener('keydown', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row || !sidebarTreeEl.contains(row)) return;

  const rows = visibleTreeRows();
  const idx = rows.indexOf(row);
  if (idx === -1) return;

  const wrap = row.parentElement; // .tree-node
  const isDir = wrap.classList.contains('tree-dir');
  const isExpanded = wrap.classList.contains('expanded');

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (idx < rows.length - 1) focusTreeRow(rows[idx + 1]);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (idx > 0) focusTreeRow(rows[idx - 1]);
  } else if (e.key === 'Home') {
    e.preventDefault();
    if (rows.length) focusTreeRow(rows[0]);
  } else if (e.key === 'End') {
    e.preventDefault();
    if (rows.length) focusTreeRow(rows[rows.length - 1]);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (isDir && !isExpanded) {
      row.click();
    } else if (isDir && isExpanded) {
      const nextRow = rows[idx + 1];
      if (nextRow && wrap.contains(nextRow)) focusTreeRow(nextRow);
    }
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (isDir && isExpanded) {
      row.click();
    } else {
      // Move focus to parent folder
      const parentWrap = wrap.parentElement?.closest('.tree-node');
      const parentRow = parentWrap?.querySelector(':scope > .tree-row');
      if (parentRow) focusTreeRow(parentRow);
    }
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    row.click();
  }
});

function highlightActiveTreeItem() {
  if (!state.currentFolder) return;
  const tab = activeTab();
  const activePath = tab?.path || '';
  sidebarTreeEl.querySelectorAll('.tree-row').forEach(r => r.classList.remove('active'));
  if (!activePath) return;
  const node = sidebarTreeEl.querySelector(`.tree-file[data-path="${CSS.escape(activePath)}"]`);
  if (!node) return;
  node.querySelector('.tree-row')?.classList.add('active');
  // Expand ancestor folders so the active item is visible.
  let parent = node.parentElement;
  while (parent && parent !== sidebarTreeEl) {
    if (parent.classList.contains('tree-children')) {
      const folderNode = parent.parentElement;
      if (folderNode?.classList.contains('tree-dir')) {
        folderNode.classList.add('expanded');
        if (folderNode.dataset.path) expandedFolders.add(folderNode.dataset.path);
      }
    }
    parent = parent.parentElement;
  }
  node.querySelector('.tree-row')?.scrollIntoView({ block: 'nearest' });
}

// ── File loading ───────────────────────────────────────────────────────────
async function loadFile(path) {
  setLoading();
  try {
    const result = await invoke('open_file', { path });
    openInNewTab(result.path || path, result.title, result.html);
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
// Links are handled via a single delegated listener on contentEl (installed
// near the other contentEl delegation at the bottom of this file). That
// means we don't attach a per-anchor listener after every innerHTML
// rewrite, which used to both churn listeners and stop working when
// search mutated the DOM.
async function handleAnchorClick(anchor) {
  const href = anchor.getAttribute('href') || '';
  if (!href) return;

  // In-page anchor → smooth scroll
  if (href.startsWith('#')) {
    const target = document.getElementById(href.slice(1));
    if (target) target.scrollIntoView({ behavior: 'smooth' });
    return;
  }

  // If this resolves to a local .md file, open it in a (new) tab.
  const tab = activeTab();
  if (tab?.path) {
    try {
      const resolved = await invoke('resolve_md_path', { base: tab.path, href });
      if (resolved) {
        // Strip fragment from href; we'll scroll to it after the tab loads.
        const hashIdx = href.indexOf('#');
        const fragment = hashIdx !== -1 ? href.slice(hashIdx + 1) : '';
        await loadFile(resolved);
        if (fragment) {
          requestAnimationFrame(() => {
            const target = document.getElementById(fragment);
            if (target) target.scrollIntoView({ behavior: 'smooth' });
          });
        }
        return;
      }
    } catch {}
  }

  // Fallback: open externally.
  try { await invoke('open_url', { url: href }); } catch {}
}

// ── Open dialog ────────────────────────────────────────────────────────────
async function openFilePicker() {
  if (hasActiveOverlay()) return;
  state.filePickerOpen = true;
  pickerBackdrop.classList.remove('hidden');
  try {
    const paths = await invoke('pick_file');
    for (const path of paths) await loadFile(path);
  } catch {} finally {
    pickerBackdrop.classList.add('hidden');
    state.filePickerOpen = false;
  }
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
