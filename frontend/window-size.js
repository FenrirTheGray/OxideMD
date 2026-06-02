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
import { updateTabOverflow } from './tabs.js';

const { LogicalSize } = window.__TAURI__.window;

const toolbarButtons = document.getElementById('toolbar-buttons');
const windowControls = document.getElementById('window-controls');
const sidebarEl = document.getElementById('sidebar');
const btnMore = document.getElementById('btn-more');
const moreMenu = document.getElementById('more-menu');

// At/below this width the sidebars become overlay drawers instead of
// pushing the document (see the ≤720px block in style.css). Kept in sync
// with that breakpoint.
const NARROW_BP = 720;

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
  updateToolbarLayout();
  updateNarrow();
}));

// Responsive drawer mode ─────────────────────────────────────────────
// Toggle `body.narrow` so CSS can switch the sidebars to overlay drawers,
// and on each wide↔narrow transition reset the file-tree drawer: collapse
// it on entering narrow (so it doesn't suddenly cover the document) and
// clear the collapse on leaving (so it re-docks). Only the *edge* is
// acted on, so dragging within narrow mode never fights the user's open
// drawer. The collapse class is inert in the wide layout.
let wasNarrow = null;
export function updateNarrow() {
  const isNarrow = window.innerWidth <= NARROW_BP;
  document.body.classList.toggle('narrow', isNarrow);
  if (isNarrow !== wasNarrow) {
    wasNarrow = isNarrow;
    if (sidebarEl) sidebarEl.classList.toggle('collapsed', isNarrow);
  }
}

// Responsive toolbar ─────────────────────────────────────────────────────
// The toolbar degrades in two stages as the window narrows so the window
// controls are NEVER pushed off-screen (on a borderless window the close
// button must always be reachable):
//   Stage 1  drop the button text labels (`.compact-auto`).
//   Stage 2  relocate the lowest-priority buttons into the #more-menu
//            popover, leaving a "⋯" trigger in their place.
// Stage 2 moves the actual <button> elements (not clones), so their event
// handlers and toggle state ride along; the CSS chip/label-hiding rules are
// ID-scoped to #toolbar-buttons, so a relocated button automatically
// renders as a full-width menu row with its label shown.

// Buttons in their natural left-to-right toolbar order. Used to restore
// them and to keep the menu in a stable, familiar order.
const TOOLBAR_ORDER = [
  'btn-new', 'btn-open', 'btn-open-folder', 'btn-reload', 'btn-mode-toggle',
  'btn-search', 'btn-preview', 'btn-outline', 'btn-print', 'btn-settings',
];
// Order in which buttons leave the toolbar for the menu (least essential
// first), so the most-used actions stay as quick icons the longest.
const OVERFLOW_ORDER = [
  'btn-print', 'btn-reload', 'btn-open-folder', 'btn-open', 'btn-new',
  'btn-preview', 'btn-outline', 'btn-search', 'btn-mode-toggle', 'btn-settings',
];

// Cached natural (label-on) width of the toolbar action cluster, measured
// with the compact classes stripped so it reflects the un-compacted layout
// even when the user has `toolbar_compact` enabled at launch.
let naturalToolbarWidth = 0;
// Hysteresis buffers (px) so dragging the edge across a threshold doesn't
// flicker labels (stage 1) or buttons (stage 2) in and out.
const COMPACT_HYSTERESIS = 24;
const OVERFLOW_HYSTERESIS = 24;
// Tab-strip width to protect before stage 1 (drop labels) and before
// stage 2 (start overflowing buttons). Stage 2's reserve is smaller — we
// only banish buttons to the menu once even icon-only ones would starve
// the active tab.
const TAB_AREA_RESERVE = 200;
const OVERFLOW_RESERVE = 120;

// Pull every relocated button back into the toolbar, in natural order,
// ahead of the trailing "⋯" trigger.
function restoreToolbarButtons() {
  if (!toolbarButtons) return;
  for (const id of TOOLBAR_ORDER) {
    const btn = document.getElementById(id);
    if (btn && btn.parentElement !== toolbarButtons) {
      toolbarButtons.insertBefore(btn, btnMore);
    }
  }
}

function primeNaturalToolbarWidth() {
  if (!toolbarButtons) return;
  const hadAuto = toolbarButtons.classList.contains('compact-auto');
  const hadCompact = toolbarButtons.classList.contains('compact');
  restoreToolbarButtons();
  if (btnMore) btnMore.classList.add('hidden');
  toolbarButtons.classList.remove('compact-auto', 'compact');
  // Force a reflow by reading offsetWidth after the class change.
  naturalToolbarWidth = toolbarButtons.offsetWidth;
  if (hadCompact) toolbarButtons.classList.add('compact');
  if (hadAuto) toolbarButtons.classList.add('compact-auto');
}

export function updateToolbarLayout() {
  if (!toolbarButtons || !naturalToolbarWidth) return;

  // Sticky-state snapshot (for hysteresis) before we reset the baseline.
  const wasAutoCompact = toolbarButtons.classList.contains('compact-auto');
  const wasOverflowing = btnMore && !btnMore.classList.contains('hidden');

  // Baseline: everything docked, labels per the user's preference only.
  restoreToolbarButtons();
  toolbarButtons.classList.remove('compact-auto');
  if (btnMore) btnMore.classList.add('hidden');

  const logoEl = document.getElementById('btn-logo');
  const logoW = logoEl ? logoEl.offsetWidth : 0;
  const winCtrlW = visible(windowControls) ? windowControls.offsetWidth : 0;
  const base = window.innerWidth - logoW - winCtrlW;
  const userCompact = toolbarButtons.classList.contains('compact');

  // Stage 1 — drop labels. (Skipped when the user already forced compact.)
  if (!userCompact) {
    const trigger = wasAutoCompact
      ? naturalToolbarWidth + COMPACT_HYSTERESIS
      : naturalToolbarWidth;
    if (trigger > base - TAB_AREA_RESERVE) {
      toolbarButtons.classList.add('compact-auto');
    }
  }

  // Stage 2 — overflow the cluster into the menu until it fits while
  // leaving OVERFLOW_RESERVE px for the tab strip. The "⋯" trigger's own
  // width is included by revealing it before we measure.
  const budget =
    base - OVERFLOW_RESERVE - (wasOverflowing ? OVERFLOW_HYSTERESIS : 0);
  if (btnMore && toolbarButtons.scrollWidth > budget) {
    btnMore.classList.remove('hidden');
    for (const id of OVERFLOW_ORDER) {
      if (toolbarButtons.scrollWidth <= budget) break;
      const btn = document.getElementById(id);
      if (btn) moreMenu.appendChild(btn);
    }
    // Normalize the menu to natural toolbar order.
    for (const id of TOOLBAR_ORDER) {
      const btn = document.getElementById(id);
      if (btn && btn.parentElement === moreMenu) moreMenu.appendChild(btn);
    }
  } else {
    closeMoreMenu();
  }

  // The cluster width changed, so the tab strip's overflow state may have
  // too (e.g. a single tab that no longer needs scroll arrows).
  updateTabOverflow();
}

// ── Overflow menu open/close ─────────────────────────────────────────
function positionMoreMenu() {
  if (!btnMore || !moreMenu) return;
  const rect = btnMore.getBoundingClientRect();
  // Right-align to the trigger so the menu never spills off the edge.
  moreMenu.style.top = `${Math.round(rect.bottom + 4)}px`;
  moreMenu.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
  moreMenu.style.left = 'auto';
}
function openMoreMenu() {
  if (!moreMenu || !btnMore) return;
  positionMoreMenu();
  moreMenu.classList.remove('hidden');
  moreMenu.setAttribute('aria-hidden', 'false');
  btnMore.setAttribute('aria-expanded', 'true');
}
export function closeMoreMenu() {
  if (!moreMenu || !btnMore) return;
  moreMenu.classList.add('hidden');
  moreMenu.setAttribute('aria-hidden', 'true');
  btnMore.setAttribute('aria-expanded', 'false');
}

if (btnMore) {
  btnMore.addEventListener('click', (e) => {
    e.preventDefault();
    if (moreMenu.classList.contains('hidden')) openMoreMenu();
    else closeMoreMenu();
  });
}
if (moreMenu) {
  // Activating any relocated action closes the menu.
  moreMenu.addEventListener('click', (e) => {
    if (e.target.closest('button')) closeMoreMenu();
  });
}
// Click-outside and Escape close the menu.
document.addEventListener('mousedown', (e) => {
  if (!moreMenu || moreMenu.classList.contains('hidden')) return;
  if (moreMenu.contains(e.target) || (btnMore && btnMore.contains(e.target))) return;
  closeMoreMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && moreMenu && !moreMenu.classList.contains('hidden')) {
    closeMoreMenu();
    if (btnMore) btnMore.focus();
  }
});

let compactRafId = 0;
window.addEventListener('resize', () => {
  if (compactRafId) return;
  compactRafId = requestAnimationFrame(() => {
    compactRafId = 0;
    updateToolbarLayout();
    updateNarrow();
    // Keep the menu anchored to its (possibly moved) trigger.
    if (moreMenu && !moreMenu.classList.contains('hidden')) positionMoreMenu();
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
