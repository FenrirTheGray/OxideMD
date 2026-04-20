// One-shot minimum window size.
//
// The hardcoded minWidth/minHeight in tauri.conf.json is a coarse floor
// that applies before JS runs. Once the initial layout is live we
// measure what the default UI (toolbar + status bar + welcome screen)
// actually needs and push that through `setMinSize` exactly once, so
// the user can't shrink the window small enough to clip the toolbar
// cluster or cause the welcome to scroll. We deliberately do NOT
// re-measure on sidebar/edit-mode toggles — that would grow the
// minimum during the session and trap the user at a larger floor.
//
// The measurement fires after two rAFs: the first lets layout settle,
// the second guarantees offsetParent/scrollHeight are non-zero for
// elements that mount just after DOMContentLoaded (welcome is injected
// synchronously but webfonts / icon SVGs land a tick later).

import { appWindow, contentEl } from './state.js';

const { LogicalSize } = window.__TAURI__.window;

// If the measured minimum is larger than the configured launch size,
// setMinSize will push the window to that size — but on Windows the
// resize is anchored to the top-left, shifting it off-center. Grow the
// window explicitly so we control the geometry, then re-center.

const toolbar        = document.getElementById('toolbar');
const toolbarButtons = document.getElementById('toolbar-buttons');
const windowControls = document.getElementById('window-controls');
const statusBar      = document.getElementById('status-bar');

// Floor for the content area when no welcome is live — a couple of
// editor/preview lines visible at default zoom.
const CONTENT_MIN_W = 320;
const CONTENT_MIN_H = 400;
// Space reserved for at least one (partial) tab plus the scroll arrows.
const TAB_AREA_MIN = 180;

function visible(el) {
  return el && !el.classList.contains('hidden') && !el.hidden;
}

function measureMinSize() {
  let contentH = CONTENT_MIN_H;
  const welcome = document.getElementById('welcome');
  if (welcome && welcome.offsetParent !== null && contentEl) {
    // contentEl.scrollHeight is the natural layout height of #content,
    // which includes its own 56+56 padding, the welcome's 56+40 margins,
    // and the welcome's content. Using it here sizes the window so the
    // welcome fits without needing to scroll.
    contentH = Math.max(contentH, contentEl.scrollHeight);
  }

  const buttonsW = toolbarButtons ? toolbarButtons.offsetWidth : 0;
  const winCtrlW = visible(windowControls) ? windowControls.offsetWidth : 0;
  const width = Math.max(CONTENT_MIN_W, buttonsW + winCtrlW + TAB_AREA_MIN);

  let height = contentH;
  if (toolbar)   height += toolbar.offsetHeight;
  if (statusBar) height += statusBar.offsetHeight;

  return { width: Math.ceil(width), height: Math.ceil(height) };
}

requestAnimationFrame(() => requestAnimationFrame(async () => {
  const { width, height } = measureMinSize();
  try {
    await appWindow.setMinSize(new LogicalSize(width, height));
    const current = await appWindow.innerSize();
    const scale = await appWindow.scaleFactor();
    const curW = current.width / scale;
    const curH = current.height / scale;
    if (curW < width || curH < height) {
      await appWindow.setSize(new LogicalSize(Math.max(curW, width), Math.max(curH, height)));
    }
    await appWindow.center();
  } catch (e) {
    console.error('[oxidemd] window sizing failed', e);
  }
}));
