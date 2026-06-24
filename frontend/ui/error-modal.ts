// Blocking error dialog. Call showErrorModal(title, message) for any
// user-initiated operation failure (save, open, export, etc.) that the
// user must explicitly acknowledge before continuing. Background warnings
// are logged silently and never shown here.

import { state, errorOverlay, errorDialogTitle, errorDialogBody, errorOkBtn } from '../core/state.ts';
import { logError } from '../core/logger.ts';

let errorResolve: (() => void) | null = null;

function openErrorDialog() {
  // Native showModal() traps focus, inerts the background, and restores
  // focus to the trigger on close().
  if (!errorOverlay.open) errorOverlay.showModal();
  state.errorDialogOpen = true;
  requestAnimationFrame(() => errorOkBtn.focus());
  return new Promise<void>((resolve) => { errorResolve = resolve; });
}

function closeErrorDialog() {
  if (!errorResolve) return;
  const r = errorResolve;
  errorResolve = null;
  errorOverlay.classList.add('closing');
  setTimeout(() => {
    errorOverlay.close();
    errorOverlay.classList.remove('closing');
    state.errorDialogOpen = false;
    r();
  }, 200);
}

// Escape closes via the keydown handler below; block the native dialog
// Escape so it can't bypass the close animation / resolve.
errorOverlay.addEventListener('cancel', (e) => e.preventDefault());

errorOkBtn.addEventListener('click', closeErrorDialog);
errorOverlay.addEventListener('click', (e) => {
  if (e.target === errorOverlay) closeErrorDialog();
});

document.addEventListener('keydown', (e) => {
  if (!state.errorDialogOpen) return;
  if (e.key === 'Escape' || e.key === 'Enter') {
    e.preventDefault();
    closeErrorDialog();
  }
});

/**
 * Show a blocking error modal for a failed user-initiated operation.
 * Logs the error to the daily file and to tauri-plugin-log, then waits
 * for the user to dismiss the dialog before resolving.
 */
export async function showErrorModal(title: string, message: string, err?: unknown) {
  logError(title, message, err);
  errorDialogTitle.textContent = title;
  errorDialogBody.textContent = err != null ? `${message}\n\n${String(err)}` : message;
  await openErrorDialog();
}
