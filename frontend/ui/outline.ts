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
} from "../core/state.ts";
import { activeTab, syncToolbar } from "./tabs.ts";
import { editorModule } from "../editor/lazy.ts";
import { escapeHtml } from "../lib/escape.ts";
import { debounce } from "../lib/timing.ts";

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

function renderOutline(entries) {
  if (!entries.length) {
    return `<div class="outline-empty">No headings in this document.</div>`;
  }
  // Normalize indent: many docs start at h2 — anchor levels to the
  // shallowest heading present so the tree doesn't waste left padding.
  const minLevel = entries.reduce((m, e) => Math.min(m, e.level), 6);
  // 12px per level — the same step the folder tree uses, so nested rows
  // in the two sidebars line up. title= surfaces headings the pill
  // ellipsises, like the tree rows' path tooltip.
  const items = entries.map((e, i) => {
    const indent = (e.level - minLevel) * 12;
    return `<button class="outline-item outline-h${e.level}" type="button"
                    data-index="${i}" data-line="${e.line}" tabindex="-1"
                    title="${escapeHtml(e.text)}"
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
export function refreshOutline(opts: { idle?: boolean } = {}) {
  if (!isOpen) return;
  const paint = () => {
    if (!isOpen) return; // may have closed during the idle wait
    const tab = activeTab();
    const entries = tab ? parseOutline(tab.raw ?? '') : [];
    outlineSidebarBody.innerHTML = renderOutline(entries);
    updateActiveHeading();
  };
  // The debounced edit path passes { idle:true } so the re-parse + innerHTML
  // rebuild yields to input frames; direct callers (open, tab/mode switch)
  // repaint immediately for a snappy response.
  if (opts.idle && typeof requestIdleCallback === 'function') {
    requestIdleCallback(paint, { timeout: 500 });
  } else {
    paint();
  }
}

// ── Current-section highlight ────────────────────────────────────────
// The active entry is the last heading at or above a line just below the
// viewport's top edge (the tolerance absorbs the 12px jump offset), or
// the last heading once the scroller is at its end — a short final
// section can never reach the top, so it would otherwise never light up.
const ACTIVE_TOLERANCE = 32;

function markActive(index) {
  const items = outlineSidebarBody.querySelectorAll('.outline-item');
  const prev = outlineSidebarBody.querySelector('.outline-item.active');
  items.forEach((el, i) => {
    el.classList.toggle('active', i === index);
    // Roving tabindex (see the keydown handler): Tab lands on the current
    // section, arrows move from there.
    (el as HTMLElement).tabIndex = i === index ? 0 : -1;
  });
  // Long outline, long document: keep the highlight on screen as it moves
  // (same `nearest` the tree uses when the open file changes).
  const next = items[index];
  if (next && next !== prev) next.scrollIntoView({ block: 'nearest' });
}

function updateActiveHeading() {
  if (!isOpen) return;
  const items = outlineSidebarBody.querySelectorAll('.outline-item');
  if (!items.length) return;
  const tab = activeTab();
  let index = 0;
  if (tab?.editing) {
    // No view yet (editor still mounting): fall through and mark the first
    // entry so the list keeps a tabindex=0 entry point.
    const vp = editorModule()?.getEditorViewportLine(ACTIVE_TOLERANCE);
    if (vp?.atBottom) index = items.length - 1;
    else if (vp) items.forEach((el, i) => {
      if (parseInt((el as HTMLElement).dataset.line, 10) <= vp.line) index = i;
    });
  } else {
    const scroller = contentScroll;
    if (!scroller) return;
    if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - ACTIVE_TOLERANCE) {
      index = items.length - 1;
    } else {
      const edge = scroller.getBoundingClientRect().top + ACTIVE_TOLERANCE;
      contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h, i) => {
        if (i < items.length && h.getBoundingClientRect().top <= edge) index = i;
      });
    }
  }
  markActive(index);
}

// One capturing listener sees every scroller's events (CodeMirror's
// don't bubble); a rAF coalesces bursts and keeps the DOM reads off the
// scroll event itself.
let activeFrame = 0;
window.addEventListener('scroll', () => {
  if (!isOpen || activeFrame) return;
  activeFrame = requestAnimationFrame(() => {
    activeFrame = 0;
    updateActiveHeading();
  });
}, { capture: true, passive: true });

// Persist the open/closed state the way sidebar_width is persisted —
// debounced write through save_config_cmd so a rapid toggle doesn't
// thrash the config file.
const saveOutlineConfig = debounce(() => {
  invoke('save_config_cmd', { config: state.config }).catch(() => {});
}, 150);
function persistOutlineVisible(visible) {
  if (!state.config) return;
  state.config.outline_visible = visible;
  saveOutlineConfig();
}

const outlineDivider = document.getElementById('outline-divider');

export function openOutline() {
  if (isOpen) return;
  isOpen = true;
  outlineSidebar.classList.remove('hidden');
  outlineDivider?.classList.remove('hidden');
  refreshOutline();
  syncToolbar();
}

export function closeOutline() {
  if (!isOpen) return;
  isOpen = false;
  outlineSidebar.classList.add('hidden');
  outlineDivider?.classList.add('hidden');
  syncToolbar();
}

// ── Outline divider ──────────────────────────────────────────────────
// The folder sidebar's resizer (folder.ts) mirrored to the right edge:
// drag or arrow-key the width, clamp, persist to config.outline_width on
// release. The width grows leftward, so it's measured from the divider
// to #main-container's right edge.
const OUTLINE_MIN = 180;
const OUTLINE_MAX = 480;

function setOutlineWidth(px, maxOverride = OUTLINE_MAX) {
  const w = Math.max(OUTLINE_MIN, Math.min(maxOverride, Math.round(px)));
  document.body.style.setProperty('--outline-width', `${w}px`);
  outlineDivider.setAttribute('aria-valuenow', String(w));
  return w;
}
function persistOutlineWidth(width) {
  if (!state.config) return;
  state.config.outline_width = width;
  saveOutlineConfig();
}

if (outlineDivider) {
  let dragPointerId = null;
  let containerRight = 0;
  outlineDivider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragPointerId = e.pointerId;
    containerRight = document.getElementById('main-container').getBoundingClientRect().right;
    outlineDivider.classList.add('dragging');
    document.body.classList.add('resizing-sidebar');
    try { outlineDivider.setPointerCapture(e.pointerId); } catch {}
  });
  outlineDivider.addEventListener('pointermove', (e) => {
    if (dragPointerId !== e.pointerId) return;
    setOutlineWidth(containerRight - e.clientX);
  });
  const endDrag = (e) => {
    if (dragPointerId !== e.pointerId) return;
    dragPointerId = null;
    outlineDivider.classList.remove('dragging');
    document.body.classList.remove('resizing-sidebar');
    try { outlineDivider.releasePointerCapture(e.pointerId); } catch {}
    persistOutlineWidth(parseInt(outlineDivider.getAttribute('aria-valuenow') || '260', 10));
  };
  outlineDivider.addEventListener('pointerup', endDrag);
  outlineDivider.addEventListener('pointercancel', endDrag);
  // Double-click fits the widest heading (folder.ts does the same for the
  // tree). Each row ellipsizes on its own, so the overflow is per item:
  // scrollWidth still reports the full text width under overflow:hidden.
  outlineDivider.addEventListener('dblclick', (e) => {
    e.preventDefault();
    let overflow = 0;
    outlineSidebarBody.querySelectorAll('.outline-item').forEach((el) => {
      overflow = Math.max(overflow, el.scrollWidth - el.clientWidth);
    });
    if (overflow <= 0) return;
    const cur = parseInt(outlineDivider.getAttribute('aria-valuenow') || '260', 10);
    const maxAllowed = Math.max(OUTLINE_MIN, Math.floor(window.innerWidth * 0.5));
    persistOutlineWidth(setOutlineWidth(cur + overflow, maxAllowed));
  });
  outlineDivider.addEventListener('keydown', (e) => {
    const cur = parseInt(outlineDivider.getAttribute('aria-valuenow') || '260', 10);
    let next = cur;
    // Mirrored: ← widens the outline (it grows leftward), → narrows.
    if (e.key === 'ArrowLeft')       next = cur + 10;
    else if (e.key === 'ArrowRight') next = cur - 10;
    else if (e.key === 'Home')       next = OUTLINE_MIN;
    else if (e.key === 'End')        next = OUTLINE_MAX;
    else return;
    e.preventDefault();
    persistOutlineWidth(setOutlineWidth(next));
  });
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

// Arrow-key navigation over the list, mirroring the folder tree: ↑/↓
// move, Home/End jump, Enter/Space activate. Focus follows the roving
// tabindex markActive maintains.
if (outlineSidebarBody) {
  outlineSidebarBody.addEventListener('keydown', (e) => {
    const item = (e.target as HTMLElement).closest('.outline-item') as HTMLElement;
    if (!item) return;
    const items = Array.from(outlineSidebarBody.querySelectorAll('.outline-item')) as HTMLElement[];
    const idx = items.indexOf(item);
    let to = -1;
    if (e.key === 'ArrowDown') to = Math.min(items.length - 1, idx + 1);
    else if (e.key === 'ArrowUp') to = Math.max(0, idx - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = items.length - 1;
    else return;
    e.preventDefault();
    items[to].focus();
    items[to].scrollIntoView({ block: 'nearest' });
  });
}

if (outlineSidebar) {
  outlineSidebar.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.outline-item') as HTMLElement;
    if (!item) return;
    const tab = activeTab();
    if (!tab) return;
    if (tab.editing) {
      // Routed through the lazy editor module — editor-line jumps are only
      // offered while a tab is editing, which implies it's loaded.
      const line = parseInt(item.dataset.line, 10);
      if (Number.isFinite(line)) editorModule()?.jumpEditorToLine(line);
    } else {
      const index = parseInt(item.dataset.index, 10);
      if (Number.isFinite(index)) jumpToHeadingInPreview(index);
    }
  });
}
