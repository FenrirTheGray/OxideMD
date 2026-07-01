// Line / word / char counts for the status bar.
//
// Lives outside editor/editor.ts on purpose: read mode needs these on
// every tab switch, and editor.ts is loaded lazily (it drags in all of
// CodeMirror). Keeping the counts here keeps the read-mode path light.
//
// O(doc), which is why the edit-mode caller is debounced (see editor.ts) —
// only the one-shot mode-switch/mount callers run it inline. Counts source
// markdown verbatim (including syntax characters) to avoid tying this to
// the render pipeline.
//
// Used in both modes: edit mode passes the live buffer (and, when a
// selection is non-empty, the selected text for the trailing "selected"
// segment); read mode passes the tab's raw source. `showWelcome` clears
// the element so it blanks out when there's no active document.

import { statusCountsEl } from "../core/state.ts";

export const countWords = (text) => text.match(/\S+/g)?.length ?? 0;
const countLines = (text) => text === '' ? 0 : text.split('\n').length;

function countsLabel(lines, words, chars) {
  return `${lines} line${lines === 1 ? '' : 's'} · `
       + `${words} word${words === 1 ? '' : 's'} · `
       + `${chars} char${chars === 1 ? '' : 's'}`;
}

function withSelection(label, selectionText) {
  const sel = selectionText ?? '';
  if (!sel) return label;
  const selWords = countWords(sel);
  return label + `  (${selWords} word${selWords === 1 ? '' : 's'}, `
       + `${sel.length} char${sel.length === 1 ? '' : 's'} selected)`;
}

// String path — read mode and one-shot edit-mode callers (mount / mode
// switch / discard). O(doc), which is why the live edit path is debounced
// and uses updateCountsFrom instead (see editor.ts countField).
export function updateCounts(value: any, selectionText?: any) {
  if (!statusCountsEl) return;
  const text = value ?? '';
  statusCountsEl.textContent = withSelection(
    countsLabel(countLines(text), countWords(text), text.length),
    selectionText,
  );
}

// Precomputed path — the live editor maintains {lines, words, chars}
// incrementally in a StateField, so the keystroke path never rescans the
// whole document. Selection words are still counted from the (small)
// selection string.
export function updateCountsFrom(
  counts: { lines: number; words: number; chars: number },
  selectionText?: any,
) {
  if (!statusCountsEl) return;
  statusCountsEl.textContent = withSelection(
    countsLabel(counts.lines, counts.words, counts.chars),
    selectionText,
  );
}

export function clearCounts() {
  if (statusCountsEl) statusCountsEl.textContent = '';
}
