// One-shot height floor for the welcome screen.
//
// Width is handled entirely by tauri.conf.json (minWidth: 720) plus the
// auto-compact CSS media query — the toolbar shrinks to icons below
// 1220px and the buttons fit inside 720px from there, so we no longer
// need to measure the toolbar to derive a width floor.
//
// Height still benefits from a one-shot measurement: the welcome
// screen's natural layout height varies with the user's font choice
// and zoom, and we want the initial window to be tall enough to show
// the welcome without scrolling. We deliberately do NOT re-measure on
// sidebar/edit-mode toggles — that would grow the minimum during the
// session and trap the user at a larger floor.

import { appWindow, contentEl } from './state.js';

const { LogicalSize } = window.__TAURI__.window;

const toolbar   = document.getElementById('toolbar');
const statusBar = document.getElementById('status-bar');

// Floor for the content area when no welcome is live — a couple of
// editor/preview lines visible at default zoom.
const CONTENT_MIN_H = 400;

function measureMinHeight() {
  let contentH = CONTENT_MIN_H;
  const welcome = document.getElementById('welcome');
  if (welcome && welcome.offsetParent !== null && contentEl) {
    contentH = Math.max(contentH, contentEl.scrollHeight);
  }
  let height = contentH;
  if (toolbar)   height += toolbar.offsetHeight;
  if (statusBar) height += statusBar.offsetHeight;
  return Math.ceil(height);
}

requestAnimationFrame(() => requestAnimationFrame(async () => {
  try {
    const height = measureMinHeight();
    // Keep tauri.conf's 720px width floor; only tighten the height.
    await appWindow.setMinSize(new LogicalSize(720, height));
  } catch (e) {
    console.error('[oxidemd] window sizing failed', e);
  }
}));
