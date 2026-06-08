// Blocking error dialog. Call showErrorModal(title, message) for any
// user-initiated operation failure (save, open, export, etc.) that the
// user must explicitly acknowledge before continuing. Background warnings
// are logged silently and never shown here.

import { state, errorOverlay, errorDialogTitle, errorDialogBody, errorOkBtn } from '../core/state.ts';
import { logError } from '../core/logger.ts';

let errorResolve: (() => void) | null = null;
let errorLastFocus: Element | null = null;

function openErrorDialog() {
  errorOverlay.classList.remove('hidden');
  state.errorDialogOpen = true;
  errorLastFocus = document.activeElement;
  requestAnimationFrame(() => errorOkBtn.focus());
  return new Promise<void>((resolve) => { errorResolve = resolve; });
}

function closeErrorDialog() {
  if (!errorResolve) return;
  const r = errorResolve;
  errorResolve = null;
  errorOverlay.classList.add('closing');
  setTimeout(() => {
    errorOverlay.classList.remove('closing');
    errorOverlay.classList.add('hidden');
    state.errorDialogOpen = false;
    if (errorLastFocus && document.contains(errorLastFocus)) {
      (errorLastFocus as HTMLElement).focus();
    }
    errorLastFocus = null;
    r();
  }, 200);
}

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
