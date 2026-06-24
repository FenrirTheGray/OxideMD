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

const countWords = (text) => text.match(/\S+/g)?.length ?? 0;
const countLines = (text) => text === '' ? 0 : text.split('\n').length;

function countsLabel(text) {
  const chars = text.length;
  const words = countWords(text);
  const lines = countLines(text);
  return `${lines} line${lines === 1 ? '' : 's'} · `
       + `${words} word${words === 1 ? '' : 's'} · `
       + `${chars} char${chars === 1 ? '' : 's'}`;
}

export function updateCounts(value: any, selectionText?: any) {
  if (!statusCountsEl) return;
  const text = value ?? '';
  let label = countsLabel(text);
  const sel = selectionText ?? '';
  if (sel) {
    const selWords = countWords(sel);
    label += `  (${selWords} word${selWords === 1 ? '' : 's'}, `
           + `${sel.length} char${sel.length === 1 ? '' : 's'} selected)`;
  }
  statusCountsEl.textContent = label;
}

export function clearCounts() {
  if (statusCountsEl) statusCountsEl.textContent = '';
}
