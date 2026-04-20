import {
  invoke, convertFileSrc, appWindow,
  tabs, state,
  ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, ZOOM_DEFAULT,
  supportsHighlights, matchHighlight, currentHighlight,
  tabBarEl, tabScrollLeftEl, tabScrollRightEl, contentEl, contentScroll,
  editorPane, previewPane,
  btnReload, btnSearch, btnOutline, btnZoomIn, btnZoomOut, zoomLabel,
  btnModeToggle, btnSave, btnDiscard, editToolbar,
  filePathEl, statusIndicator, statusText,
  pickerBackdrop, WELCOME_HTML,
  hasActiveOverlay,
} from './state.js';
import { clearSearch } from './search.js';
import { syncWatcher, highlightActiveTreeItem } from './folder.js';
import { isDirty, saveActiveFile, exitEditMode, promptUnsavedChanges, promptRecoverDraft, enterEditMode, mountEditor, cancelPendingDraftWrite, getEditorValue, getEditorScrollTop } from './editor.js';
import { renderShortcutsUI, refreshTabCloseTitles } from './shortcuts-display.js';
import { readDraft, clearDraft } from './draft-store.js';

// Local images are emitted by the Rust renderer as `<img data-oxide-src="…">`
// with an absolute path. The webview can't load a raw filesystem path, so we
// rewrite it to an asset:// URL here. Remote images already carry a real `src`
// and are untouched.
export function renderContent(html) {
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

export function syncToolbar() {
  const hasTab = state.activeTabId !== null;
  const tab = activeTab();
  const editing = !!tab?.editing;
  btnReload.disabled = !hasTab || editing;
  btnSearch.disabled = !hasTab || editing;
  if (btnOutline) btnOutline.disabled = !hasTab;
  btnZoomIn.disabled  = !hasTab;
  btnZoomOut.disabled = !hasTab;
  zoomLabel.disabled  = !hasTab;
  // Hide the zoom cluster entirely until a file is loaded.
  const zoomControls = document.getElementById('zoom-controls');
  if (zoomControls) zoomControls.classList.toggle('hidden', !hasTab);

  // Mode toggle enabled only for file-backed tabs (welcome screen has
  // no file to edit). The button's icon/label flips via body.editing in CSS.
  const canToggle = hasTab && !!tab?.path;
  btnModeToggle.disabled = !canToggle;
  btnModeToggle.setAttribute('aria-pressed', editing ? 'true' : 'false');

  const dirty = editing && ((tab?.raw ?? '') !== (tab?.savedRaw ?? ''));
  btnSave.disabled = !dirty;
  if (btnDiscard) btnDiscard.disabled = !dirty;
  editToolbar.hidden = !editing;
}

export function activeTab() {
  return tabs.find(t => t.id === state.activeTabId) ?? null;
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
      const liveValue = getEditorValue();
      if (liveValue != null) {
        cur.raw = liveValue;
        cur.editorScrollTop = getEditorScrollTop();
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
    const liveValue = getEditorValue();
    if (liveValue != null) tab.raw = liveValue;
  }

  if (isDirty(tab)) {
    // Make sure the dirty tab is visible while the prompt is up so the
    // user sees which file they're deciding about.
    if (id !== state.activeTabId) switchToTab(id);
    const decision = await promptUnsavedChanges(tab);
    if (decision === 'cancel') return;
    if (decision === 'save') {
      const ok = await saveActiveFile();
      if (!ok) return;
    } else if (decision === 'discard') {
      // User explicitly threw away the in-memory edits — cancel any
      // pending debounced draft write first (otherwise it could re-write
      // the draft after we clear it), then drop the localStorage entry.
      cancelPendingDraftWrite();
      if (tab.path) clearDraft(tab.path);
    }
  }

  // If we're closing the active, editing tab, tear the editor down first.
  if (tab.editing && id === state.activeTabId) {
    exitEditMode({ keepHtml: false });
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

export async function closeAllTabs() {
  const ids = tabs.map(t => t.id);
  for (const id of ids) {
    await closeTab(id);
    if (tabs.some(t => t.id === id)) break;
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
    mountEditor(tab);
  } else {
    renderContent(tab.html);
    state.originalContent = tab.html;
  }

  appWindow.setTitle(tab.title);
  document.title = tab.title;
  setStatusFilePath(tab.path || '');
  applyZoom(tab.zoom);
  highlightActiveTreeItem();

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
  contentEl.style.fontSize = '';
  state.originalContent = '';
  appWindow.setTitle('OxideMD');
  document.title = 'OxideMD';
  setStatusFilePath('');
  zoomLabel.textContent = '100%';
  highlightActiveTreeItem();
  clearStatus();
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

export function applyZoom(zoom) {
  const tab = activeTab();
  const fontSize = `calc(var(--font-size) * ${zoom.toFixed(2)})`;
  contentEl.style.fontSize = fontSize;
  // Mirror the zoom on the live preview so Ctrl+/− affect it too.
  if (previewPane) previewPane.style.fontSize = fontSize;
  // The editor takes the full viewport width; reading-width constraints
  // are a rendered-markdown concern only.
  if (tab?.editing) {
    contentEl.style.maxWidth = 'none';
  } else {
    contentEl.style.maxWidth = `${Math.round((state.config?.reading_width ?? 800) * zoom)}px`;
  }
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  btnZoomOut.disabled = zoom <= ZOOM_MIN;
  btnZoomIn.disabled  = zoom >= ZOOM_MAX;
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

  // Title each freshly-built close button with the live closeTab binding.
  refreshTabCloseTitles();

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
  tabScrollLeftEl.hidden  = !canScrollLeft;
  tabScrollRightEl.hidden = !canScrollRight;
}

function scrollTabsBy(direction) {
  // Step ~80% of visible width so the user can see a new tab leading in
  // without losing spatial context of where they were.
  const step = Math.max(120, Math.round(tabBarEl.clientWidth * 0.8));
  tabBarEl.scrollBy({ left: direction * step, behavior: 'smooth' });
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
    if (!wasAlreadyOpen) await maybeOfferDraftRecovery(realPath, result.raw ?? '');
  } catch (e) {
    showError(String(e));
  } finally {
    clearStatus();
  }
}

// Compares the on-disk markdown against any persisted draft for this
// path. If they differ, prompts the user; on 'save' we restore the draft
// into tab.raw (savedRaw stays as disk content so isDirty=true and Save
// re-enables) and auto-enter edit mode. 'discard' clears the draft.
// 'cancel' (Escape / overlay click) leaves the draft for next time.
async function maybeOfferDraftRecovery(path, diskRaw) {
  const draft = readDraft(path);
  if (!draft) return;
  if (draft.content === diskRaw) { clearDraft(path); return; }
  const tab = tabs.find(t => t.path === path);
  if (!tab) return;
  const decision = await promptRecoverDraft(tab, draft);
  if (decision === 'save') {
    tab.raw = draft.content;
    await enterEditMode();
  } else if (decision === 'discard') {
    clearDraft(path);
  }
}

export async function reloadFile() {
  const tab = activeTab();
  if (!tab?.path) return;
  // Reloading while editing would clobber unsaved edits. The toolbar
  // already disables this button in edit mode, but guard anyway so the
  // Ctrl+R shortcut also respects it.
  if (tab.editing) return;
  setLoading();
  try {
    const result = await invoke('open_file', { path: tab.path });
    tab.html = result.html;
    tab.title = result.title;
    tab.raw = result.raw ?? '';
    tab.savedRaw = tab.raw;
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

export function setLoading() {
  statusText.textContent = 'Loading';
  statusIndicator.classList.remove('hidden');
  statusIndicator.classList.add('status-loading');
}

function setReady() {
  statusText.textContent = 'Ready';
  statusIndicator.classList.remove('hidden', 'status-loading');
}

export function clearStatus() {
  if (tabs.length === 0) {
    statusIndicator.classList.add('hidden');
    statusIndicator.classList.remove('status-loading');
  } else {
    setReady();
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
