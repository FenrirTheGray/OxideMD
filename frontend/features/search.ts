import {
  state, hasActiveOverlay,
  contentEl, contentScroll,
  searchBar, searchInput, searchCase, searchCount, btnSearch,
  searchReplaceInput,
  supportsHighlights, matchHighlight, currentHighlight,
} from "../core/state.ts";
// Edit-mode search runs through the lazily-loaded editor module; these
// helpers are only reached when isEditing(), which implies it's loaded.
// The ?? fallbacks keep a hypothetical miss harmless (zero matches).
import { editorModule } from "../editor/lazy.ts";

// The one bar drives two backends: the rendered-content highlight search in
// read mode, and CodeMirror's search (via editor.ts) in edit mode. Every
// public op branches on this. Edit-mode match counts come back from the
// editor helpers and are cached here for the "n / m" readout.
function isEditing() { return document.body.classList.contains('editing'); }
let editCount = 0;
let editCurrent = 0;

export function toggleSearch() {
  if (!searchBar.classList.contains('hidden')) { closeSearch(); return; }
  if (hasActiveOverlay()) return;
  searchBar.classList.remove('hidden');
  // aria-pressed (not .active) so the button picks up the same pressed-toggle
  // fill as the Preview/Outline toggles beside it.
  btnSearch.setAttribute('aria-pressed', 'true');
  (searchInput as HTMLInputElement).focus();
  (searchInput as HTMLInputElement).select();
}

export function closeSearch() {
  searchBar.classList.add('hidden');
  btnSearch.setAttribute('aria-pressed', 'false');
  clearSearch();
  (searchInput as HTMLInputElement).value = '';
  if (searchReplaceInput) (searchReplaceInput as HTMLInputElement).value = '';
  state.searchCaseSensitive = false;
  searchCase.classList.remove('active');
  searchCase.setAttribute('aria-pressed', 'false');
}

export function clearSearch() {
  state.searchRanges = [];
  state.searchCurrent = -1;
  if (supportsHighlights) {
    matchHighlight.clear();
    currentHighlight.clear();
  }
  editCount = 0;
  editCurrent = 0;
  if (isEditing()) editorModule()?.editorClearSearch();
  searchCount.textContent = '';
}

export function runSearch(query) {
  if (isEditing()) {
    editCount = editorModule()?.editorSetSearch(query, state.searchCaseSensitive) ?? 0;
    editCurrent = 0;
    updateSearchCount();
    return;
  }
  clearSearch();
  if (!query) return;

  const needle = state.searchCaseSensitive ? query : query.toLowerCase();
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  let tn;
  while ((tn = walker.nextNode())) {
    const text = tn.nodeValue;
    const haystack = state.searchCaseSensitive ? text : text.toLowerCase();
    let idx = 0;
    while (idx < text.length) {
      const pos = haystack.indexOf(needle, idx);
      if (pos === -1) break;
      const range = document.createRange();
      range.setStart(tn, pos);
      range.setEnd(tn, pos + query.length);
      state.searchRanges.push(range);
      idx = pos + query.length;
    }
  }

  if (supportsHighlights) {
    for (const r of state.searchRanges) matchHighlight.add(r);
  }

  if (state.searchRanges.length > 0) {
    state.searchCurrent = 0;
    highlightCurrent();
  }
  updateSearchCount();
}

function highlightCurrent() {
  if (!supportsHighlights) return;
  currentHighlight.clear();
  const range = state.searchRanges[state.searchCurrent];
  if (!range) return;
  currentHighlight.add(range);
  const rect = range.getBoundingClientRect();
  const scrollRect = contentScroll.getBoundingClientRect();
  const target =
    contentScroll.scrollTop
    + rect.top
    - scrollRect.top
    - scrollRect.height / 2
    + rect.height / 2;
  contentScroll.scrollTo({ top: target, behavior: 'smooth' });
}

export function nextMatch() {
  if (isEditing()) {
    ({ count: editCount, current: editCurrent } = editorModule()?.editorNextMatch() ?? { count: 0, current: 0 });
    updateSearchCount();
    return;
  }
  if (!state.searchRanges.length) return;
  state.searchCurrent = (state.searchCurrent + 1) % state.searchRanges.length;
  highlightCurrent();
  updateSearchCount();
}

export function prevMatch() {
  if (isEditing()) {
    ({ count: editCount, current: editCurrent } = editorModule()?.editorPrevMatch() ?? { count: 0, current: 0 });
    updateSearchCount();
    return;
  }
  if (!state.searchRanges.length) return;
  state.searchCurrent = (state.searchCurrent - 1 + state.searchRanges.length) % state.searchRanges.length;
  highlightCurrent();
  updateSearchCount();
}

// Replace handlers — edit mode only (read mode is find-only; the replace row
// is hidden there). Driven by app.ts from the replace row's controls.
export function replaceCurrent() {
  if (!isEditing()) return;
  ({ count: editCount, current: editCurrent } = editorModule()?.editorReplaceMatch(
    (searchInput as HTMLInputElement).value,
    (searchReplaceInput as HTMLInputElement).value,
    state.searchCaseSensitive,
  ) ?? { count: 0, current: 0 });
  updateSearchCount();
}

export function replaceAllMatches() {
  if (!isEditing()) return;
  ({ count: editCount, current: editCurrent } = editorModule()?.editorReplaceAllMatches(
    (searchInput as HTMLInputElement).value,
    (searchReplaceInput as HTMLInputElement).value,
    state.searchCaseSensitive,
  ) ?? { count: 0, current: 0 });
  updateSearchCount();
}

function updateSearchCount() {
  if (isEditing()) {
    searchCount.textContent = editCount
      ? (editCurrent ? `${editCurrent} / ${editCount}` : `${editCount} match${editCount === 1 ? '' : 'es'}`)
      : ((searchInput as HTMLInputElement).value ? 'No matches' : '');
    return;
  }
  searchCount.textContent = state.searchRanges.length
    ? `${state.searchCurrent + 1} / ${state.searchRanges.length}`
    : ((searchInput as HTMLInputElement).value ? 'No matches' : '');
}
