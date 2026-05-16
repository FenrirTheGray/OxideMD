// One-shot welcome-height floor + responsive toolbar compact mode.
//
// Width is handled entirely by tauri.conf.json (minWidth: 720) plus
// the JS-driven `.compact-auto` toggle below — labels disappear when
// the toolbar would otherwise crowd the tab area, so the toolbar fits
// inside 720px and we no longer need to measure it to derive a width
// floor.
//
// Height still benefits from a one-shot measurement: the welcome
// screen's natural layout height varies with the user's font choice
// and zoom, and we want the initial window to be tall enough to show
// the welcome without scrolling. We deliberately do NOT re-measure on
// sidebar/edit-mode toggles — that would grow the minimum during the
// session and trap the user at a larger floor.
//
// On resize we toggle `.compact-auto` on #toolbar-buttons to hide the
// text labels when the toolbar would otherwise crowd the tab area.
// The user's `toolbar_compact` setting uses `.compact` — the two
// classes compose, so the auto behavior survives the user toggling
// their preference and vice versa.

import { appWindow, contentEl } from './state.js';

const { LogicalSize } = window.__TAURI__.window;

const toolbar        = document.getElementById('toolbar');
const toolbarButtons = document.getElementById('toolbar-buttons');
const windowControls = document.getElementById('window-controls');
const statusBar      = document.getElementById('status-bar');

// Floor for the content area when no welcome is live — a couple of
// editor/preview lines visible at default zoom.
const CONTENT_MIN_H = 400;

function visible(el) {
  return el && !el.classList.contains('hidden') && !el.hidden;
}

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
  primeNaturalToolbarWidth();
  updateAutoCompact();
}));

// Responsive toolbar compact mode ───────────────────────────────────────
// Cached natural (label-on) width of the toolbar action cluster. We
// measure it once with `.compact-auto` and `.compact` temporarily
// stripped so the cached value reflects the un-compacted layout even
// when the user has `toolbar_compact` enabled at launch.
let naturalToolbarWidth = 0;
// Hysteresis buffer (px). The window must grow back at least this far
// past the trigger point before we restore the labels, so a user
// dragging the edge across the threshold doesn't see the labels flicker.
const COMPACT_HYSTERESIS = 24;
// Minimum tab strip width we want to preserve before sacrificing labels.
const TAB_AREA_RESERVE = 200;

function primeNaturalToolbarWidth() {
  if (!toolbarButtons) return;
  const hadAuto = toolbarButtons.classList.contains('compact-auto');
  const hadCompact = toolbarButtons.classList.contains('compact');
  toolbarButtons.classList.remove('compact-auto', 'compact');
  // Force a reflow by reading offsetWidth after the class change.
  naturalToolbarWidth = toolbarButtons.offsetWidth;
  if (hadCompact) toolbarButtons.classList.add('compact');
  if (hadAuto) toolbarButtons.classList.add('compact-auto');
}

export function updateAutoCompact() {
  if (!toolbarButtons || !naturalToolbarWidth) return;
  const logoEl = document.getElementById('btn-logo');
  const logoW = logoEl ? logoEl.offsetWidth : 0;
  const winCtrlW = visible(windowControls) ? windowControls.offsetWidth : 0;
  const available = window.innerWidth - logoW - winCtrlW - TAB_AREA_RESERVE;
  const isCompact = toolbarButtons.classList.contains('compact-auto');
  const trigger = isCompact
    ? naturalToolbarWidth + COMPACT_HYSTERESIS
    : naturalToolbarWidth;
  toolbarButtons.classList.toggle('compact-auto', trigger > available);
}

let compactRafId = 0;
window.addEventListener('resize', () => {
  if (compactRafId) return;
  compactRafId = requestAnimationFrame(() => {
    compactRafId = 0;
    updateAutoCompact();
  });
});
