// Project-wide search panel. While the folder tree shows file *names*,
// this panel greps the *contents* of every Markdown file in the open
// folder via the `search_project` Rust command and lists file-grouped
// results; clicking a result opens that file in a tab.
//
// It lives inside the sidebar: a looking-glass toggle in the sidebar
// header swaps the sidebar body between the tree view and this search
// view, so the folder-tree UX is left completely untouched. Only
// available when a folder is open — the toggle is hidden otherwise.

import {
  invoke, state,
  sidebarTreeEl,
  sidebarSearchToggle, sidebarSearchPanel,
  sidebarSearchInput, sidebarSearchClearBtn, sidebarSearchResultsEl,
} from "../core/state.ts";
import { loadFile } from "../ui/tabs.ts";
import { closeFilterMode } from "../ui/folder.ts";
import { enterEditMode, revealEditorLine } from "../editor/editor.ts";

const SVG_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

// Debounce window before a keystroke triggers a folder-wide scan — long
// enough to coalesce fast typing, short enough to feel responsive.
const SEARCH_DEBOUNCE = 180;
let searchTimer = null;
// Monotonic token so a slow scan that resolves after a newer one was
// kicked off can't overwrite the fresher results.
let searchSeq = 0;
let panelOpen = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Whether the project-search toggle should be available at all: only
// when a folder is open. Called by folder.js on open/close.
export function updateProjectSearchAvailability() {
  const enabled = !!state.currentFolder;
  if (sidebarSearchToggle) sidebarSearchToggle.classList.toggle('hidden', !enabled);
  if (!enabled && panelOpen) closeProjectSearch();
}

// Render the search line text with the matched substring wrapped in a
// <mark>, mirroring folder.js's renderHighlightedLabel. The query is a
// plain (non-regex) case-insensitive substring, matching the backend.
function renderMatchLine(container, text, query) {
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  let idx = lower.indexOf(q);
  if (idx === -1 || !q) { container.textContent = text; return; }
  container.textContent = '';
  let pos = 0;
  while (idx !== -1) {
    if (idx > pos) container.appendChild(document.createTextNode(text.slice(pos, idx)));
    const mark = document.createElement('mark');
    mark.className = 'tree-match';
    mark.textContent = text.slice(idx, idx + q.length);
    container.appendChild(mark);
    pos = idx + q.length;
    idx = lower.indexOf(q, pos);
  }
  if (pos < text.length) container.appendChild(document.createTextNode(text.slice(pos)));
}

function showMessage(msg) {
  sidebarSearchResultsEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'tree-empty';
  empty.textContent = msg;
  sidebarSearchResultsEl.appendChild(empty);
}

function renderResults(data, query) {
  sidebarSearchResultsEl.innerHTML = '';
  if (!data.results.length) {
    showMessage('No matches in this folder.');
    return;
  }

  for (const file of data.results) {
    const group = document.createElement('div');
    group.className = 'search-group';

    const header = document.createElement('div');
    header.className = 'search-group-header';
    header.title = file.path;
    const icon = document.createElement('span');
    icon.className = 'search-group-icon';
    icon.innerHTML = SVG_FILE;
    header.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'search-group-name';
    name.textContent = file.name;
    header.appendChild(name);
    const count = document.createElement('span');
    count.className = 'search-group-count';
    count.textContent = String(file.matches.length);
    header.appendChild(count);
    group.appendChild(header);

    for (const m of file.matches) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-result-row';
      row.title = file.path;
      const ln = document.createElement('span');
      ln.className = 'search-result-line';
      ln.textContent = String(m.line_number);
      row.appendChild(ln);
      const text = document.createElement('span');
      text.className = 'search-result-text';
      renderMatchLine(text, m.line_text, query);
      row.appendChild(text);
      row.addEventListener('click', () => { openResult(file.path, m.line_number, query); });
      group.appendChild(row);
    }

    sidebarSearchResultsEl.appendChild(group);
  }

  if (data.truncated) {
    const hint = document.createElement('div');
    hint.className = 'tree-truncated';
    hint.textContent = 'Too many matches — results truncated.';
    sidebarSearchResultsEl.appendChild(hint);
  }
}

// Open the file behind a clicked result and jump to the hit: drop into
// edit mode (where source line numbers line up with the backend's match
// lines) and select the matched text on that row. The double rAF lets the
// editor finish mounting (and its own scroll-restore run) before we
// scroll the match into view, so our reveal isn't immediately overridden.
async function openResult(path, line, query) {
  await loadFile(path);
  await enterEditMode();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    revealEditorLine(line, query);
  }));
}

async function runProjectSearch(query) {
  const root = state.currentFolder?.root;
  if (!root) { showMessage('Open a folder to search across files.'); return; }
  const trimmed = (query || '').trim();
  if (!trimmed) { sidebarSearchResultsEl.innerHTML = ''; return; }

  const seq = ++searchSeq;
  showMessage('Searching…');
  try {
    const data = await invoke('search_project', { query: trimmed, root });
    if (seq !== searchSeq) return; // a newer search superseded this one
    renderResults(data, trimmed);
  } catch (e) {
    if (seq !== searchSeq) return;
    showMessage(`Search failed: ${escapeHtml(String(e))}`);
  }
}

function scheduleSearch(query) {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { searchTimer = null; runProjectSearch(query); }, SEARCH_DEBOUNCE);
}

export function openProjectSearch() {
  if (!state.currentFolder) return;
  panelOpen = true;
  closeFilterMode(); // mutual exclusion with the name filter
  sidebarTreeEl.classList.add('hidden');
  sidebarSearchPanel.classList.remove('hidden');
  if (sidebarSearchToggle) {
    sidebarSearchToggle.classList.add('active');
    sidebarSearchToggle.setAttribute('aria-pressed', 'true');
  }
  (sidebarSearchInput as HTMLInputElement).focus();
  (sidebarSearchInput as HTMLInputElement).select();
}

export function closeProjectSearch() {
  panelOpen = false;
  sidebarSearchPanel.classList.add('hidden');
  sidebarTreeEl.classList.remove('hidden');
  if (sidebarSearchToggle) {
    sidebarSearchToggle.classList.remove('active');
    sidebarSearchToggle.setAttribute('aria-pressed', 'false');
  }
  // Reset the panel so a later reopen (e.g. after closing/reopening a
  // folder) starts clean rather than showing a stale query + results.
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  searchSeq++; // cancel any in-flight search
  if (sidebarSearchInput) (sidebarSearchInput as HTMLInputElement).value = '';
  if (sidebarSearchClearBtn) sidebarSearchClearBtn.classList.add('hidden');
  sidebarSearchResultsEl.innerHTML = '';
}

export function toggleProjectSearch() {
  if (!state.currentFolder) return;
  if (panelOpen) closeProjectSearch();
  else openProjectSearch();
}

if (sidebarSearchToggle) {
  sidebarSearchToggle.addEventListener('click', toggleProjectSearch);
}

if (sidebarSearchInput) {
  sidebarSearchInput.addEventListener('input', () => {
    const v = (sidebarSearchInput as HTMLInputElement).value;
    if (sidebarSearchClearBtn) sidebarSearchClearBtn.classList.toggle('hidden', v === '');
    scheduleSearch(v);
  });
  sidebarSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeProjectSearch();
    }
  });
}

if (sidebarSearchClearBtn) {
  sidebarSearchClearBtn.addEventListener('click', () => {
    (sidebarSearchInput as HTMLInputElement).value = '';
    sidebarSearchClearBtn.classList.add('hidden');
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    searchSeq++; // cancel any in-flight search
    sidebarSearchResultsEl.innerHTML = '';
    sidebarSearchInput.focus();
  });
}
