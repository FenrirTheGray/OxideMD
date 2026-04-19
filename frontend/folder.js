import {
  invoke, isPathInside,
  tabs, expandedFolders, state,
  contentScroll,
  pickerBackdrop,
  sidebarEl, sidebarFolderName, sidebarTreeEl,
  hasActiveOverlay,
} from './state.js';
import { activeTab, loadFile, renderContent } from './tabs.js';

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

export async function openFolder() {
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

export function setFolder(tree) {
  state.currentFolder = tree;
  expandedFolders.clear();
  sidebarFolderName.textContent = tree.name || tree.root;
  sidebarFolderName.title = tree.root;
  sidebarEl.classList.remove('hidden');
  renderFolderTree();
  syncWatcher();
}

export function closeFolder() {
  state.currentFolder = null;
  expandedFolders.clear();
  sidebarTreeEl.innerHTML = '';
  sidebarFolderName.textContent = '';
  sidebarFolderName.title = '';
  sidebarEl.classList.add('hidden');
  syncWatcher();
}

export function renderFolderTree() {
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
