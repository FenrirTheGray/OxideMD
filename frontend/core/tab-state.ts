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
  contentEl, previewPane, editorPane,
  statusText, statusIndicator,
  zoomLabel, btnZoomIn, btnZoomOut,
} from "./state.ts";

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

// ── Image hydration ───────────────────────────────────────────────────────
// Promote the renderer's image placeholders to live sources for a freshly
// mounted container. Two kinds need work:
//   • Local images arrive as `<img data-oxide-src="/abs/path">`; the webview
//     can't load a raw filesystem path, so rewrite it to an asset:// URL.
//   • Remote images (http(s)/protocol-relative) arrive as inert
//     `<img class="md-remote-image" data-oxide-remote-src="https://…">` with
//     NO live `src` — so an untrusted document can't phone home to an
//     arbitrary host on open (an IP-leak / tracking-pixel vector). They're
//     promoted to a real `src` only when the user has enabled remote images.
// `data:` images already carry a real `src` from the renderer and need
// nothing here. Shared by renderContent, the editor preview, and print so the
// gating stays consistent across all three mount paths.
export function hydrateImages(root) {
  if (!root) return;
  for (const img of root.querySelectorAll('img[data-oxide-src]')) {
    img.src = convertFileSrc(img.dataset.oxideSrc);
  }
  if (state.config?.load_remote_images) {
    for (const img of root.querySelectorAll('img[data-oxide-remote-src]')) {
      img.src = img.dataset.oxideRemoteSrc;
      img.classList.remove('md-remote-image');
    }
  }
}

// ── Content mount ────────────────────────────────────────────────────────────
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
  hydrateImages(contentEl);
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
  // Mirror the zoom on the live preview *and* the editor pane so Ctrl+/−
  // affect both and the editor's text size matches the preview's. The CM6
  // theme sets `font-size: inherit`, so the pane's size cascades into it.
  if (previewPane) previewPane.style.fontSize = fontSize;
  if (editorPane) editorPane.style.fontSize = fontSize;
  // The editor takes the full viewport width; reading-width constraints
  // are a rendered-markdown concern only.
  if (tab?.editing) {
    contentEl.style.maxWidth = 'none';
  } else {
    contentEl.style.maxWidth = `${Math.round((state.config?.reading_width ?? 800) * zoom)}px`;
  }
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  (btnZoomOut as HTMLButtonElement).disabled = zoom <= ZOOM_MIN;
  (btnZoomIn as HTMLButtonElement).disabled  = zoom >= ZOOM_MAX;
}
