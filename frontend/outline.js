// Document outline sidebar. Lists the active tab's headings (ATX
// `#`..`######` and setext text/underline pairs) and jumps the editor
// or preview when one is clicked. Docked on the right side of the
// window (the folder browser is the left sidebar); the btn-outline
// toolbar button toggles it open/closed in read mode. In edit mode
// that same button is repurposed to show/hide the live preview pane —
// see syncToolbar() in tabs.js and togglePreviewPane() in editor.js.
//
// Parsing: scan tab.raw line-by-line tracking fenced-code state so
// `# foo` inside a ``` block isn't mistaken for a heading. Setext-style
// headings (text line followed by === or ---) are also picked up so
// the outline indices stay aligned with the rendered preview's
// document.querySelectorAll('h1..h6'), which sees both styles. The
// heading entry's `line` points at the text line (not the underline)
// so jump-to-editor lands the cursor on the heading itself.

import {
  invoke,
  state,
  contentEl, contentScroll,
  btnOutline, outlineSidebar, outlineSidebarBody, outlineSidebarCloseBtn,
} from './state.js';
import { activeTab, syncToolbar } from './tabs.js';
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

export function isOutlineOpen() {
  return isOpen;
}

// Repaint the outline list from the active tab's current buffer. Cheap
// enough to call on every open, tab switch, edit-mode change, and
// (debounced) doc edit — skips entirely while the sidebar is hidden.
export function refreshOutline() {
  if (!isOpen) return;
  const tab = activeTab();
  const entries = tab ? parseOutline(tab.raw ?? '') : [];
  outlineSidebarBody.innerHTML = renderOutline(entries);
}

// Persist the open/closed state the way sidebar_width is persisted —
// debounced write through save_config_cmd so a rapid toggle doesn't
// thrash the config file.
let pendingVisibilitySave = null;
function persistOutlineVisible(visible) {
  if (!state.config) return;
  state.config.outline_visible = visible;
  if (pendingVisibilitySave) clearTimeout(pendingVisibilitySave);
  pendingVisibilitySave = setTimeout(() => {
    pendingVisibilitySave = null;
    invoke('save_config_cmd', { config: state.config }).catch(() => {});
  }, 150);
}

export function openOutline() {
  if (isOpen) return;
  isOpen = true;
  outlineSidebar.classList.remove('hidden');
  refreshOutline();
  syncToolbar();
}

export function closeOutline() {
  if (!isOpen) return;
  isOpen = false;
  outlineSidebar.classList.add('hidden');
  syncToolbar();
}

export function toggleOutline() {
  if (isOpen) closeOutline();
  else openOutline();
  persistOutlineVisible(isOpen);
}

// Restore the persisted open/closed state at startup. Called from
// app.js init() after state.config is loaded; doesn't persist (the
// value already came from config).
// Restore the persisted open state — but only when there's an active
// tab. The welcome screen has no document to outline, so we never show
// the empty sidebar there even if the user left it open last session.
// Called on startup and again on every tab activation (see applyActiveTab).
export function applyOutlineVisibility() {
  const hasTab = state.activeTabId !== null;
  if (hasTab && state.config?.outline_visible) openOutline();
  else closeOutline();
}

// Outline button toggles the right-side sidebar in both read and edit
// modes. Preview pane has its own dedicated button (see editor.js) so
// this one is no longer mode-aware.
if (btnOutline) {
  btnOutline.addEventListener('click', (e) => {
    e.preventDefault();
    toggleOutline();
  });
}

if (outlineSidebarCloseBtn) {
  outlineSidebarCloseBtn.addEventListener('click', () => {
    closeOutline();
    persistOutlineVisible(false);
    btnOutline.focus();
  });
}

if (outlineSidebar) {
  outlineSidebar.addEventListener('click', (e) => {
    const item = e.target.closest('.outline-item');
    if (!item) return;
    const tab = activeTab();
    if (!tab) return;
    if (tab.editing) {
      const line = parseInt(item.dataset.line, 10);
      if (Number.isFinite(line)) jumpToHeadingInEditor(line);
    } else {
      const index = parseInt(item.dataset.index, 10);
      if (Number.isFinite(index)) jumpToHeadingInPreview(index);
    }
  });
}
