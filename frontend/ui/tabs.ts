import {
  invoke, appWindow,
  tabs, state,
  ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, ZOOM_DEFAULT,
  tabBarEl, tabScrollLeftEl, tabScrollRightEl, contentEl, contentScroll,
  editorPane, previewPane,
  btnReload, btnSearch, btnOutline, btnPreview, btnZoomIn, btnZoomOut, zoomLabel,
  btnModeToggle, btnSave, btnDiscard, btnPrint, editToolbar,
  filePathEl,
  pickerBackdrop, WELCOME_HTML,
  hasActiveOverlay,
} from "../core/state.ts";
import { clearSearch, closeSearch } from "../features/search.ts";
import { syncWatcher, highlightActiveTreeItem } from "./folder.ts";
import { editorModule, loadEditorModule } from "../editor/lazy.ts";
import { promptUnsavedChanges, promptRecoverDraft } from "./confirm.ts";
import { updateCounts, clearCounts } from "./counts.ts";
import {
  activeTab, isDirty, isPreviewVisible,
  renderContent, setLoading, clearStatus, applyZoom,
} from "../core/tab-state.ts";
// Re-export the seam primitives that other modules still import from
// tabs.js (settings.js, folder.js, print.js, app.js) so their imports
// don't change after the move to tab-state.js.
export {
  activeTab, renderContent, setLoading, clearStatus, applyZoom,
} from "../core/tab-state.ts";
import { isOutlineOpen, refreshOutline, applyOutlineVisibility } from "./outline.ts";
import { renderShortcutsUI, refreshTabCloseTitles } from "./shortcuts-display.ts";
import { readDraft, clearDraft } from "../core/draft-store.ts";
import { showErrorModal } from "./error-modal.ts";

export function syncToolbar() {
  const hasTab = state.activeTabId !== null;
  const tab = activeTab();
  const editing = !!tab?.editing;
  const dirty = isDirty(tab);
  // Reload is blocked whenever it would clobber unsaved work: while editing,
  // and for a buffer that exited edit mode still dirty.
  (btnReload as HTMLButtonElement).disabled = !hasTab || editing || dirty;
  // Search works in both modes now (the unified #search-bar drives CodeMirror
  // in edit mode), so it's enabled whenever a tab is open.
  (btnSearch as HTMLButtonElement).disabled = !hasTab;
  // Preview + Outline are independent toggles now (no mode swap on the
  // outline button). Preview is edit-mode only; Outline is always usable
  // while a tab is loaded. aria-pressed drives the active-state styling.
  if (btnPreview) {
    (btnPreview as HTMLButtonElement).disabled = !editing;
    const previewing = editing && isPreviewVisible();
    btnPreview.setAttribute('aria-pressed', previewing ? 'true' : 'false');
    btnPreview.setAttribute('aria-label', previewing ? 'Hide preview pane' : 'Show preview pane');
    btnPreview.title = previewing ? 'Hide preview pane' : 'Show preview pane';
  }
  if (btnOutline) {
    (btnOutline as HTMLButtonElement).disabled = !hasTab;
    const open = isOutlineOpen();
    btnOutline.setAttribute('aria-pressed', open ? 'true' : 'false');
    btnOutline.setAttribute('aria-label', open ? 'Hide document outline' : 'Show document outline');
    btnOutline.title = open ? 'Hide document outline' : 'Show document outline';
  }
  // Printing works in both read and edit mode — print.js renders the
  // live buffer fresh — so this only gates on having a tab at all.
  (btnPrint as HTMLButtonElement).disabled = !hasTab;
  (btnZoomIn as HTMLButtonElement).disabled  = !hasTab;
  (btnZoomOut as HTMLButtonElement).disabled = !hasTab;
  (zoomLabel as HTMLButtonElement).disabled  = !hasTab;
  // Hide the zoom cluster entirely until a file is loaded.
  const zoomControls = document.getElementById('zoom-controls');
  if (zoomControls) zoomControls.classList.toggle('hidden', !hasTab);

  // Mode toggle enabled only for file-backed tabs. Untitled (new) tabs
  // stay locked in edit mode until their first save — their read view
  // would be an empty, never-rendered document — so the toggle is disabled
  // for them (no path). aria-pressed drives the pressed visual.
  const canToggle = hasTab && !!tab?.path;
  (btnModeToggle as HTMLButtonElement).disabled = !canToggle;
  btnModeToggle.setAttribute('aria-pressed', editing ? 'true' : 'false');

  (btnSave as HTMLButtonElement).disabled = !dirty;
  if (btnDiscard) (btnDiscard as HTMLButtonElement).disabled = !dirty;
  editToolbar.hidden = !editing;
}

// Single choke point for the chrome that derives from the active tab + edit
// state: the toolbar buttons, the tab bar, and the outline sidebar. Call
// this after any mutation to tabs / activeTabId / edit mode so the three
// can't drift out of sync — replaces the scattered
// `syncToolbar(); renderTabBar(); refreshOutline();` triples.
export function rerender() {
  syncToolbar();
  renderTabBar();
  refreshOutline();
}

export function openInNewTab(path, title, html, raw = null) {
  // Switch to existing tab if this path is already open
  if (path) {
    const existing = tabs.find(t => t.path === path);
    if (existing) {
      switchToTab(existing.id);
      return;
    }
  }
  const id = state.nextTabId++;
  tabs.push({
    id, path, title, html,
    raw: raw ?? '',
    savedRaw: raw ?? '',
    editing: false,
    scrollTop: 0,
    zoom: ZOOM_DEFAULT,
  });
  state.activeTabId = id;
  syncToolbar();
  renderTabBar();
  applyActiveTab();
  syncWatcher();
}

export function switchToTab(id) {
  // Save scroll position of current tab before leaving. When leaving an
  // editor, capture the current buffer value and both pane scroll
  // positions so returning to this tab doesn't lose in-flight edits or
  // jump the scroll state.
  const cur = activeTab();
  if (cur) {
    if (cur.editing) {
      const liveValue = editorModule()?.getEditorValue() ?? null;
      if (liveValue != null) {
        cur.raw = liveValue;
        cur.editorScrollTop = editorModule()?.getEditorScrollTop() ?? 0;
        cur.editorSelection = editorModule()?.getEditorSelectionHead() ?? 0;
        // Preserve the full CM state (undo history + selection) so returning
        // to this tab restores it instead of rebuilding from the string.
        cur.editorState = editorModule()?.getEditorState() ?? undefined;
      }
      cur.previewScrollTop = previewPane.scrollTop;
    } else {
      cur.scrollTop = contentScroll.scrollTop;
    }
  }

  state.activeTabId = id;
  clearSearch();
  renderTabBar();
  applyActiveTab();
  syncToolbar();
}

export async function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];

  // Capture pending edits from the live editor into the tab buffer so
  // isDirty() sees the user's latest keystrokes, not a stale snapshot.
  if (tab.editing && id === state.activeTabId) {
    const liveValue = editorModule()?.getEditorValue() ?? null;
    if (liveValue != null) tab.raw = liveValue;
  }

  if (isDirty(tab)) {
    // Make sure the dirty tab is visible while the prompt is up so the
    // user sees which file they're deciding about.
    if (id !== state.activeTabId) switchToTab(id);
    const decision = await promptUnsavedChanges(tab);
    if (decision === 'cancel') return;
    if (decision === 'save') {
      const ok = (await editorModule()?.saveActiveFile()) ?? false;
      if (!ok) return;
    } else if (decision === 'discard') {
      // User explicitly threw away the in-memory edits — cancel any
      // pending debounced draft write first (otherwise it could re-write
      // the draft after we clear it), then drop the localStorage entry.
      editorModule()?.cancelPendingDraftWrite();
      if (tab.path) clearDraft(tab.path);
    }
  }

  // If we're closing the active, editing tab, tear the editor down first.
  if (tab.editing && id === state.activeTabId) {
    editorModule()?.exitEditMode({ keepHtml: false });
  }

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
    renderTabBar();
    applyActiveTab();
    syncToolbar();
  } else {
    renderTabBar();
  }
}

// Forget every tab backing a path that was just deleted from disk (a
// single file, or any file inside a deleted folder). Unlike closeTab this
// never prompts to save — the file is gone, so "save" would only recreate
// it — and it drops any persisted draft too. Called after a successful
// delete from the tree context menu.
export function dropTabsForDeletedPath(deletedPath) {
  if (!deletedPath) return;
  const isAffected = (p) =>
    !!p && (p === deletedPath
      || p.startsWith(deletedPath + '/')
      || p.startsWith(deletedPath + '\\'));
  const affected = tabs.filter(t => isAffected(t.path));
  if (!affected.length) return;
  const activeAffected = affected.some(t => t.id === state.activeTabId);

  // Tear down the live editor first if the active tab is among the dropped.
  const cur = activeTab();
  if (cur && cur.editing && isAffected(cur.path)) {
    editorModule()?.cancelPendingDraftWrite();
    editorModule()?.exitEditMode({ keepHtml: false });
  }

  for (const t of affected) {
    if (t.path) clearDraft(t.path);
    const idx = tabs.findIndex(x => x.id === t.id);
    if (idx !== -1) tabs.splice(idx, 1);
  }
  syncWatcher();

  if (tabs.length === 0) {
    state.activeTabId = null;
    clearSearch();
    syncToolbar();
    renderTabBar();
    showWelcome();
  } else if (activeAffected) {
    state.activeTabId = tabs[tabs.length - 1].id;
    clearSearch();
    renderTabBar();
    applyActiveTab();
    syncToolbar();
  } else {
    renderTabBar();
  }
}

// Point open tabs at a path's new location after an on-disk rename —
// the renamed entry itself and, for a folder, everything inside it.
// Only path/title metadata changes; buffers and edit state are kept.
// The filesystem watcher refreshes the sidebar tree on its own.
export function retargetTabsForRenamedPath(oldPath, newPath) {
  if (!oldPath || !newPath) return;
  let changed = false;
  for (const t of tabs) {
    if (!t.path) continue;
    if (t.path === oldPath) {
      t.path = newPath;
    } else if (t.path.startsWith(oldPath + '/') || t.path.startsWith(oldPath + '\\')) {
      t.path = newPath + t.path.slice(oldPath.length);
    } else {
      continue;
    }
    t.title = t.path.split(/[\\/]/).pop() || t.title;
    changed = true;
  }
  if (!changed) return;
  syncWatcher();
  renderTabBar();
  const tab = activeTab();
  if (tab?.path) {
    appWindow.setTitle(tab.title);
    document.title = tab.title;
    setStatusFilePath(tab.path);
  }
}

// Close every tab except `keepId`. Iterates sequentially so each dirty
// tab gets its own unsaved-changes prompt; if `closeTab` cancels or
// fails, the tab stays in `tabs` and we bail out of the loop.
export async function closeOtherTabs(keepId) {
  const ids = tabs.filter(t => t.id !== keepId).map(t => t.id);
  for (const id of ids) {
    await closeTab(id);
    if (tabs.some(t => t.id === id)) break;
  }
}

// Close all = close all "other" tabs with no tab kept.
export const closeAllTabs = () => closeOtherTabs(null);

// Close every tab after `id` in tab-bar order. Same sequential prompt
// behavior as closeOtherTabs: a cancelled unsaved-changes prompt stops
// the sweep.
export async function closeTabsToRight(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const ids = tabs.slice(idx + 1).map(t => t.id);
  for (const tid of ids) {
    await closeTab(tid);
    if (tabs.some(t => t.id === tid)) break;
  }
}

export function applyActiveTab() {
  const tab = activeTab();
  if (!tab) { showWelcome(); return; }

  // Body-level flag drives the edit toolbar visibility and split layout;
  // keep it in sync whenever we render a tab (switching between
  // editing/non-editing tabs).
  document.body.classList.toggle('editing', tab.editing);

  if (tab.editing) {
    // Rebuild the split so it reflects this tab's raw buffer and
    // preview state (another tab may have been editing its own buffer).
    // mountEditor() refreshes the status-bar counts itself. The editor
    // module is loaded by everything that flips a tab to editing, except
    // createNewFile from a cold start — load it on demand then; the pane
    // stays blank for the import beat and mounts as soon as it lands.
    const em = editorModule();
    if (em) {
      em.mountEditor(tab);
    } else {
      loadEditorModule().then((m) => {
        const cur = activeTab();
        if (cur && cur.id === tab.id && cur.editing) m.mountEditor(cur);
      });
    }
  } else {
    renderContent(tab.html);
    // Read mode: counts come from the tab's raw markdown source. Runs on
    // every tab switch and on exiting edit mode (both route through here).
    updateCounts(tab.raw ?? '', '');
  }

  appWindow.setTitle(tab.title);
  document.title = tab.title;
  setStatusFilePath(tab.path || '');
  applyZoom(tab.zoom);
  highlightActiveTreeItem();
  // Keep the outline sidebar in sync with whichever document is now
  // active. Restore the persisted open state too — entering a file from
  // the welcome screen should bring the panel back if the user had it
  // open last session.
  applyOutlineVisibility();
  refreshOutline();

  if (!tab.editing) {
    requestAnimationFrame(() => {
      contentScroll.scrollTop = tab.scrollTop;
    });
  }
}

export function showWelcome() {
  contentEl.innerHTML = WELCOME_HTML;
  // Welcome's shortcut chips and hero key spans are empty in the static
  // HTML — fill them from the registry so platform symbols and any user
  // rebinds are reflected.
  renderShortcutsUI();
  renderRecentFiles();
  contentEl.style.fontSize = '';
  appWindow.setTitle('OxideMD');
  document.title = 'OxideMD';
  setStatusFilePath('');
  // No active document — blank the status-bar counts.
  clearCounts();
  zoomLabel.textContent = '100%';
  highlightActiveTreeItem();
  clearStatus();
  // No active document — hide the outline sidebar without touching the
  // persisted preference, so opening a file again restores it. Then
  // clear the outline list (no-op while hidden).
  applyOutlineVisibility();
  refreshOutline();
}

export function setStatusFilePath(path) {
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

export function zoomIn() {
  const tab = activeTab();
  if (!tab) return;
  tab.zoom = Math.min(ZOOM_MAX, parseFloat((tab.zoom + ZOOM_STEP).toFixed(2)));
  applyZoom(tab.zoom);
}

export function zoomOut() {
  const tab = activeTab();
  if (!tab) return;
  tab.zoom = Math.max(ZOOM_MIN, parseFloat((tab.zoom - ZOOM_STEP).toFixed(2)));
  applyZoom(tab.zoom);
}

export function resetZoom() {
  const tab = activeTab();
  if (!tab) return;
  tab.zoom = ZOOM_DEFAULT;
  applyZoom(tab.zoom);
}

export function renderTabBar() {
  tabBarEl.innerHTML = '';

  if (tabs.length === 0) return;

  for (const tab of tabs) {
    const isActive = tab.id === state.activeTabId;
    const dirty = isDirty(tab);
    const el = document.createElement('div');
    el.className = 'tab' + (isActive ? ' active' : '') + (dirty ? ' dirty' : '');
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
    // Title is set per-binding by renderShortcutsUI() right after this loop.

    el.appendChild(titleSpan);
    el.appendChild(closeBtn);
    tabBarEl.appendChild(el);

    el.addEventListener('click', (e) => {
      if (!(e.target as Element).closest('.tab-close')) switchToTab(tab.id);
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
  }

  // Scroll active tab into view
  const activeEl = tabBarEl.querySelector('.tab.active');
  if (activeEl) activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });

  // Title each freshly-built close button with the live closeTab binding.
  refreshTabCloseTitles();

  updateTabOverflow();
}

tabBarEl.addEventListener('keydown', (e) => {
  const targetTab = (e.target as Element).closest('.tab');
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
    const id = Number((targetTab as HTMLElement).dataset.tabId);
    if (!Number.isNaN(id)) {
      closeTab(id);
      const newActive = tabBarEl.querySelector('.tab.active') as HTMLElement;
      if (newActive) newActive.focus();
    }
    return;
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const id = Number((targetTab as HTMLElement).dataset.tabId);
    if (!Number.isNaN(id)) switchToTab(id);
    return;
  } else {
    return;
  }

  e.preventDefault();
  const nextTab = allTabs[nextIdx];
  const id = Number((nextTab as HTMLElement).dataset.tabId);
  if (!Number.isNaN(id)) switchToTab(id);
  (nextTab as HTMLElement).focus();
});

export function updateTabOverflow() {
  const hasOverflow = tabBarEl.scrollWidth > tabBarEl.clientWidth;
  if (!hasOverflow) {
    tabBarEl.classList.remove('has-overflow-left', 'has-overflow-right');
    tabScrollLeftEl.hidden = true;
    tabScrollRightEl.hidden = true;
    return;
  }
  const scrollLeft = tabBarEl.scrollLeft;
  const maxScroll = tabBarEl.scrollWidth - tabBarEl.clientWidth;
  const canScrollLeft  = scrollLeft > 2;
  const canScrollRight = scrollLeft < maxScroll - 2;
  tabBarEl.classList.toggle('has-overflow-left', canScrollLeft);
  tabBarEl.classList.toggle('has-overflow-right', canScrollRight);
  // Keep both buttons mounted whenever tabs overflow; disable the one at
  // its scroll edge instead of hiding it so the control strip doesn't
  // shift as the user scrolls.
  tabScrollLeftEl.hidden   = false;
  tabScrollRightEl.hidden  = false;
  (tabScrollLeftEl as HTMLButtonElement).disabled  = !canScrollLeft;
  (tabScrollRightEl as HTMLButtonElement).disabled = !canScrollRight;
}

function scrollTabsBy(direction) {
  // Advance by exactly one tab: find the first tab whose edge is clipped
  // by the viewport on the target side and scroll it into view against
  // that edge. Tab widths vary (min 84, max 210), so work from live rects.
  const tabs = Array.from(tabBarEl.querySelectorAll('.tab'));
  if (!tabs.length) return;
  const area = tabBarEl.getBoundingClientRect();

  if (direction > 0) {
    const next = tabs.find(t => t.getBoundingClientRect().right > area.right + 1);
    if (!next) return;
    const delta = next.getBoundingClientRect().right - area.right;
    tabBarEl.scrollBy({ left: delta, behavior: 'smooth' });
  } else {
    let prev = null;
    for (const t of tabs) {
      if (t.getBoundingClientRect().left < area.left - 1) prev = t;
      else break;
    }
    if (!prev) return;
    const delta = prev.getBoundingClientRect().left - area.left;
    tabBarEl.scrollBy({ left: delta, behavior: 'smooth' });
  }
}

tabScrollLeftEl.addEventListener('click', () => scrollTabsBy(-1));
tabScrollRightEl.addEventListener('click', () => scrollTabsBy(1));

tabBarEl.addEventListener('scroll', updateTabOverflow);
window.addEventListener('resize', updateTabOverflow);

export async function loadFile(path) {
  setLoading();
  try {
    const result = await invoke('open_file', { path });
    const realPath = result.path || path;
    // A draft is only worth offering on first-open of a path: re-clicking
    // an already-open tab just switches to it and shouldn't re-prompt.
    const wasAlreadyOpen = !!tabs.find(t => t.path === realPath);
    openInNewTab(realPath, result.title, result.html, result.raw ?? '');
    invoke('mark_recent_file', { path: realPath })
      .then(applyRecentFiles)
      .catch(() => {});
    invoke('file_sha256', { path: realPath })
      .then((hash) => {
        const tab = tabs.find(t => t.path === realPath);
        if (tab) tab.diskHash = hash;
      })
      .catch(() => {});
    if (!wasAlreadyOpen) await maybeOfferDraftRecovery(realPath, result.raw ?? '');
  } catch (e) {
    showErrorModal('Could not open file', 'An error occurred while opening the file.', e);
  } finally {
    clearStatus();
  }
}

// Compares the on-disk markdown against any persisted draft for this
// path. If they differ, prompts the user; on 'save' we restore the draft
// into tab.raw (savedRaw stays as disk content so isDirty=true and Save
// re-enables) and auto-enter edit mode. 'discard' clears the draft.
// 'cancel' (Escape / overlay click) leaves the draft for next time.
//
// If the on-disk hash differs from the hash recorded when the draft was
// last written, the disk content has changed since the draft was saved
// — likely an external edit. We pass that signal through to
// promptRecoverDraft so the dialog can warn the user before they choose
// to overwrite the newer disk content with their (older) draft.
async function maybeOfferDraftRecovery(path, diskRaw) {
  const draft = await readDraft(path);
  if (!draft) return;
  if (draft.content === diskRaw) { clearDraft(path); return; }
  const tab = tabs.find(t => t.path === path);
  if (!tab) return;
  let conflict = false;
  if (draft.diskHashAtWrite) {
    try {
      const liveHash = await invoke('file_sha256', { path });
      if (liveHash && liveHash !== draft.diskHashAtWrite) conflict = true;
    } catch {}
  }
  const decision = await promptRecoverDraft(tab, draft, { conflict });
  if (decision === 'save') {
    tab.raw = draft.content;
    tab.editorState = undefined; // buffer replaced — rebuild CM state from it
    await (await loadEditorModule()).enterEditMode();
  } else if (decision === 'discard') {
    clearDraft(path);
  }
}

// ── Recent files ──────────────────────────────────────────────────────
// Rendered into the welcome screen's #welcome-recent panel. The Rust
// command returns the cap-trimmed list; we just paint it.
export function applyRecentFiles(entries) {
  state.recentFiles = Array.isArray(entries) ? entries : [];
  renderRecentFiles();
}

function renderRecentFiles() {
  const root = document.getElementById('welcome-recent');
  const list = document.getElementById('welcome-recent-list');
  if (!root || !list) return;
  // Gated by the General-tab toggle. Entries still accrue in the
  // background while hidden, so flipping it back on shows the existing
  // list without needing to reopen files.
  if (state.config?.show_recent_files === false) {
    root.hidden = true;
    list.innerHTML = '';
    return;
  }
  const entries = state.recentFiles ?? [];
  if (entries.length === 0) { root.hidden = true; list.innerHTML = ''; return; }
  root.hidden = false;
  list.innerHTML = '';
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'welcome-recent-item' + (entry.exists ? '' : ' missing');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'welcome-recent-link';
    open.dataset.path = entry.path;
    open.title = entry.path;
    const name = document.createElement('span');
    name.className = 'welcome-recent-name';
    name.textContent = entry.name;
    const dir = document.createElement('span');
    dir.className = 'welcome-recent-dir';
    dir.textContent = parentDir(entry.path);
    open.appendChild(name);
    open.appendChild(dir);
    li.appendChild(open);
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'welcome-recent-forget';
    forget.dataset.path = entry.path;
    forget.setAttribute('aria-label', `Remove ${entry.name} from recent files`);
    forget.title = 'Remove from recent';
    forget.innerHTML = '✕';
    li.appendChild(forget);
    list.appendChild(li);
  }
}

export function parentDir(p) {
  if (!p) return '';
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? '' : p.slice(0, idx);
}

export async function reloadFile() {
  const tab = activeTab();
  if (!tab?.path) return;
  // Reloading would clobber unsaved edits — while editing, or after exiting
  // edit mode with a still-dirty buffer. The toolbar already disables the
  // button in those states, but guard anyway so Ctrl+R also respects it.
  if (tab.editing || isDirty(tab)) return;
  setLoading();
  try {
    const result = await invoke('open_file', { path: tab.path });
    tab.html = result.html;
    tab.title = result.title;
    tab.raw = result.raw ?? '';
    tab.savedRaw = tab.raw;
    tab.editorState = undefined; // disk content changed — drop stale CM state
    applyActiveTab();
    renderTabBar();
  } catch (e) {
    showErrorModal('Could not open file', 'An error occurred while opening the file.', e);
  } finally {
    clearStatus();
  }
}


// Links are handled via a single delegated listener on contentEl (installed
// near the other contentEl delegation at the bottom of app.js). That means we
// don't attach a per-anchor listener after every innerHTML rewrite, which
// used to both churn listeners and stop working when search mutated the DOM.
export async function handleAnchorClick(anchor) {
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

export async function openFilePicker() {
  closeSearch(); // dismiss the inline search bar so it doesn't block the picker
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

// Create a brand-new Markdown file. Rather than prompting for a location
// up front, this opens a blank, path-less ("untitled") tab straight into
// edit mode so the user can start typing immediately. Nothing is written
// to disk until they trigger a save — at which point saveActiveFile()
// shows the save dialog (rooted at `newFileDir` when one was passed, e.g.
// the folder tree's "New File…") and adopts the chosen path. Closing the
// tab with unsaved content routes through the normal unsaved-changes
// (discard) prompt. `dir` is remembered so the eventual save dialog opens
// in the right place.
export function createNewFile(dir = null) {
  closeSearch(); // dismiss the inline search bar so it doesn't block new-file
  if (hasActiveOverlay()) return;
  const id = state.nextTabId++;
  tabs.push({
    id, path: null, title: 'Untitled',
    html: '', raw: '', savedRaw: '',
    editing: true, isNew: true, newFileDir: dir || null,
    scrollTop: 0, zoom: ZOOM_DEFAULT,
  });
  state.activeTabId = id;
  // applyActiveTab mounts the editor (tab.editing === true) and flips the
  // body `editing` class; rerender refreshes the toolbar, tab bar, and
  // outline for the new active tab.
  applyActiveTab();
  rerender();
  syncWatcher();
}
