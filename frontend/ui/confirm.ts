// Shared confirm dialog (unsaved-changes, draft-recovery, settings,
// destructive deletes).
//
// One overlay, three buttons (cancel / discard / save) wired to a
// resolve-on-click promise. `setConfirmContents` rewrites the title and
// body each open so the same DOM serves every prompt. Cancel is hidden
// for the recovery flow; Escape still resolves to 'cancel' there, which
// means "leave the draft in place for next time".
//
// Lives outside editor/editor.ts on purpose: the settings prompts (and
// the unsaved-changes prompt on tab close) must work in read mode, and
// editor.ts is loaded lazily because it drags in all of CodeMirror.

import {
  state,
  confirmOverlay, confirmDialogTitle, confirmDialogBody,
  confirmCancelBtn, confirmDiscardBtn, confirmSaveBtn,
} from "../core/state.ts";
import { escapeHtml } from "../lib/escape.ts";

let confirmResolve = null;
// Which button is the "primary" action for the current dialog open —
// what Enter resolves to.
let confirmPrimary = 'save';
// Whether a click on the dim backdrop cancels the current open.
let confirmBackdropCloses = true;

// `saveHidden` lets the toolbar's Discard flow reuse this dialog as a
// pure confirm (the user already chose to discard — Save would be
// nonsensical). `primary` selects which button Enter activates:
// 'save' for the unsaved-changes prompt,
// 'discard' for the explicit Discard click, 'cancel' otherwise.
// `backdropCloses: false` leaves the buttons and Escape as the only exits.
export function setConfirmContents({ title, bodyHtml, saveLabel, discardLabel, cancelHidden, saveHidden, discardHidden, primary, backdropCloses = true }: any) {
  confirmDialogTitle.textContent = title;
  confirmDialogBody.innerHTML = bodyHtml;
  confirmSaveBtn.textContent = saveLabel ?? 'Save';
  confirmDiscardBtn.textContent = discardLabel ?? 'Discard';
  confirmCancelBtn.hidden = !!cancelHidden;
  confirmSaveBtn.hidden = !!saveHidden;
  confirmDiscardBtn.hidden = !!discardHidden;
  confirmPrimary = primary || 'save';
  confirmBackdropCloses = backdropCloses;
  // A prompt may disable its primary until the form is filled; start enabled.
  (confirmSaveBtn as HTMLButtonElement).disabled = false;
}

export function promptUnsavedChanges(tab) {
  setConfirmContents({
    title: 'Unsaved changes',
    bodyHtml: `You have unsaved changes in <span class="confirm-file-name">${escapeHtml(tab.title || 'this file')}</span>. What would you like to do?`,
    saveLabel: 'Save',
    discardLabel: 'Discard',
    cancelHidden: false,
    primary: 'save',
  });
  return openConfirmDialog();
}

export function promptDiscardChanges(tab) {
  setConfirmContents({
    title: 'Discard changes',
    bodyHtml: `Discard unsaved changes to <span class="confirm-file-name">${escapeHtml(tab.title || 'this file')}</span>? This can't be undone.`,
    discardLabel: 'Discard',
    cancelHidden: false,
    saveHidden: true,
    primary: 'cancel',
  });
  return openConfirmDialog();
}

// Warn when the file changed on disk since it was opened (another tool /
// machine) and the user is about to overwrite it with an in-app save.
// Resolves 'save' to overwrite, 'cancel' to abort the save. Cancel is
// primary so a stray Enter/Escape protects the external edit.
export function promptOverwriteChanged(tab) {
  setConfirmContents({
    title: 'File changed on disk',
    bodyHtml: `<span class="confirm-file-name">${escapeHtml(tab.title || 'This file')}</span> has changed on disk since you opened it. Saving now will overwrite those changes.`,
    saveLabel: 'Overwrite',
    cancelHidden: false,
    saveHidden: false,
    discardHidden: true, // two-button shape: Save(=Overwrite) + Cancel
    primary: 'cancel',
  });
  return openConfirmDialog();
}

// Confirm before the Settings "Reset defaults" button clobbers config.
// Reuses the shared confirm overlay as a pure two-button confirm (Save
// is hidden — there's nothing to save). The "Discard" button is
// relabelled "Reset" and is the destructive action; Cancel is primary
// so a stray Enter/Escape leaves the user's settings untouched.
// Resolves 'discard' to proceed with the reset, 'cancel' otherwise.
export function promptResetSettings(tabLabel) {
  setConfirmContents({
    title: 'Reset to defaults',
    bodyHtml: `Reset the <span class="confirm-file-name">${escapeHtml(tabLabel || 'current')}</span> settings to their defaults? Your other settings tabs are left untouched. This is applied when you Save.`,
    discardLabel: 'Reset',
    cancelHidden: false,
    saveHidden: true,
    primary: 'cancel',
  });
  return openConfirmDialog();
}

// Generic destructive confirm (remove a font / theme, delete a tree entry).
// Two buttons: Cancel is primary so a stray Enter is safe; the action
// button is relabelled. Resolves true to proceed. Replaces native
// `confirm()`, which Tauri's dialog plugin shims into an async call — the
// return value is a Promise, so `!confirm()` was always false.
export function promptDelete({ title, bodyHtml, actionLabel = 'Delete' }: { title: string, bodyHtml: string, actionLabel?: string }) {
  setConfirmContents({
    title,
    bodyHtml,
    discardLabel: actionLabel,
    cancelHidden: false,
    saveHidden: true,
    primary: 'cancel',
  });
  return openConfirmDialog().then((decision) => decision === 'discard');
}

// Confirm before closing Settings with unsaved changes. Reuses the shared
// confirm overlay: Save commits the pending settings then closes, Discard
// closes without saving, Cancel keeps the dialog open. Both the header ✕ and
// the footer Close route through closeSettings, so both get this prompt.
// Resolves 'save' | 'discard' | 'cancel'.
export function promptDiscardSettings() {
  setConfirmContents({
    title: 'Unsaved settings',
    bodyHtml: `You have unsaved changes in <span class="confirm-file-name">Settings</span>. Save them, or discard and close?`,
    saveLabel: 'Save',
    discardLabel: 'Discard',
    cancelHidden: false,
    primary: 'save',
  });
  return openConfirmDialog();
}

// Returns 'save' (restore), 'discard', or 'cancel' (leave draft alone).
// When `conflict` is true, the on-disk content has changed since the
// draft was last written — surface that so the user knows restoring the
// draft will overwrite a newer disk edit.
export function promptRecoverDraft(tab, draft, { conflict = false } = {}) {
  const when = formatDraftTimestamp(draft.savedAt);
  const baseHtml = `An unsaved draft of <span class="confirm-file-name">${escapeHtml(tab.title || 'this file')}</span> was found from ${escapeHtml(when)}.`;
  const conflictHtml = conflict
    ? ` <strong class="confirm-conflict">The file on disk has changed since this draft was written.</strong> Restoring will overwrite that newer disk content.`
    : ' Restore it, or open the saved version?';
  setConfirmContents({
    title: conflict ? 'Recover draft (file changed on disk)' : 'Recover unsaved draft',
    bodyHtml: baseHtml + conflictHtml,
    saveLabel: 'Restore',
    discardLabel: 'Discard draft',
    cancelHidden: !conflict,
    primary: conflict ? 'cancel' : 'save',
  });
  return openConfirmDialog();
}

// Single-field text prompt (rename / new folder) reusing the shared
// confirm overlay. Resolves the trimmed input on confirm, null on cancel.
// The body is static markup — no interpolated content, nothing to escape.
export function promptText({ title, saveLabel, initial }: { title: string, saveLabel: string, initial?: string }) {
  setConfirmContents({
    title,
    bodyHtml: `<input type="text" id="confirm-text-input" class="confirm-text-input" spellcheck="false" autocomplete="off">`,
    saveLabel,
    cancelHidden: false,
    discardHidden: true,
    primary: 'save',
  });
  const promise = openConfirmDialog();
  const input = document.getElementById('confirm-text-input') as HTMLInputElement;
  input.value = initial ?? '';
  // No autofocus (nothing is highlighted until Tab). On first focus,
  // preselect the stem so typing replaces the name but keeps the extension;
  // a frame later, so it lands after the browser's own select-all on Tab.
  input.addEventListener('focus', () => requestAnimationFrame(() => {
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }), { once: true });
  return promise.then((decision) => {
    const value = input.value.trim();
    return decision === 'save' && value ? value : null;
  });
}

function formatDraftTimestamp(ts) {
  if (typeof ts !== 'number') return 'an earlier session';
  const ageMs = Date.now() - ts;
  if (ageMs < 60_000) return 'less than a minute ago';
  if (ageMs < 3_600_000) {
    const m = Math.round(ageMs / 60_000);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (ageMs < 86_400_000) {
    const h = Math.round(ageMs / 3_600_000);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  try { return new Date(ts).toLocaleString(); } catch { return 'an earlier session'; }
}

export function openConfirmDialog() {
  // showModal() gives the focus trap + inert background natively, and
  // restores focus to the trigger on close(). It focuses the first control;
  // move that to the dialog itself so nothing is highlighted until Tab.
  // Enter (primary) and Escape are document-level, so they work regardless.
  if (!confirmOverlay.open) confirmOverlay.showModal();
  confirmOverlay.focus();
  state.confirmDialogOpen = true;
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirmDialog(decision) {
  if (!confirmResolve) return;
  const r = confirmResolve;
  confirmResolve = null;
  confirmOverlay.classList.add('closing');
  setTimeout(() => {
    confirmOverlay.close();
    confirmOverlay.classList.remove('closing');
    state.confirmDialogOpen = false;
    r(decision);
  }, 200);
}

// Escape closes via the keydown handler below (resolving 'cancel'); block
// the native dialog Escape so it can't close instantly without resolving.
confirmOverlay.addEventListener('cancel', (e) => e.preventDefault());

confirmSaveBtn.addEventListener('click', () => closeConfirmDialog('save'));
confirmDiscardBtn.addEventListener('click', () => closeConfirmDialog('discard'));
confirmCancelBtn.addEventListener('click', () => closeConfirmDialog('cancel'));
confirmOverlay.addEventListener('click', (e) => {
  if (e.target === confirmOverlay && confirmBackdropCloses) closeConfirmDialog('cancel');
});
document.addEventListener('keydown', (e) => {
  if (!state.confirmDialogOpen) return;
  if (e.key === 'Escape') { e.preventDefault(); closeConfirmDialog('cancel'); }
  else if (e.key === 'Enter') {
    // A button the user tabbed to activates itself (native click); Enter
    // anywhere else in the dialog (text input, body) means the primary.
    if (document.activeElement?.closest('button')) return;
    e.preventDefault();
    const decision = confirmPrimary === 'cancel' ? 'cancel'
                   : confirmPrimary === 'discard' ? 'discard'
                   : 'save';
    // A primary disabled until its form is filled can't be forced by Enter.
    const btn = { cancel: confirmCancelBtn, discard: confirmDiscardBtn, save: confirmSaveBtn }[decision] as HTMLButtonElement;
    if (!btn.disabled) closeConfirmDialog(decision);
  }
});
