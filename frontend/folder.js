import {
  invoke, isPathInside,
  tabs, expandedFolders, state,
  contentScroll,
  pickerBackdrop, pickerLoader,
  sidebarEl, sidebarDivider, sidebarFolderName, sidebarTreeEl,
  sidebarFilterInput, sidebarFilterClearBtn,
  hasActiveOverlay,
} from './state.js';
import { activeTab, loadFile, renderContent } from './tabs.js';
import { saveRecentlyFor } from './editor.js';

const SVG_TWISTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
const SVG_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const SVG_FILE   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

// Whenever the set of interesting paths changes (tab opened/closed or a
// folder picked/closed), push the new set to the Rust-side watcher. The
// backend replaces the previous watcher in one step, so this is safe to
// call on every mutation.
export function syncWatcher() {
  const paths = new Set();
  for (const t of tabs) if (t.path) paths.add(t.path);
  if (state.currentFolder?.root) paths.add(state.currentFolder.root);
  invoke('watch_paths', { paths: [...paths] }).catch(() => {});
}

const pendingFsChanges = new Set();
let fsChangeTimer = null;
export function handleFsChange(path) {
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
      // Don't clobber the tab while the user is actively editing it, and
      // don't round-trip our own save through the watcher (the save itself
      // already updated the tab; the inbound fs-changed event is just its
      // echo).
      if (tab.editing || saveRecentlyFor(p)) {
        // still fall through to check folder tree refresh
      } else {
        try {
          const result = await invoke('open_file', { path: p });
          tab.html = result.html;
          tab.title = result.title;
          tab.raw = result.raw ?? '';
          tab.savedRaw = tab.raw;
          if (tab.id === state.activeTabId) {
            const scrollTop = contentScroll.scrollTop;
            renderContent(result.html);
            state.originalContent = result.html;
            requestAnimationFrame(() => { contentScroll.scrollTop = scrollTop; });
          }
        } catch { /* file vanished; leave tab as-is */ }
      }
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

export async function openFolder() {
  if (hasActiveOverlay()) return;
  state.filePickerOpen = true;
  pickerBackdrop.classList.remove('hidden');
  let path = null;
  try {
    path = await invoke('pick_folder');
  } catch {}
  if (path) {
    // Dialog has closed; show the loader while Rust scans the folder
    // and while renderFolderTree blocks the main thread.
    pickerLoader.classList.remove('hidden');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const tree = await invoke('read_folder_tree', { path });
      setFolder(tree);
    } catch {}
  }
  pickerLoader.classList.add('hidden');
  pickerBackdrop.classList.add('hidden');
  state.filePickerOpen = false;
}

export function setFolder(tree) {
  state.currentFolder = tree;
  expandedFolders.clear();
  resetFilter();
  sidebarFolderName.textContent = tree.name || tree.root;
  sidebarFolderName.title = tree.root;
  sidebarEl.classList.remove('hidden');
  renderFolderTree();
  syncWatcher();
}

function resetFilter() {
  state.treeFilter = '';
  if (sidebarFilterInput) sidebarFilterInput.value = '';
  if (sidebarFilterClearBtn) sidebarFilterClearBtn.classList.add('hidden');
}

export function setTreeFilter(query) {
  const next = (query || '').trim();
  if (next === state.treeFilter) return;
  state.treeFilter = next;
  if (sidebarFilterClearBtn) sidebarFilterClearBtn.classList.toggle('hidden', next === '');
  renderFolderTree();
}

export function clearTreeFilter() {
  if (!state.treeFilter && !(sidebarFilterInput && sidebarFilterInput.value)) return;
  resetFilter();
  renderFolderTree();
}

// Filter the tree entries by name (case-insensitive substring). A folder is
// kept if it or any descendant matches; when a folder itself matches, all its
// children are kept so the user can see what's inside.
function filterEntries(entries, query) {
  const q = query.toLowerCase();
  const walk = (node) => {
    const selfMatch = node.name.toLowerCase().includes(q);
    if (!node.isDir) return selfMatch ? node : null;
    if (selfMatch) return node;
    const kept = [];
    for (const child of node.children || []) {
      const r = walk(child);
      if (r) kept.push(r);
    }
    if (kept.length === 0) return null;
    return { ...node, children: kept };
  };
  const out = [];
  for (const n of entries) {
    const r = walk(n);
    if (r) out.push(r);
  }
  return out;
}

function collectDirPaths(entries, out) {
  for (const entry of entries || []) {
    if (!entry.isDir) continue;
    out.add(entry.path);
    collectDirPaths(entry.children, out);
  }
}

export function expandAllFolders() {
  if (!state.currentFolder) return;
  collectDirPaths(state.currentFolder.entries, expandedFolders);
  renderFolderTree();
}

export function collapseAllFolders() {
  if (!state.currentFolder) return;
  expandedFolders.clear();
  renderFolderTree();
}

export function closeFolder() {
  state.currentFolder = null;
  expandedFolders.clear();
  resetFilter();
  sidebarTreeEl.innerHTML = '';
  sidebarFolderName.textContent = '';
  sidebarFolderName.title = '';
  sidebarEl.classList.add('hidden');
  syncWatcher();
}

export function renderFolderTree() {
  sidebarTreeEl.innerHTML = '';
  if (!state.currentFolder) return;

  const allEntries = state.currentFolder.entries;
  if (!allEntries || allEntries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'No Markdown files in this folder.';
    sidebarTreeEl.appendChild(empty);
    return;
  }

  const filter = state.treeFilter;
  const hasFilter = filter.length > 0;
  const entries = hasFilter ? filterEntries(allEntries, filter) : allEntries;

  if (hasFilter && entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'No files match the filter.';
    sidebarTreeEl.appendChild(empty);
    return;
  }

  const opts = { forceExpand: hasFilter, highlight: hasFilter ? filter : '' };
  for (const entry of entries) {
    sidebarTreeEl.appendChild(buildTreeNode(entry, opts));
  }
  if (state.currentFolder.truncated && !hasFilter) {
    const hint = document.createElement('div');
    hint.className = 'tree-truncated';
    hint.textContent = 'Folder too large — scan stopped, some files may be missing.';
    sidebarTreeEl.appendChild(hint);
  }
  if (!hasFilter) highlightActiveTreeItem();
  // Roving tabindex: set the active row (or first) as the focus entry point
  const active = sidebarTreeEl.querySelector('.tree-row.active');
  const first = sidebarTreeEl.querySelector('.tree-row');
  const entry = active || first;
  if (entry) entry.tabIndex = 0;
}

function buildTreeNode(node, opts = {}) {
  const forceExpand = !!opts.forceExpand;
  const highlight = opts.highlight || '';

  const wrap = document.createElement('div');
  wrap.className = 'tree-node' + (node.isDir ? ' tree-dir' : ' tree-file');
  wrap.dataset.path = node.path;
  const expanded = node.isDir && (forceExpand || expandedFolders.has(node.path));
  if (expanded) wrap.classList.add('expanded');

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.setAttribute('role', 'treeitem');
  row.tabIndex = -1;
  if (node.isDir) {
    row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
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
  if (highlight) renderHighlightedLabel(label, node.name, highlight);
  else label.textContent = node.name;
  row.appendChild(label);

  wrap.appendChild(row);

  if (node.isDir) {
    const children = document.createElement('div');
    children.className = 'tree-children';
    for (const child of node.children || []) {
      children.appendChild(buildTreeNode(child, opts));
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

function renderHighlightedLabel(label, text, query) {
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  let idx = lower.indexOf(q);
  if (idx === -1) { label.textContent = text; return; }
  label.textContent = '';
  let pos = 0;
  while (idx !== -1) {
    if (idx > pos) label.appendChild(document.createTextNode(text.slice(pos, idx)));
    const mark = document.createElement('mark');
    mark.className = 'tree-match';
    mark.textContent = text.slice(idx, idx + q.length);
    label.appendChild(mark);
    pos = idx + q.length;
    idx = lower.indexOf(q, pos);
  }
  if (pos < text.length) label.appendChild(document.createTextNode(text.slice(pos)));
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

export function highlightActiveTreeItem() {
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

// ── Sidebar divider ────────────────────────────────────────────────────
// Drag to resize the file tree; width is clamped and persisted to config
// on pointer release. Keyboard users get arrow-key nudging + Home/End.
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;

function setSidebarWidth(px, maxOverride = SIDEBAR_MAX) {
  const w = Math.max(SIDEBAR_MIN, Math.min(maxOverride, Math.round(px)));
  document.body.style.setProperty('--sidebar-width', `${w}px`);
  sidebarDivider.setAttribute('aria-valuenow', String(w));
  return w;
}

let sidebarDragPointerId = null;
let sidebarContainerLeft = 0;
let pendingSidebarSave = null;

function persistSidebarWidth(width) {
  if (!state.config) return;
  state.config.sidebar_width = width;
  if (pendingSidebarSave) clearTimeout(pendingSidebarSave);
  pendingSidebarSave = setTimeout(() => {
    pendingSidebarSave = null;
    invoke('save_config_cmd', { config: state.config }).catch(() => {});
  }, 150);
}

sidebarDivider.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sidebarDragPointerId = e.pointerId;
  const container = document.getElementById('main-container');
  sidebarContainerLeft = container.getBoundingClientRect().left;
  sidebarDivider.classList.add('dragging');
  document.body.classList.add('resizing-sidebar');
  try { sidebarDivider.setPointerCapture(e.pointerId); } catch {}
});

sidebarDivider.addEventListener('pointermove', (e) => {
  if (sidebarDragPointerId !== e.pointerId) return;
  setSidebarWidth(e.clientX - sidebarContainerLeft);
});

function endSidebarDrag(e) {
  if (sidebarDragPointerId !== e.pointerId) return;
  sidebarDragPointerId = null;
  sidebarDivider.classList.remove('dragging');
  document.body.classList.remove('resizing-sidebar');
  try { sidebarDivider.releasePointerCapture(e.pointerId); } catch {}
  const w = parseInt(sidebarDivider.getAttribute('aria-valuenow') || '240', 10);
  persistSidebarWidth(w);
}
sidebarDivider.addEventListener('pointerup', endSidebarDrag);
sidebarDivider.addEventListener('pointercancel', endSidebarDrag);

// Double-click the divider to fit the sidebar to its widest tree row,
// capped at 50% of the window's current width.
sidebarDivider.addEventListener('dblclick', (e) => {
  e.preventDefault();
  const overflow = sidebarTreeEl.scrollWidth - sidebarTreeEl.clientWidth;
  if (overflow <= 0) return;
  const cur = parseInt(sidebarDivider.getAttribute('aria-valuenow') || '240', 10);
  const maxAllowed = Math.max(SIDEBAR_MIN, Math.floor(window.innerWidth * 0.5));
  const applied = setSidebarWidth(cur + overflow, maxAllowed);
  persistSidebarWidth(applied);
});

sidebarDivider.addEventListener('keydown', (e) => {
  const cur = parseInt(sidebarDivider.getAttribute('aria-valuenow') || '240', 10);
  let next = cur;
  if (e.key === 'ArrowLeft')       next = cur - 10;
  else if (e.key === 'ArrowRight') next = cur + 10;
  else if (e.key === 'Home')       next = SIDEBAR_MIN;
  else if (e.key === 'End')        next = SIDEBAR_MAX;
  else return;
  e.preventDefault();
  const applied = setSidebarWidth(next);
  persistSidebarWidth(applied);
});
