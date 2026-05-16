// Window-min-size cap, on-launch geometry clamp, and responsive
// toolbar compact mode.
//
// Width minimum is handled entirely by tauri.conf.json (minWidth: 720)
// plus the JS-driven `.compact-auto` toggle below — labels disappear
// when the toolbar would otherwise crowd the tab area, so the toolbar
// fits inside 720px and we no longer need to measure it to derive a
// width floor.
//
// Height minimum still benefits from a one-shot measurement: the
// welcome screen's natural layout height varies with the user's font
// choice and zoom, and we want the initial window to be tall enough
// to show the welcome without scrolling. We deliberately do NOT
// re-measure on sidebar/edit-mode toggles — that would grow the
// minimum during the session and trap the user at a larger floor.
//
// Critically, both the measured min-height and the current window
// size are CAPPED against the monitor's available dimensions. The
// welcome's natural height (wordmark + 3 hero cards + recents + 14-row
// shortcuts grid) can easily exceed 1000px, and on Windows 10 with a
// taskbar or a Linux WM with top bar + dock that overshoots the
// usable area. Without a cap, `setMinSize` would be pinned above the
// screen and the OS would refuse to shrink the window — leaving
// users stuck with a window running off the bottom (or right) of
// their display.
//
// On resize we toggle `.compact-auto` on #toolbar-buttons to hide the
// text labels when the toolbar would otherwise crowd the tab area.
// The user's `toolbar_compact` setting uses `.compact` — the two
// classes compose, so the auto behavior survives the user toggling
// their preference and vice versa.

import { appWindow, contentEl } from './state.js';
import { logError } from './logger.js';

const { LogicalSize } = window.__TAURI__.window;

const toolbar        = document.getElementById('toolbar');
const toolbarButtons = document.getElementById('toolbar-buttons');
const windowControls = document.getElementById('window-controls');
const statusBar      = document.getElementById('status-bar');

// Floor for the content area when no welcome is live — a couple of
// editor/preview lines visible at default zoom.
const CONTENT_MIN_H = 400;
// Hard lower bounds we never relax below, mirroring tauri.conf
// (minWidth: 720, minHeight: 480) so the OS, the cap math, and the
// config agree.
const ABSOLUTE_MIN_H = 480;
const ABSOLUTE_MIN_W = 720;
// Slack between the requested size and the monitor's available
// dimensions. Leaves room for OS chrome the webview can't see (Windows
// taskbar, GNOME top bar/dock, macOS menu/dock) and keeps the window
// draggable instead of being pinned to the screen edges.
const SCREEN_SLACK = 80;

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

// Cap against `screen.avail{Width,Height}` so the welcome-fits-on-
// launch nicety never overrides the user's ability to shrink the
// window. Webview reports CSS pixels here, matching `LogicalSize`.
function capDim(measured, avail, floor) {
  if (avail > 0) {
    const cap = Math.max(floor, avail - SCREEN_SLACK);
    return Math.max(floor, Math.min(measured, cap));
  }
  return Math.max(floor, measured);
}

requestAnimationFrame(() => requestAnimationFrame(async () => {
  try {
    const availH = (window.screen && window.screen.availHeight) || 0;
    const availW = (window.screen && window.screen.availWidth)  || 0;
    const minH   = capDim(measureMinHeight(), availH, ABSOLUTE_MIN_H);
    // Width min stays at the tauri.conf floor — we don't grow it. The
    // cap still applies on the off chance the user is running on a
    // <720px-wide display, in which case the OS is allowed to honor
    // its own absolute minimum.
    const minW   = capDim(ABSOLUTE_MIN_W, availW, ABSOLUTE_MIN_W);
    await appWindow.setMinSize(new LogicalSize(minW, minH));

    // If a previous run, a stale persisted state, or the configured
    // default opened the window larger than the cap permits, pull it
    // back on both axes so the title bar stays on-screen and both
    // edges stay grabbable. Only writes when something is actually
    // out-of-bounds, so the common case is a no-op.
    const curW = Math.ceil(window.innerWidth);
    const curH = Math.ceil(window.innerHeight);
    const targetW = capDim(curW, availW, ABSOLUTE_MIN_W);
    const targetH = capDim(curH, availH, ABSOLUTE_MIN_H);
    if (targetW !== curW || targetH !== curH) {
      await appWindow.setSize(new LogicalSize(targetW, targetH));
    }
  } catch (e) {
    logError('window-size', 'window sizing failed', e);
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

// Window-edge resize handles ─────────────────────────────────────────
// `decorations: false` means the OS doesn't service edge-drag-resize
// or change the cursor near the border. Each `.resize-handle` carries
// its direction in `data-resize` (PascalCase to match Tauri's
// `ResizeDirection` enum). On left-mousedown we hand the gesture off
// to the WM via `startResizeDragging` — from there it's identical to
// dragging the edge of a native window.
document.querySelectorAll('#resize-handles .resize-handle').forEach((handle) => {
  const direction = handle.dataset.resize;
  if (!direction) return;
  handle.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    // Belt-and-suspenders: CSS already hides handles in these states
    // via `body.maximized` / `body.fullscreen`, but a stale class
    // would otherwise let a mousedown sneak through and call
    // `startResizeDragging` on an un-resizable window.
    const body = document.body.classList;
    if (body.contains('maximized') || body.contains('fullscreen')) return;
    e.preventDefault();
    try {
      await appWindow.startResizeDragging(direction);
    } catch (err) {
      logError('window-resize', `startResizeDragging ${direction} failed`, err);
    }
  });
});
