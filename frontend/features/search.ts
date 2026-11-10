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
import { findMatches } from "../lib/text-search.ts";

// The one bar drives two backends: the rendered-content highlight search in
// read mode, and CodeMirror's search (via editor.ts) in edit mode. Every
// public op branches on this. Edit-mode counts are read live from the
// editor, so typing and undo keep the "n / m" readout current.
function isEditing() { return document.body.classList.contains('editing'); }

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
  // Escape from the find field goes back to the text it was searching.
  if (isEditing() && searchBar.contains(document.activeElement)) editorModule()?.focusEditor();
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
  if (isEditing()) editorModule()?.editorClearSearch();
  searchCount.textContent = '';
}

// Re-run the open bar's query against what is now shown (tab switch, reload,
// outside change), without scrolling over the view's restored position.
export function refreshSearch() {
  if (searchBar.classList.contains('hidden')) { clearSearch(); return; }
  runSearch((searchInput as HTMLInputElement).value, false);
}

// Inline elements stay joined so a phrase can span `**bold**` or highlighted
// code; any other element starts a new block, which a "\n" keeps apart.
const INLINE_TAGS = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DEL', 'DFN', 'EM', 'I',
  'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'U', 'VAR']);
function blockOf(n: Node) {
  let e = n.parentElement;
  while (e && e !== contentEl && INLINE_TAGS.has(e.tagName)) e = e.parentElement;
  return e;
}

export function runSearch(query, scroll = true) {
  if (isEditing()) {
    editorModule()?.editorSetSearch(query, state.searchCaseSensitive);
    updateSearchCount();
    return;
  }
  clearSearch();
  if (!query) return;

  // Match on the rendered text as one string, then map offsets back to nodes.
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  let block: Element | null | undefined;
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n.nodeType !== Node.TEXT_NODE) {
      if ((n as Element).tagName === 'BR') text += '\n';
      continue;
    }
    const b = blockOf(n);
    if (b !== block) { text += '\n'; block = b; }
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  let j = 0;
  const at = (i: number): [Text, number] => {
    while (starts[j] + nodes[j].length <= i) j++;
    return [nodes[j], i - starts[j]];
  };
  for (const [s, e] of findMatches(text, query, state.searchCaseSensitive)) {
    const range = document.createRange();
    range.setStart(...at(s));
    const [en, eo] = at(e - 1);
    range.setEnd(en, eo + 1);
    state.searchRanges.push(range);
  }

  if (supportsHighlights) {
    for (const r of state.searchRanges) matchHighlight.add(r);
  }

  if (state.searchRanges.length > 0) {
    state.searchCurrent = 0;
    highlightCurrent(scroll);
  }
  updateSearchCount();
}

function highlightCurrent(scroll = true) {
  if (!supportsHighlights) return;
  currentHighlight.clear();
  const range = state.searchRanges[state.searchCurrent];
  if (!range) return;
  currentHighlight.add(range);
  if (!scroll) return;
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
    editorModule()?.editorNextMatch();
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
    editorModule()?.editorPrevMatch();
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
  editorModule()?.editorReplaceMatch(
    (searchInput as HTMLInputElement).value,
    (searchReplaceInput as HTMLInputElement).value,
    state.searchCaseSensitive,
  );
  updateSearchCount();
}

export function replaceAllMatches() {
  if (!isEditing()) return;
  editorModule()?.editorReplaceAllMatches(
    (searchInput as HTMLInputElement).value,
    (searchReplaceInput as HTMLInputElement).value,
    state.searchCaseSensitive,
  );
  updateSearchCount();
}

export function updateSearchCount() {
  if (isEditing()) {
    const { count: editCount, current: editCurrent } = editorModule()?.editorMatchInfo() ?? { count: 0, current: 0 };
    searchCount.textContent = editCount
      ? (editCurrent ? `${editCurrent} / ${editCount}` : `${editCount} match${editCount === 1 ? '' : 'es'}`)
      : ((searchInput as HTMLInputElement).value ? 'No matches' : '');
    return;
  }
  searchCount.textContent = state.searchRanges.length
    ? `${state.searchCurrent + 1} / ${state.searchRanges.length}`
    : ((searchInput as HTMLInputElement).value ? 'No matches' : '');
}
