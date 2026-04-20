// Document outline popover. Lists the active tab's headings (ATX
// `#`..`######` and setext text/underline pairs) and jumps the editor
// or preview when one is clicked. Anchored to btn-outline in the top
// toolbar; toggled open by click and closed by outside click /
// Escape / a heading selection.
//
// Parsing: scan tab.raw line-by-line tracking fenced-code state so
// `# foo` inside a ``` block isn't mistaken for a heading. Setext-style
// headings (text line followed by === or ---) are also picked up so
// the outline indices stay aligned with the rendered preview's
// document.querySelectorAll('h1..h6'), which sees both styles. The
// heading entry's `line` points at the text line (not the underline)
// so jump-to-editor lands the cursor on the heading itself.

import {
  contentEl, contentScroll,
  btnOutline, outlinePopover,
} from './state.js';
import { activeTab } from './tabs.js';
import { getEditorView } from './editor.js';
import { EditorSelection } from '@codemirror/state';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE   = /^\s*(```|~~~)/;
// Setext underline: 1+ = or - chars, optionally indented up to 3 spaces,
// optional trailing whitespace. Per CommonMark the underline must
// follow a non-blank text line with no blank line between.
const SETEXT_RE  = /^[ \t]{0,3}(=+|-+)[ \t]*$/;

export function parseOutline(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const atx = HEADING_RE.exec(line);
    if (atx) {
      out.push({ level: atx[1].length, text: atx[2].trim(), line: i + 1 });
      continue;
    }
    // Setext: this line is === or ---, previous line is non-blank text
    // that isn't itself an ATX heading. A bare `---` between paragraphs
    // is a thematic break, not a heading — the prev-line-non-blank
    // requirement filters that out.
    const setext = SETEXT_RE.exec(line);
    if (setext && i > 0) {
      const prev = lines[i - 1];
      if (prev && prev.trim() && !HEADING_RE.test(prev)) {
        const level = setext[1][0] === '=' ? 1 : 2;
        out.push({ level, text: prev.trim(), line: i });
      }
    }
  }
  return out;
}

function jumpToHeadingInEditor(line) {
  const view = getEditorView();
  if (!view) return;
  const totalLines = view.state.doc.lines;
  const lineNo = Math.max(1, Math.min(line, totalLines));
  const lineObj = view.state.doc.line(lineNo);
  view.dispatch({
    selection: EditorSelection.cursor(lineObj.from),
    scrollIntoView: true,
  });
  view.focus();
}

// View-mode jump: the rendered preview's heading order matches the
// outline's (we generate both from the same source), so we can index
// directly without needing anchor IDs from the renderer.
function jumpToHeadingInPreview(index) {
  const headings = contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const target = headings[index];
  if (!target) return;
  // contentScroll is the actual scrollable container in view mode.
  const scroller = contentScroll || contentEl.parentElement;
  if (scroller) {
    const top = target.getBoundingClientRect().top
              - scroller.getBoundingClientRect().top
              + scroller.scrollTop
              - 12;
    scroller.scrollTo({ top, behavior: 'smooth' });
  } else {
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderOutline(entries) {
  if (!entries.length) {
    return `<div class="outline-empty">No headings in this document.</div>`;
  }
  // Normalize indent: many docs start at h2 — anchor levels to the
  // shallowest heading present so the tree doesn't waste left padding.
  const minLevel = entries.reduce((m, e) => Math.min(m, e.level), 6);
  const items = entries.map((e, i) => {
    const indent = (e.level - minLevel) * 14;
    return `<button class="outline-item outline-h${e.level}" type="button"
                    data-index="${i}" data-line="${e.line}"
                    style="padding-left: ${12 + indent}px;">
              ${escapeHtml(e.text)}
            </button>`;
  }).join('');
  return `<div class="outline-list">${items}</div>`;
}

let isOpen = false;
let outsideClickBound = false;

function positionPopover() {
  const r = btnOutline.getBoundingClientRect();
  outlinePopover.style.position = 'fixed';
  outlinePopover.style.top = `${Math.round(r.bottom + 6)}px`;
  // Right-align under the button so longer headings flow leftward.
  outlinePopover.style.right = `${Math.round(window.innerWidth - r.right)}px`;
  outlinePopover.style.left = 'auto';
}

function onOutsideClick(e) {
  if (!isOpen) return;
  if (outlinePopover.contains(e.target)) return;
  if (btnOutline.contains(e.target)) return;
  closeOutline();
}

function onEscape(e) {
  if (!isOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeOutline();
    btnOutline.focus();
  }
}

export function openOutline() {
  const tab = activeTab();
  if (!tab) return;
  const entries = parseOutline(tab.raw ?? '');
  outlinePopover.innerHTML = renderOutline(entries);
  outlinePopover.classList.remove('hidden');
  outlinePopover.setAttribute('aria-hidden', 'false');
  btnOutline.setAttribute('aria-expanded', 'true');
  positionPopover();
  isOpen = true;
  if (!outsideClickBound) {
    document.addEventListener('mousedown', onOutsideClick, true);
    document.addEventListener('keydown', onEscape, true);
    window.addEventListener('resize', positionPopover);
    outsideClickBound = true;
  }
  // Focus first item for keyboard nav.
  requestAnimationFrame(() => {
    const first = outlinePopover.querySelector('.outline-item');
    if (first) first.focus();
  });
}

export function closeOutline() {
  if (!isOpen) return;
  outlinePopover.classList.add('hidden');
  outlinePopover.setAttribute('aria-hidden', 'true');
  btnOutline.setAttribute('aria-expanded', 'false');
  isOpen = false;
  if (outsideClickBound) {
    document.removeEventListener('mousedown', onOutsideClick, true);
    document.removeEventListener('keydown', onEscape, true);
    window.removeEventListener('resize', positionPopover);
    outsideClickBound = false;
  }
}

export function toggleOutline() {
  if (isOpen) closeOutline();
  else openOutline();
}

if (btnOutline && outlinePopover) {
  btnOutline.addEventListener('click', (e) => {
    e.preventDefault();
    toggleOutline();
  });
  outlinePopover.addEventListener('click', (e) => {
    const item = e.target.closest('.outline-item');
    if (!item) return;
    const tab = activeTab();
    if (!tab) return;
    closeOutline();
    if (tab.editing) {
      const line = parseInt(item.dataset.line, 10);
      if (Number.isFinite(line)) jumpToHeadingInEditor(line);
    } else {
      const index = parseInt(item.dataset.index, 10);
      if (Number.isFinite(index)) jumpToHeadingInPreview(index);
    }
  });
}
