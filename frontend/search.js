import {
  state, hasActiveOverlay,
  contentEl, contentScroll,
  searchBar, searchInput, searchCase, searchCount, btnSearch,
  supportsHighlights, matchHighlight, currentHighlight,
} from './state.js';

export function toggleSearch() {
  if (!searchBar.classList.contains('hidden')) { closeSearch(); return; }
  if (hasActiveOverlay()) return;
  searchBar.classList.remove('hidden');
  btnSearch.classList.add('active');
  searchInput.focus();
  searchInput.select();
}

export function closeSearch() {
  searchBar.classList.add('hidden');
  btnSearch.classList.remove('active');
  clearSearch();
  searchInput.value = '';
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
  searchCount.textContent = '';
}

export function runSearch(query) {
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
  if (!state.searchRanges.length) return;
  state.searchCurrent = (state.searchCurrent + 1) % state.searchRanges.length;
  highlightCurrent();
  updateSearchCount();
}

export function prevMatch() {
  if (!state.searchRanges.length) return;
  state.searchCurrent = (state.searchCurrent - 1 + state.searchRanges.length) % state.searchRanges.length;
  highlightCurrent();
  updateSearchCount();
}

function updateSearchCount() {
  searchCount.textContent = state.searchRanges.length
    ? `${state.searchCurrent + 1} / ${state.searchRanges.length}`
    : (searchInput.value ? 'No matches' : '');
}
