// Edit / save lifecycle for the active tab.
// Tabs carry `raw` (current editor buffer), `savedRaw` (last-saved disk
// content, used to detect dirty state), and `editing` (true while the
// CodeMirror view is mounted). Only one tab is "active"/rendered at a
// time; switching tabs preserves the other tabs' edit state in memory.

import {
  invoke, convertFileSrc,
  state,
  contentEl, contentScroll,
  editorSplit, editorPane, previewPane, splitDivider,
  btnSave, btnDiscard,
  statusIndicator, statusText, statusCountsEl,
  confirmOverlay, confirmDialogTitle, confirmDialogBody,
  confirmCancelBtn, confirmDiscardBtn, confirmSaveBtn,
} from './state.js';
import {
  activeTab, renderContent, syncToolbar, renderTabBar,
  setLoading, clearStatus, applyZoom,
} from './tabs.js';
import { closeSearch } from './search.js';
import { applyFormat } from './editor-format.js';
import { registerHandler, dispatchKey } from './keybindings.js';
import { writeDraft, clearDraft } from './draft-store.js';

import { EditorView, keymap } from '@codemirror/view';
import { EditorState, EditorSelection, Prec } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel, closeSearchPanel } from '@codemirror/search';

// Suppress fs-changed handling for a short window after save — our own
// write triggers the watcher, which would otherwise round-trip and wipe
// the tab's raw buffer back to disk content.
const SAVE_SUPPRESS_MS = 1500;
export function saveRecentlyFor(path) {
  return !!path
    && state.lastSaveAt
    && (Date.now() - state.lastSaveAt) < SAVE_SUPPRESS_MS
    && state.lastSavedPath === path;
}

export function isDirty(tab) {
  if (!tab) return false;
  if (!tab.editing) return false;
  return (tab.raw ?? '') !== (tab.savedRaw ?? '');
}

// Module-level handle to the current EditorView. The CM6 scroller
// (view.scrollDOM) is the actual scrolling element, not editor-pane.
let editorView = null;

// Exposed so other modules (tabs.js, contextmenu.js) can read the live
// buffer and scroll position without poking at the DOM.
export function getEditorView() { return editorView; }
export function getEditorValue() {
  return editorView ? editorView.state.doc.toString() : null;
}
export function getEditorScrollTop() {
  return editorView ? editorView.scrollDOM.scrollTop : 0;
}

// ── Split layout (per-tab) ─────────────────────────────────────────────
// Tabs carry `editorSplit` (0–100, the editor pane's % width) and
// `splitMode` ('split' | 'editor' | 'preview'). Both are restored every
// time we mount an editor, so switching tabs preserves the layout the
// user set on each.
const SPLIT_MODES = ['split', 'editor', 'preview'];
const SPLIT_MIN = 15, SPLIT_MAX = 85, SPLIT_DEFAULT = 50;

function setSplitFrac(percent, persist) {
  const p = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, percent));
  editorSplit.style.setProperty('--editor-frac', p.toFixed(2) + '%');
  splitDivider.setAttribute('aria-valuenow', String(Math.round(p)));
  if (persist) {
    const tab = activeTab();
    if (tab) tab.editorSplit = p;
  }
}

function applySplitMode(mode, persist) {
  const m = SPLIT_MODES.includes(mode) ? mode : 'split';
  editorSplit.classList.remove('split-mode-editor', 'split-mode-preview');
  if (m !== 'split') editorSplit.classList.add(`split-mode-${m}`);
  if (persist) {
    const tab = activeTab();
    if (tab) tab.splitMode = m;
  }
}

function applySplitToTab(tab) {
  setSplitFrac(typeof tab.editorSplit === 'number' ? tab.editorSplit : SPLIT_DEFAULT, false);
  applySplitMode(tab.splitMode || 'split', false);
}

// ── Word + char counts (edit mode) ─────────────────────────────────────
// Cheap regex pass on the raw buffer; runs on every doc change + on mount.
// Counts source markdown verbatim (including syntax characters) to avoid
// tying this to the render pipeline. Visibility is driven by CSS
// (`body:not(.editing) #status-counts { display: none }`) so we only have
// to keep the text fresh — switching to a non-editing tab hides the prior
// tab's counts without needing a hideCounts() call.
function updateCounts(value) {
  if (!statusCountsEl) return;
  const text = value ?? '';
  if (!text) {
    statusCountsEl.textContent = '0 words · 0 chars';
    return;
  }
  const words = (text.match(/\S+/g) || []).length;
  statusCountsEl.textContent = `${words} word${words === 1 ? '' : 's'} · ${text.length} chars`;
}

// ── Smart list / quote continuation on Enter ─────────────────────────
// When the cursor is at the end of a list-item or blockquote line,
// pressing Enter inserts the next marker for the user (`- `, `2. `,
// `> `, `- [ ] `). When the line is just an empty marker — meaning the
// user pressed Enter twice in a row to break out of the list — we
// remove the marker and return a true blank line. Anything else falls
// through to CM6's defaultKeymap so plain Enter still inserts a newline.
const LIST_LINE  = /^(\s*)([-*+]|\d+\.)(\s+\[[ xX]\])?(\s+)(.*)$/;
const QUOTE_LINE = /^(\s*)(>+)(\s+)(.*)$/;

function smartEnter(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.from);
  // Only continue the marker when typing at the end of the line; an
  // Enter from inside a word should split the line normally.
  if (sel.from !== line.to) return false;

  let m = LIST_LINE.exec(line.text);
  if (m) {
    const indent  = m[1];
    const marker  = m[2];
    const taskBox = m[3];
    const sep     = m[4];
    const content = m[5];
    if (content === '') {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from),
      });
      return true;
    }
    let newMarker = marker;
    if (/^\d+\.$/.test(marker)) {
      newMarker = `${parseInt(marker, 10) + 1}.`;
    }
    const insert = '\n' + indent + newMarker + (taskBox != null ? ' [ ]' : '') + sep;
    view.dispatch({
      changes: { from: sel.from, to: sel.from, insert },
      selection: EditorSelection.cursor(sel.from + insert.length),
    });
    return true;
  }

  m = QUOTE_LINE.exec(line.text);
  if (m) {
    const indent  = m[1];
    const quotes  = m[2];
    const sep     = m[3];
    const content = m[4];
    if (content === '') {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from),
      });
      return true;
    }
    const insert = '\n' + indent + quotes + sep;
    view.dispatch({
      changes: { from: sel.from, to: sel.from, insert },
      selection: EditorSelection.cursor(sel.from + insert.length),
    });
    return true;
  }

  return false;
}

const smartListKeymap = Prec.high(keymap.of([
  { key: 'Enter', run: smartEnter },
]));

// CM6 theme: line up font/colors with the previous textarea look so the
// transition is invisible. CSS variables come from style.css so dark/light
// theme switching keeps working.
const oxideCmTheme = EditorView.theme({
  '&': {
    height: '100%',
    flex: '1',
    minWidth: '0',
    background: 'var(--bg)',
    color: 'var(--fg)',
    fontFamily: '"Cascadia Code", "Cascadia Mono", "Fira Code", Consolas, ui-monospace, monospace',
    fontSize: '14px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'inherit',
    lineHeight: '1.7',
  },
  '.cm-content': {
    padding: '28px 0',
    caretColor: 'var(--fg)',
  },
  '.cm-line': {
    padding: '0 32px',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    background: 'var(--accent-glow)',
  },
});

// Build the EditorView for the given tab. The updateListener is the only
// channel from CM6 → app state — a transaction with `docChanged` mirrors
// the new doc into tab.raw, kicks the dirty/draft/preview pipeline, and
// reuses every code path the textarea version already had.
function buildView(tab) {
  const onDocChanged = (newDoc) => {
    const cur = activeTab();
    if (!cur || !cur.editing) return;
    cur.raw = newDoc;
    const dirty = isDirty(cur);
    btnSave.disabled = !dirty;
    if (btnDiscard) btnDiscard.disabled = !dirty;
    const tabEl = document.querySelector(`.tab[data-tab-id="${cur.id}"]`);
    if (tabEl) tabEl.classList.toggle('dirty', dirty);
    updateCounts(newDoc);
    scheduleDraftWrite(cur);
    schedulePreviewRender();
  };

  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged) onDocChanged(u.state.doc.toString());
  });

  const editorState = EditorState.create({
    doc: tab.raw ?? '',
    extensions: [
      history(),
      smartListKeymap,
      search({ top: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        'aria-label': `Edit ${tab.title}`,
        'spellcheck': 'false',
      }),
      oxideCmTheme,
      updateListener,
    ],
  });

  const view = new EditorView({ state: editorState });
  view.dom.classList.add('md-editor');
  view.scrollDOM.addEventListener('scroll', () => mirrorScroll(view.scrollDOM, previewPane), { passive: true });
  return view;
}

// Mounts the split editor/preview layout for the given tab. Shared by
// enterEditMode (initial entry) and applyActiveTab (switching between
// editing tabs): both rebuild the view against the active tab's raw
// buffer and seed the preview from its last render. Container visibility
// is driven by `body.editing` in CSS, so we only fill it here.
export function mountEditor(tab) {
  if (editorView) { try { editorView.destroy(); } catch {} editorView = null; }
  editorPane.innerHTML = '';
  previewPane.innerHTML = '';

  const view = buildView(tab);
  editorPane.appendChild(view.dom);
  editorView = view;

  // Restore this tab's split layout (frac + mode) before the panes paint.
  applySplitToTab(tab);
  updateCounts(tab.raw ?? '');

  // Seed the preview with the last rendered HTML so the pane isn't empty
  // for a frame; then kick off a fresh render to pick up any unsaved edits.
  if (tab.html) setPreviewHtml(tab.html);
  schedulePreviewRender(0);

  requestAnimationFrame(() => {
    view.focus();
    if (typeof tab.editorScrollTop === 'number') view.scrollDOM.scrollTop = tab.editorScrollTop;
    if (typeof tab.previewScrollTop === 'number') previewPane.scrollTop = tab.previewScrollTop;
  });
}

function unmountEditor() {
  if (editorView) { try { editorView.destroy(); } catch {} editorView = null; }
  editorPane.innerHTML = '';
  previewPane.innerHTML = '';
}

function setPreviewHtml(html) {
  previewPane.innerHTML = html;
  // Local images arrive as `<img data-oxide-src="/abs/path">`; rewrite to
  // asset:// URLs so the webview can actually load them.
  for (const img of previewPane.querySelectorAll('img[data-oxide-src]')) {
    img.src = convertFileSrc(img.dataset.oxideSrc);
  }
  // After a re-render the preview's scrollHeight usually grows/shrinks
  // while its scrollTop stays pinned, so proportional alignment with the
  // editor drifts as the user types. Re-mirror once here so the preview
  // tracks the editor without waiting for the next scroll event.
  requestAnimationFrame(() => {
    if (editorView) mirrorScroll(editorView.scrollDOM, previewPane);
  });
}

// ── Draft autosave (per-file localStorage) ───────────────────────────
// Debounced from the doc-change listener: after the user pauses typing,
// the current buffer is mirrored into localStorage keyed by the file
// path. A clean buffer (matches savedRaw) clears the draft instead of
// writing one, so closing the file after a save leaves no stale entry.
//
// One shared timer across all tabs is intentional — drafts only need to
// catch crashes/window-closes, and tab.raw is still authoritative until
// the app exits, so a momentarily-stale draft on rapid tab switching is
// acceptable. See draft-store.js for the on-disk format.
const DRAFT_DEBOUNCE_MS = 800;
let draftTimer = null;

function scheduleDraftWrite(tab) {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = null;
    if (!tab?.path) return;
    // Don't gate on isDirty() — that returns false the moment a tab
    // exits edit mode (Ctrl+E without saving), which would wipe the
    // draft for a still-dirty in-memory buffer. Compare buffers directly.
    const buf = tab.raw ?? '';
    const disk = tab.savedRaw ?? '';
    if (buf !== disk) writeDraft(tab.path, buf);
    else clearDraft(tab.path);
  }, DRAFT_DEBOUNCE_MS);
}

// Cancel any pending debounced write so a subsequent clearDraft isn't
// undone by a stale timer firing after the user explicitly discarded.
export function cancelPendingDraftWrite() {
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
}

// ── Live preview render (debounced) ──────────────────────────────────
// `previewRenderSeq` guards against out-of-order completions: the tab
// buffer keeps changing while an invoke is in-flight, so we only commit
// the HTML if this request is still the newest one when it returns.
const PREVIEW_DEBOUNCE_MS = 200;
let previewTimer = null;
let previewRenderSeq = 0;

function schedulePreviewRender(delay = PREVIEW_DEBOUNCE_MS) {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    renderPreviewNow();
  }, delay);
}

async function renderPreviewNow() {
  const tab = activeTab();
  if (!tab || !tab.editing) return;
  const seq = ++previewRenderSeq;
  const capturedId = tab.id;
  try {
    const html = await invoke('render_preview', {
      content: tab.raw ?? '',
      path: tab.path ?? '',
    });
    if (seq !== previewRenderSeq) return;
    const cur = activeTab();
    if (!cur || !cur.editing || cur.id !== capturedId) return;
    setPreviewHtml(html);
  } catch (e) {
    console.error('[oxidemd] render_preview failed', e);
  }
}

export async function enterEditMode() {
  const tab = activeTab();
  if (!tab || tab.editing || !tab.path) return;

  // Search works on rendered markdown; close it before swapping to the editor.
  closeSearch();

  // If this tab was opened before `open_file` started returning `raw`
  // (shouldn't happen post-upgrade, but be defensive), fetch it now.
  if (tab.raw == null) {
    setLoading();
    try {
      const result = await invoke('open_file', { path: tab.path });
      tab.raw = result.raw ?? '';
      tab.savedRaw = tab.raw;
      tab.html = result.html;
    } catch {
      clearStatus();
      return;
    }
    clearStatus();
  } else if (tab.savedRaw == null) {
    tab.savedRaw = tab.raw;
  }

  tab.scrollTop = contentScroll.scrollTop;
  tab.editing = true;

  document.body.classList.add('editing');
  mountEditor(tab);

  applyZoom(tab.zoom);
  syncToolbar();
  renderTabBar();
}

export function exitEditMode({ keepHtml = true } = {}) {
  const tab = activeTab();
  if (!tab || !tab.editing) return;
  // Capture pane scroll positions so re-entering edit mode lands where
  // we left off.
  tab.editorScrollTop = editorView ? editorView.scrollDOM.scrollTop : 0;
  tab.previewScrollTop = previewPane.scrollTop;
  tab.editing = false;
  document.body.classList.remove('editing');
  unmountEditor();
  if (keepHtml) renderContent(tab.html);
  applyZoom(tab.zoom);
  syncToolbar();
  renderTabBar();
  requestAnimationFrame(() => { contentScroll.scrollTop = tab.scrollTop || 0; });
}

export async function saveActiveFile() {
  const tab = activeTab();
  if (!tab || !tab.editing || !tab.path) return false;
  if (!isDirty(tab)) return true;

  setLoading();
  try {
    const result = await invoke('save_file', { path: tab.path, content: tab.raw ?? '' });
    tab.html = result.html;
    tab.title = result.title;
    tab.savedRaw = result.raw ?? tab.raw ?? '';
    state.lastSaveAt = Date.now();
    state.lastSavedPath = tab.path;
    clearDraft(tab.path);
    syncToolbar();
    renderTabBar();
    return true;
  } catch (e) {
    if (statusText && statusIndicator) {
      statusText.textContent = `Save failed: ${String(e)}`;
      statusIndicator.classList.remove('hidden');
    }
    return false;
  } finally {
    clearStatus();
  }
}

// Revert the active tab's editor buffer back to disk content. The
// replacement goes through view.dispatch so it lands in CM6's history
// — the user can Ctrl+Z immediately after a discard to recover, which
// matches the dirty-detection logic (raw vs savedRaw) without any
// special casing. Confirms first since intentionally walking forward
// past the discard erases the unsaved work for good. We also tear down
// any pending draft write so the debounced timer doesn't immediately
// re-mirror the now-discarded buffer back into localStorage.
export async function discardActiveFile() {
  const tab = activeTab();
  if (!tab || !tab.editing) return;
  if (!isDirty(tab)) return;
  const decision = await promptDiscardChanges(tab);
  if (decision !== 'discard') return;
  cancelPendingDraftWrite();
  if (tab.path) clearDraft(tab.path);
  const restored = tab.savedRaw ?? '';
  tab.raw = restored;
  if (editorView) {
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: restored },
    });
    editorView.focus();
  }
  btnSave.disabled = true;
  if (btnDiscard) btnDiscard.disabled = true;
  const tabEl = document.querySelector(`.tab[data-tab-id="${tab.id}"]`);
  if (tabEl) tabEl.classList.remove('dirty');
  updateCounts(restored);
  schedulePreviewRender(0);
}

if (btnDiscard) {
  btnDiscard.addEventListener('click', discardActiveFile);
}

// ── Formatting toolbar + editor keyboard shortcuts ───────────────────
// Single delegated handler: each toolbar button carries data-format="…"
// that matches an action in editor-format.js. Keeping this in editor.js
// co-locates all editor-mutating logic.
const editToolbarEl = document.getElementById('edit-toolbar');
if (editToolbarEl) {
  editToolbarEl.addEventListener('mousedown', (e) => {
    // Prevent the click from stealing focus from the editor — otherwise
    // the format dispatch lands while focus is somewhere else.
    if (e.target.closest('.fmt-btn')) e.preventDefault();
  });
  editToolbarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.fmt-btn');
    if (!btn) return;
    const action = btn.dataset.format;
    if (!action) return;
    if (editorView) applyFormat(editorView, action);
  });
}

// Editor-context formatting actions. Registered once at module load so
// the dispatcher can route capture-phase matches to them.
function formatActiveEditor(action) {
  if (editorView && document.body.classList.contains('editing')) {
    applyFormat(editorView, action);
  }
}
// Loop over the format actions whose ids match the applyFormat() dispatcher
// keys 1:1, so the action id can be passed straight through. New format
// actions only need a row in the ACTIONS registry to gain a shortcut.
const EDITOR_FORMAT_ACTIONS = [
  'bold', 'italic', 'strike', 'code',
  'h1', 'h2', 'h3',
  'ul', 'ol', 'task',
  'link', 'image',
  'indent', 'outdent',
];
for (const id of EDITOR_FORMAT_ACTIONS) {
  registerHandler(id, (e) => { e?.preventDefault(); formatActiveEditor(id); });
}

// Lets the global toggleSearch handler route Mod+F to CM6's built-in
// find/replace panel when the editor has focus. Returns true if it
// handled the event so the caller can skip opening the read-mode bar.
// "Has focus" includes CM6's own panels (search input is inside view.dom)
// so a second Mod+F while the panel is already open just refocuses it.
export function tryOpenEditorSearch() {
  if (!editorView) return false;
  const ae = document.activeElement;
  if (!ae || !editorView.dom.contains(ae)) return false;
  openSearchPanel(editorView);
  return true;
}

// Capture-phase dispatch for the CM6 editor. Runs before the bubble-
// phase global handler in app.js *and* before CM6's own keymap (which
// listens on contentDOM, deeper in the tree). On a match we
// stopPropagation so neither layer also runs; on a miss the event keeps
// bubbling so plain typing reaches CM6 untouched and Ctrl+S still
// reaches the global save action.
//
// Scoped to `.cm-content` (the actual edit surface) rather than any
// descendant of `.cm-editor` — otherwise typing in CM6's own panels
// (search bar, etc.) would route Mod+B / Tab to applyFormat() and
// mutate the document instead of the panel input.
document.addEventListener('keydown', (e) => {
  if (!(e.target instanceof Element)) return;
  if (!e.target.closest('.cm-content')) return;
  if (dispatchKey(e, state.bindings, 'editor')) e.stopPropagation();
}, true);

// ── Confirm dialog (unsaved-changes + draft-recovery) ────────────────
// One overlay, three buttons (cancel / discard / save) wired to a
// resolve-on-click promise. The `setConfirmContents` helper rewrites the
// title and body each open so we can reuse the same DOM for both the
// "save before closing?" prompt and the "restore unsaved draft?" prompt.
// Cancel is hidden for the recovery flow; Escape still resolves to
// 'cancel' there, which means "leave the draft in place for next time".
let confirmResolve = null;
let lastFocus = null;
// Which button is the "primary" action for the current dialog open —
// drives both initial focus and what Enter resolves to.
let confirmPrimary = 'save';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// `saveHidden` lets the toolbar's Discard flow reuse this dialog as a
// pure confirm (the user already chose to discard — Save would be
// nonsensical). `primary` selects which button gets the initial focus
// and the Enter accelerator: 'save' for the unsaved-changes prompt,
// 'discard' for the explicit Discard click, 'cancel' otherwise.
function setConfirmContents({ title, bodyHtml, saveLabel, discardLabel, cancelHidden, saveHidden, primary }) {
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

// Returns 'save' (restore), 'discard', or 'cancel' (leave draft alone).
export function promptRecoverDraft(tab, draft) {
  const when = formatDraftTimestamp(draft.savedAt);
  setConfirmContents({
    title: 'Recover unsaved draft',
    bodyHtml: `An unsaved draft of <span class="confirm-file-name">${escapeHtml(tab.title || 'this file')}</span> was found from ${escapeHtml(when)}. Restore it, or open the saved version?`,
    saveLabel: 'Restore',
    discardLabel: 'Discard draft',
    cancelHidden: true,
    primary: 'save',
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
  confirmOverlay.classList.remove('hidden');
  state.confirmDialogOpen = true;
  lastFocus = document.activeElement;
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
    confirmOverlay.classList.remove('closing');
    confirmOverlay.classList.add('hidden');
    state.confirmDialogOpen = false;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
    r(decision);
  }, 200);
}

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

// ── Scroll sync between editor and preview panes ─────────────────────
// The two scrollers have different heights (CM6 line-wrapped editor vs
// rendered markdown) so we map scroll position proportionally: the
// fraction of the active scroller's range is mirrored to the other's.
// `syncLock` guards against the programmatic scrollTop assignment
// re-entering this handler. The editor → preview direction is wired
// per-mount in `buildView` (the cm-scroller is the actual scroller, and
// its scroll events don't bubble out of the cm-editor); the preview →
// editor direction is wired once here against the module's editorView
// handle.
let syncLock = 0;
function mirrorScroll(from, to) {
  if (syncLock) return;
  const fromMax = from.scrollHeight - from.clientHeight;
  const toMax = to.scrollHeight - to.clientHeight;
  if (fromMax <= 0 || toMax <= 0) return;
  const frac = from.scrollTop / fromMax;
  syncLock++;
  to.scrollTop = toMax * frac;
  requestAnimationFrame(() => { syncLock = Math.max(0, syncLock - 1); });
}
if (previewPane) {
  previewPane.addEventListener('scroll', () => {
    if (editorView) mirrorScroll(previewPane, editorView.scrollDOM);
  }, { passive: true });
}

// ── Resizable divider between editor and preview ─────────────────────
// Pointer events + setPointerCapture keep the drag alive even if the
// pointer leaves the divider element. Frac is updated live during drag
// (no persist — that would thrash tab.editorSplit on every move) and
// committed to the active tab on pointerup/keyup.
if (splitDivider && editorSplit) {
  let draggingId = null;
  function fracFromPointer(clientX) {
    const rect = editorSplit.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * 100;
  }
  splitDivider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    draggingId = e.pointerId;
    splitDivider.classList.add('dragging');
    document.body.classList.add('resizing-split');
    try { splitDivider.setPointerCapture(e.pointerId); } catch {}
  });
  splitDivider.addEventListener('pointermove', (e) => {
    if (draggingId !== e.pointerId) return;
    setSplitFrac(fracFromPointer(e.clientX), false);
  });
  const endDrag = (e) => {
    if (draggingId !== e.pointerId) return;
    draggingId = null;
    splitDivider.classList.remove('dragging');
    document.body.classList.remove('resizing-split');
    try { splitDivider.releasePointerCapture(e.pointerId); } catch {}
    setSplitFrac(parseFloat(splitDivider.getAttribute('aria-valuenow') ?? '50'), true);
  };
  splitDivider.addEventListener('pointerup', endDrag);
  splitDivider.addEventListener('pointercancel', endDrag);

  // Keyboard: left/right nudge the divider in 2% steps; Home/End snap
  // to the clamp edges. Lets keyboard-only users rebalance the panes.
  splitDivider.addEventListener('keydown', (e) => {
    const cur = parseFloat(splitDivider.getAttribute('aria-valuenow') ?? '50');
    let next = cur;
    if (e.key === 'ArrowLeft')      next = cur - 2;
    else if (e.key === 'ArrowRight') next = cur + 2;
    else if (e.key === 'Home')       next = SPLIT_MIN;
    else if (e.key === 'End')        next = SPLIT_MAX;
    else return;
    e.preventDefault();
    setSplitFrac(next, true);
  });
}

// Cycle split → editor → preview → split. Only applies when an editor
// is mounted; we never mutate a tab that has no split state to track.
registerHandler('cycleSplitMode', (e) => {
  e?.preventDefault();
  const tab = activeTab();
  if (!tab?.editing) return;
  const cur = tab.splitMode || 'split';
  const next = SPLIT_MODES[(SPLIT_MODES.indexOf(cur) + 1) % SPLIT_MODES.length];
  applySplitMode(next, true);
});
