// Shared confirm dialog (unsaved-changes, draft-recovery, settings).
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
// drives both initial focus and what Enter resolves to.
let confirmPrimary = 'save';

// `saveHidden` lets the toolbar's Discard flow reuse this dialog as a
// pure confirm (the user already chose to discard — Save would be
// nonsensical). `primary` selects which button gets the initial focus
// and the Enter accelerator: 'save' for the unsaved-changes prompt,
// 'discard' for the explicit Discard click, 'cancel' otherwise.
function setConfirmContents({ title, bodyHtml, saveLabel, discardLabel, cancelHidden, saveHidden, primary }: any) {
  confirmDialogTitle.textContent = title;
  confirmDialogBody.innerHTML = bodyHtml;
  confirmSaveBtn.textContent = saveLabel ?? 'Save';
  confirmDiscardBtn.textContent = discardLabel ?? 'Discard';
  confirmCancelBtn.hidden = !!cancelHidden;
  confirmSaveBtn.hidden = !!saveHidden;
  confirmPrimary = primary || 'save';
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

function openConfirmDialog() {
  // showModal() gives the focus trap + inert background natively, and
  // restores focus to the trigger on close(). The rAF below moves the
  // initial focus from showModal's first-focusable to the primary button.
  if (!confirmOverlay.open) confirmOverlay.showModal();
  state.confirmDialogOpen = true;
  requestAnimationFrame(() => {
    const target = confirmPrimary === 'discard' ? confirmDiscardBtn
                 : confirmPrimary === 'cancel'  ? confirmCancelBtn
                 : confirmSaveBtn;
    if (target && !target.hidden) target.focus();
    else confirmCancelBtn.focus();
  });
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
  if (e.target === confirmOverlay) closeConfirmDialog('cancel');
});
document.addEventListener('keydown', (e) => {
  if (!state.confirmDialogOpen) return;
  if (e.key === 'Escape') { e.preventDefault(); closeConfirmDialog('cancel'); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    closeConfirmDialog(confirmPrimary === 'cancel' ? 'cancel'
                     : confirmPrimary === 'discard' ? 'discard'
                     : 'save');
  }
});
