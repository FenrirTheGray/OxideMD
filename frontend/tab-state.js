// Shared tab-state seam.
//
// These low-level reads and render primitives sit *below* both tabs.js
// (tab orchestration: open/close/switch, edit lifecycle wiring) and
// editor.js (CodeMirror lifecycle). Both used to reach across to each
// other for them, which made the two modules mutually dependent. Hoisting
// the shared contract here — the active-tab accessor, the pure dirty/
// preview predicates, content mount, status helpers, and zoom — gives both
// a single neutral source, so editor.js no longer reaches into tabs.js for
// them (it keeps only the irreducible chrome calls: syncToolbar /
// renderTabBar / rerender).
//
// This module imports only from state.js (no tabs.js / editor.js / outline.js),
// so it has no module-load side effects of its own and is safe to import
// from either side of the old cycle.

import {
  convertFileSrc,
  tabs, state,
  ZOOM_MIN, ZOOM_MAX,
  supportsHighlights, matchHighlight, currentHighlight,
  contentEl, previewPane,
  statusText, statusIndicator,
  zoomLabel, btnZoomIn, btnZoomOut,
} from './state.js';

// ── Active tab ─────────────────────────────────────────────────────────────
export function activeTab() {
  return tabs.find(t => t.id === state.activeTabId) ?? null;
}

// ── Pure predicates (no DOM / editor view needed) ────────────────────────────
// A tab is dirty only while editing and its live buffer differs from the
// last-saved disk content.
export function isDirty(tab) {
  if (!tab) return false;
  if (!tab.editing) return false;
  return (tab.raw ?? '') !== (tab.savedRaw ?? '');
}

// Whether the live preview pane is currently visible — drives the outline
// button's edit-mode aria-pressed / tooltip in syncToolbar().
export function isPreviewVisible() {
  const tab = activeTab();
  if (!tab?.editing) return false;
  return (tab.splitMode || 'split') !== 'editor';
}

// ── Content mount ────────────────────────────────────────────────────────────
// Local images are emitted by the Rust renderer as `<img data-oxide-src="…">`
// with an absolute path. The webview can't load a raw filesystem path, so we
// rewrite it to an asset:// URL here. Remote images already carry a real `src`
// and are untouched.
export function renderContent(html) {
  // Any existing search highlights point to about-to-be-detached text nodes.
  // Drop them so the registry doesn't hold refs to orphaned ranges.
  if (state.searchRanges.length || (supportsHighlights && currentHighlight.size)) {
    state.searchRanges = [];
    state.searchCurrent = -1;
    if (supportsHighlights) {
      matchHighlight.clear();
      currentHighlight.clear();
    }
  }
  contentEl.innerHTML = html;
  for (const img of contentEl.querySelectorAll('img[data-oxide-src]')) {
    img.src = convertFileSrc(img.dataset.oxideSrc);
  }
}

// ── Status indicator ─────────────────────────────────────────────────────────
export function setLoading() {
  statusText.textContent = 'Loading';
  statusIndicator.classList.remove('hidden');
  statusIndicator.classList.add('status-loading');
}

function setReady() {
  statusText.textContent = 'Ready';
  statusIndicator.classList.remove('hidden', 'status-loading');
}

export function clearStatus() {
  if (tabs.length === 0) {
    statusIndicator.classList.add('hidden');
    statusIndicator.classList.remove('status-loading');
  } else {
    setReady();
  }
}

// ── Zoom ─────────────────────────────────────────────────────────────────────
export function applyZoom(zoom) {
  const tab = activeTab();
  const fontSize = `calc(var(--font-size) * ${zoom.toFixed(2)})`;
  contentEl.style.fontSize = fontSize;
  // Mirror the zoom on the live preview so Ctrl+/− affect it too.
  if (previewPane) previewPane.style.fontSize = fontSize;
  // The editor takes the full viewport width; reading-width constraints
  // are a rendered-markdown concern only.
  if (tab?.editing) {
    contentEl.style.maxWidth = 'none';
  } else {
    contentEl.style.maxWidth = `${Math.round((state.config?.reading_width ?? 800) * zoom)}px`;
  }
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  btnZoomOut.disabled = zoom <= ZOOM_MIN;
  btnZoomIn.disabled  = zoom >= ZOOM_MAX;
}
