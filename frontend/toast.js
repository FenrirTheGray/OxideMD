// Lightweight toast notifications. This is the app's first real toast
// system, so it's deliberately small, dependency-free, and reusable —
// other modules can `import { showToast } from './toast.js'` later.
//
// A toast is a `.toast` card appended into the `#toast-container`
// element (a fixed, bottom-right, stacked column declared in
// index.html). Toasts stack newest-at-the-bottom, auto-dismiss after a
// short delay with a fade/slide-out transition, and remove their own
// DOM node once that exit transition finishes.

// How long a toast stays fully visible before it starts fading out.
const TOAST_LIFETIME_MS = 4000;
// Must match the exit transition duration in style.css (`.toast.leaving`)
// — once the slide-out animation has run this long we drop the node.
const TOAST_EXIT_MS = 260;

// Resolved lazily on first use so import order vs. DOM readiness can't
// bite us — by the time anything calls showToast() the container exists.
let container = null;

/**
 * Show a toast notification.
 * @param {string} message - text to display.
 * @param {'success'|'error'} [kind='success'] - accent variant.
 */
export function showToast(message, kind = 'success') {
  if (!container) container = document.getElementById('toast-container');
  // No container in the DOM (shouldn't happen) → fail quietly rather
  // than throw into whatever called us.
  if (!container) return;

  // Build the toast card. `role="status"` so assistive tech announces
  // it; the container itself is `aria-live="polite"` as a backstop.
  const toast = document.createElement('div');
  toast.className = `toast ${kind === 'error' ? 'error' : 'success'}`;
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  container.appendChild(toast);

  // Tear the toast down: play the exit transition, then remove the node
  // after it finishes. Guarded so the auto-dismiss timer and any future
  // manual dismiss can't double-run it.
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), TOAST_EXIT_MS);
  };

  // Auto-dismiss after the visible lifetime elapses.
  setTimeout(dismiss, TOAST_LIFETIME_MS);
}
