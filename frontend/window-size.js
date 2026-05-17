// Window-min-size cap, on-launch geometry clamp, and responsive
// toolbar compact mode.
//
// Min size scales with the display: 1/4 of `screen.{width,height}` on
// each axis, floored at 480×270 (1/4 of a 1920×1080 baseline). On a
// 4K monitor the floor is 960×540; on a sub-1080p panel the floor
// pins at 480×270 so the window is still usable. Both min and current
// size are capped against `screen.avail{Width,Height}` so we never
// ask the OS for a min larger than the workspace — that would leave
// the window pinned above the screen with un-grabbable edges.
//
// On resize we toggle `.compact-auto` on #toolbar-buttons to hide the
// text labels when the toolbar would otherwise crowd the tab area.
// The user's `toolbar_compact` setting uses `.compact` — the two
// classes compose, so the auto behavior survives the user toggling
// their preference and vice versa.

import { appWindow } from './state.js';
import { logError } from './logger.js';

const { LogicalSize } = window.__TAURI__.window;

const toolbarButtons = document.getElementById('toolbar-buttons');
const windowControls = document.getElementById('window-controls');

// Floor: 1/4 of 1920×1080. Mirrors tauri.conf.json so the OS, the
// cap math, and the config agree.
const ABSOLUTE_MIN_W = 480;
const ABSOLUTE_MIN_H = 270;
// Slack between the requested size and the monitor's available
// dimensions. Leaves room for OS chrome the webview can't see (Windows
// taskbar, GNOME top bar/dock, macOS menu/dock) and keeps the window
// draggable instead of being pinned to the screen edges.
const SCREEN_SLACK = 80;

function visible(el) {
  return el && !el.classList.contains('hidden') && !el.hidden;
}

// Cap against `screen.avail{Width,Height}` so a generous display-
// scaled min never exceeds what the workspace can hold. Webview
// reports CSS pixels here, matching `LogicalSize`.
function capDim(measured, avail, floor) {
  if (avail > 0) {
    const cap = Math.max(floor, avail - SCREEN_SLACK);
    return Math.max(floor, Math.min(measured, cap));
  }
  return Math.max(floor, measured);
}

requestAnimationFrame(() => requestAnimationFrame(async () => {
  try {
    const dispW  = (window.screen && window.screen.width)       || 1920;
    const dispH  = (window.screen && window.screen.height)      || 1080;
    const availW = (window.screen && window.screen.availWidth)  || 0;
    const availH = (window.screen && window.screen.availHeight) || 0;
    const minW = capDim(Math.max(ABSOLUTE_MIN_W, Math.floor(dispW / 4)), availW, ABSOLUTE_MIN_W);
    const minH = capDim(Math.max(ABSOLUTE_MIN_H, Math.floor(dispH / 4)), availH, ABSOLUTE_MIN_H);
    await appWindow.setMinSize(new LogicalSize(minW, minH));

    // If a previous run, a stale persisted state, or the configured
    // default opened the window larger than the cap permits, pull it
    // back on both axes so the title bar stays on-screen and both
    // edges stay grabbable. Only writes when something is actually
    // out-of-bounds, so the common case is a no-op.
    const curW = Math.ceil(window.innerWidth);
    const curH = Math.ceil(window.innerHeight);
    const targetW = capDim(curW, availW, minW);
    const targetH = capDim(curH, availH, minH);
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
