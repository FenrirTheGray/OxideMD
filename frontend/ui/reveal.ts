// Search-hit reveal painting shared by read mode and the edit-mode
// preview pane. The matched substring is painted via the CSS Highlight
// API (oxide-reveal-match) and its containing block gets
// `.oxide-reveal-block` for the line wash.
//
// Lives outside editor/editor.ts on purpose: project search must reveal
// hits in read mode, and editor.ts is loaded lazily because it drags in
// all of CodeMirror. The editor module layers its own one-shot preview
// reveal state on top of these primitives.

import {
  contentEl, contentScroll,
  supportsHighlights, revealHighlight,
} from "../core/state.ts";
import { activeTab } from "../core/tab-state.ts";

let revealBlockEl: any = null;
const REVEAL_BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre,dt,dd,figcaption';

export function clearReveal() {
  if (supportsHighlights && revealHighlight) revealHighlight.clear();
  if (revealBlockEl) { revealBlockEl.classList.remove('oxide-reveal-block'); revealBlockEl = null; }
}

// Paint the `ordinal`-th occurrence of `query` inside `container` (the live
// preview pane or the read-mode #content) and wash its containing block.
// Returns the picked Range so the caller can scroll it into view, or null.
export function highlightMatchIn(container, query, ordinal): Range | null {
  clearReveal();
  if (!query) return null;
  const needle = String(query).toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let tn: any;
  while ((tn = walker.nextNode())) {
    const text = tn.nodeValue || '';
    const hay = text.toLowerCase();
    let idx = 0;
    while ((idx = hay.indexOf(needle, idx)) !== -1) {
      const r = document.createRange();
      r.setStart(tn, idx);
      r.setEnd(tn, idx + needle.length);
      ranges.push(r);
      idx += needle.length;
    }
  }
  if (!ranges.length) return null;
  // Clamp to the occurrence count in case the renderer dropped some (e.g.
  // a match that lived inside markdown syntax that isn't rendered).
  const pick = ranges[Math.min(ordinal, ranges.length - 1)];
  if (supportsHighlights && revealHighlight) revealHighlight.add(pick);
  const block = (pick.startContainer.parentElement || container).closest(REVEAL_BLOCK_SELECTOR);
  if (block) { block.classList.add('oxide-reveal-block'); revealBlockEl = block; }
  return pick;
}

// The 0-based index of the hit on 1-based source `line` among all
// occurrences of `query` in `src` — so the rendered view highlights the
// *same* occurrence the backend matched, not just the first. Mirrors the
// ordinal math in editor.ts's revealEditorLine but works off a raw source
// string (read mode has no editor). Newlines are normalized so a CRLF
// file doesn't drift the offset and pick the wrong occurrence.
function matchOrdinal(src, line, query) {
  if (!query) return 0;
  const text = String(src).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (!Number.isFinite(line) || line < 1 || line > lines.length) return 0;
  const needle = String(query).toLowerCase();
  const col = lines[line - 1].toLowerCase().indexOf(needle);
  if (col === -1) return 0;
  let offset = col;
  for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1; // + '\n'
  const before = text.slice(0, offset).toLowerCase();
  let ordinal = 0;
  let i = 0;
  while ((i = before.indexOf(needle, i)) !== -1) { ordinal++; i += needle.length; }
  return ordinal;
}

// Reveal a project-search hit in read mode: highlight the matched substring
// in the rendered #content and scroll its block to center. The occurrence is
// chosen from the tab's raw source so it lines up with the backend's match.
export function revealReadLine(line, query) {
  if (!query) { clearReveal(); return; }
  const tab = activeTab();
  const ordinal = matchOrdinal(tab?.raw ?? '', line, query);
  const pick = highlightMatchIn(contentEl, query, ordinal);
  if (!pick) return;
  // Center the hit in the scroll viewport (mirrors features/search.ts).
  const rect = pick.getBoundingClientRect();
  const scrollRect = contentScroll.getBoundingClientRect();
  const target = contentScroll.scrollTop + rect.top - scrollRect.top
    - scrollRect.height / 2 + rect.height / 2;
  contentScroll.scrollTo({ top: target, behavior: 'smooth' });
}
