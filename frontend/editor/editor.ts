// Edit / save lifecycle for the active tab.
// Tabs carry `raw` (current editor buffer), `savedRaw` (last-saved disk
// content, used to detect dirty state), and `editing` (true while the
// CodeMirror view is mounted). Only one tab is "active"/rendered at a
// time; switching tabs preserves the other tabs' edit state in memory.

import {
  invoke,
  state,
  contentEl, contentScroll,
  editorSplit, editorPane, previewPane, splitDivider,
  btnSave, btnDiscard, btnPreview,
  statusIndicator, statusText, statusCountsEl,
  confirmOverlay, confirmDialogTitle, confirmDialogBody,
  confirmCancelBtn, confirmDiscardBtn, confirmSaveBtn,
  supportsHighlights, revealHighlight,
} from "../core/state.ts";
import { syncToolbar, renderTabBar, rerender, applyActiveTab } from "../ui/tabs.ts";
import { syncWatcher } from "../ui/folder.ts";
import {
  activeTab, isDirty, renderContent, hydrateImages,
  setLoading, clearStatus, applyZoom,
} from "../core/tab-state.ts";
import { closeSearch } from "../features/search.ts";
import { applyFormat } from "./editor-format.ts";
import { registerHandler, dispatchKey } from "../core/keybindings.ts";
import { writeDraft, clearDraft } from "../core/draft-store.ts";
import { refreshOutline } from "../ui/outline.ts";
import { logError } from "../core/logger.ts";
import { showErrorModal } from "../ui/error-modal.ts";
import { showToast } from "../ui/toast.ts";
import { formatMarkdownBuffer } from "../lib/md-table.ts";

import { EditorView, keymap, lineNumbers, Decoration, ViewPlugin } from '@codemirror/view';
import { EditorState, EditorSelection, Prec, StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags, Tag, styleTags } from '@lezer/highlight';
import {
  search, SearchQuery, setSearchQuery, getSearchQuery,
  findNext, findPrevious, replaceNext, replaceAll,
} from '@codemirror/search';

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

// ── Line / word / char counts (status bar) ─────────────────────────────
// Cheap synchronous pass over the document text: one regex for words plus
// a newline split for lines — fast enough to run inline on every doc
// change and selection change without debouncing (the preview render is
// the heavy step and is debounced separately). Counts source markdown
// verbatim (including syntax characters) to avoid tying this to the
// render pipeline.
//
// Used in both modes: edit mode passes the live buffer (and, when a
// selection is non-empty, the selected text for the trailing "selected"
// segment); read mode passes the tab's raw source. `showWelcome` clears
// the element so it blanks out when there's no active document.
function countsLabel(text) {
  const chars = text.length;
  const words = (text.match(/\S+/g) || []).length;
  const lines = text === '' ? 0 : text.split('\n').length;
  return `${lines} line${lines === 1 ? '' : 's'} · `
       + `${words} word${words === 1 ? '' : 's'} · `
       + `${chars} char${chars === 1 ? '' : 's'}`;
}

export function updateCounts(value: any, selectionText?: any) {
  if (!statusCountsEl) return;
  const text = value ?? '';
  let label = countsLabel(text);
  const sel = selectionText ?? '';
  if (sel) {
    const selWords = (sel.match(/\S+/g) || []).length;
    label += `  (${selWords} word${selWords === 1 ? '' : 's'}, `
           + `${sel.length} char${sel.length === 1 ? '' : 's'} selected)`;
  }
  statusCountsEl.textContent = label;
}

export function clearCounts() {
  if (statusCountsEl) statusCountsEl.textContent = '';
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
    // Continue the marker on the next line. For an ordered item we bump the
    // number purely as a typing convenience — Markdown ordered lists render
    // like an HTML <ol> (only the first item's number matters; the rest are
    // ignored and auto-incremented by the renderer, CommonMark §5.3), so we
    // never rewrite the numbers of the lines below: that fought the user's
    // edits and mangled documents like CHANGELOG.md.
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

// ── Search-result reveal highlight (editor) ──────────────────────────
// When a project-search hit is opened, decorate the matched line so it
// stands out: the whole line gets a secondary-accent wash and the matched
// substring the primary accent (mirrors the preview's two-tone treatment).
// Held in a StateField as a DecorationSet; any edit dismisses it.
const setRevealHighlight = StateEffect.define<{ lineFrom: number; from: number; to: number } | null>();
const revealLineDeco = Decoration.line({ class: 'cm-reveal-line' });
const revealMatchDeco = Decoration.mark({ class: 'cm-reveal-match' });
const revealHighlightField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    // A user edit dismisses the transient highlight.
    if (tr.docChanged) return Decoration.none;
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setRevealHighlight)) {
        if (!e.value) { deco = Decoration.none; continue; }
        const { lineFrom, from, to } = e.value;
        const ranges = [revealLineDeco.range(lineFrom)];
        if (to > from) ranges.push(revealMatchDeco.range(from, to));
        deco = Decoration.set(ranges, true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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
    // Inherit the size from #editor-pane, which applyZoom() drives with the
    // same `calc(var(--font-size) * zoom)` it gives the preview — so the
    // editor scales with Ctrl+/− and matches the preview's text size.
    fontSize: 'inherit',
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
  // Line-number gutter (only mounted when editor_line_numbers is on).
  // CM6's stock gutter is a light-mode grey — repaint it with the app's
  // tokens so it reads correctly against the dark editor.
  '.cm-gutters': {
    background: 'var(--bg)',
    color: 'var(--fg-dim)',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 12px 0 16px',
  },
});

// lezer-markdown lumps every markup mark (`#`, `>`, backticks, link
// brackets *and* list bullets) under a single `processingInstruction`
// tag, so list bullets can't get their own color out of the box. Define
// a dedicated tag and re-tag just the `ListMark` node via a
// MarkdownConfig extension (passed to `markdown({ extensions: [...] })`
// below); the re-tag is layered on top of the default rule, so the
// dedicated tag wins for bullets while every other mark stays
// `processingInstruction`.
const listMarkTag = Tag.define();
const oxideMarkdownExt = { props: [styleTags({ ListMark: listMarkTag })] };

// Markdown syntax highlighting for the edit surface. CM6 ships
// `defaultHighlightStyle`, but that's a generic code palette and reads
// as foreign against the app's Atom One chrome. Map the markdown tags
// to the app's own CSS-variable tokens instead, so the editor matches
// the rendered preview, follows dark/light theme switching, and even
// picks up the user's custom Colors-tab tokens from Settings.
//
// lezer-markdown tags each heading level separately, so the editor can
// mirror the preview's per-level colors (h4-h6 share the h3 token —
// the app only exposes three heading colors). The literal markup
// punctuation (`#`, `*`, `>`, backticks, link brackets — all
// `processingInstruction`) is dimmed so prose reads above the syntax;
// list-item text is left at `--fg`, only the marks are recolored.
// List bullet markers follow the Colors-tab `--bullet-color` token
// (via the re-tagged `listMarkTag` above) and blockquote content
// follows `--note-accent` — both fall back to a sensible default when
// the user hasn't set a custom color.
const oxideHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--h1-color, var(--accent))', fontWeight: '700' },
  { tag: tags.heading2, color: 'var(--h2-color, var(--accent))', fontWeight: '700' },
  { tag: tags.heading3, color: 'var(--h3-color, var(--accent))', fontWeight: '600' },
  { tag: tags.heading4, color: 'var(--h3-color, var(--accent))', fontWeight: '600' },
  { tag: tags.heading5, color: 'var(--h3-color, var(--accent))', fontWeight: '600' },
  { tag: tags.heading6, color: 'var(--h3-color, var(--accent))', fontWeight: '600' },
  // Bold / italic / strike mirror the preview: weight or slant --fg
  // rather than recoloring it.
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, color: 'var(--fg-muted)', textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--link)' },
  { tag: tags.url, color: 'var(--link)' },
  { tag: tags.labelName, color: 'var(--link)' },
  // Inline code and fenced-code text — same accent (and fallback) the
  // preview's code styling uses.
  { tag: tags.monospace, color: 'var(--code-accent, var(--accent))' },
  { tag: tags.quote, color: 'var(--note-accent, var(--fg-dim))', fontStyle: 'italic' },
  { tag: tags.processingInstruction, color: 'var(--fg-muted)' },
  { tag: listMarkTag, color: 'var(--bullet-color, var(--accent))' },
  { tag: tags.contentSeparator, color: 'var(--fg-muted)' },
  { tag: tags.escape, color: 'var(--fg-muted)' },
  { tag: tags.comment, color: 'var(--fg-muted)', fontStyle: 'italic' },
]);

// Search-match highlighter. CM6's own match highlighting is gated on its
// built-in search panel being open (searchHighlighter returns no decorations
// when `panel` is null), but we drive search from the external #search-bar
// without ever opening that panel. So we paint the active query's matches
// ourselves, keyed off the same SearchQuery state: every match gets
// .cm-searchMatch, and the one under the selection (the "current" hit that
// findNext/findPrevious moved to) gets .cm-searchMatch-selected.
const searchMatchDeco = Decoration.mark({ class: 'cm-searchMatch' });
const searchMatchSelectedDeco = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });
const oxideSearchHighlighter = ViewPlugin.fromClass(class {
  decorations: any;
  constructor(view: any) { this.decorations = this.build(view); }
  update(update: any) {
    if (
      update.docChanged || update.selectionSet || update.viewportChanged ||
      update.transactions.some((tr: any) => tr.effects.some((e: any) => e.is(setSearchQuery)))
    ) {
      this.decorations = this.build(update.view);
    }
  }
  build(view: any) {
    const builder = new RangeSetBuilder<any>();
    const q = getSearchQuery(view.state);
    if (!q.search || !q.valid) return builder.finish();
    const sel = view.state.selection.main;
    // Iterate only the visible ranges (matches CM6's own approach) so this
    // stays cheap on large documents.
    for (const { from, to } of view.visibleRanges) {
      const cursor = q.getCursor(view.state, from, to);
      for (let it = cursor.next(); !it.done; it = cursor.next()) {
        const m = it.value;
        const selected = m.from === sel.from && m.to === sel.to;
        builder.add(m.from, m.to, selected ? searchMatchSelectedDeco : searchMatchDeco);
      }
    }
    return builder.finish();
  }
}, { decorations: (v: any) => v.decorations });

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
    (btnSave as HTMLButtonElement).disabled = !dirty;
    if (btnDiscard) (btnDiscard as HTMLButtonElement).disabled = !dirty;
    const tabEl = document.querySelector(`.tab[data-tab-id="${cur.id}"]`);
    if (tabEl) tabEl.classList.toggle('dirty', dirty);
    // An edit dismisses any lingering search-hit reveal so the sticky
    // highlight doesn't re-apply on every keystroke's preview re-render.
    pendingPreviewReveal = null;
    clearPreviewReveal();
    scheduleDraftWrite(cur);
    schedulePreviewRender(undefined);
    // Headings may have been added/removed/edited — keep the outline
    // sidebar fresh. Cheap parse, and a no-op while it's hidden.
    refreshOutline();
  };

  // Refresh the status-bar counts from a CM6 state. Called on both doc
  // changes and selection changes so the trailing "… selected" segment
  // tracks the cursor live; the selection text is empty for a plain
  // caret, which collapses the label back to the document totals.
  const refreshCountsFromState = (cmState) => {
    const sel = cmState.selection.main;
    const selectionText = sel.empty ? '' : cmState.sliceDoc(sel.from, sel.to);
    updateCounts(cmState.doc.toString(), selectionText);
  };

  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged) onDocChanged(u.state.doc.toString());
    if (u.docChanged || u.selectionSet) refreshCountsFromState(u.state);
  });

  const wordWrap = state.config?.editor_word_wrap !== false;
  const spellCheck = !!state.config?.editor_spell_check;
  const showLineNumbers = !!state.config?.editor_line_numbers;

  const baseExtensions = [
    history(),
    smartListKeymap,
    // The search extension supplies the SearchQuery state + match
    // highlighting, which we drive programmatically from the unified
    // #search-bar (see editorSetSearch et al). We deliberately omit
    // searchKeymap so Mod+F doesn't open CM6's built-in panel — it falls
    // through to the global toggleSearch action that opens our bar instead.
    search({ top: true }),
    oxideSearchHighlighter,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ extensions: [oxideMarkdownExt] }),
    syntaxHighlighting(oxideHighlightStyle),
    revealHighlightField,
    EditorView.contentAttributes.of({
      'aria-label': `Edit ${tab.title}`,
      'spellcheck': spellCheck ? 'true' : 'false',
    }),
    oxideCmTheme,
    updateListener,
  ];
  if (wordWrap) baseExtensions.push(EditorView.lineWrapping);
  if (showLineNumbers) baseExtensions.push(lineNumbers());

  const editorState = EditorState.create({
    doc: tab.raw ?? '',
    extensions: baseExtensions,
  });

  const view = new EditorView({ state: editorState });
  view.dom.classList.add('md-editor');
  view.scrollDOM.addEventListener('scroll', () => mirrorScroll(view.scrollDOM, previewPane), { passive: true });
  installPasteHandler(view);
  return view;
}

// Image paste: when the clipboard carries an image (Snipping Tool, web
// drag-paste, Photoshop, etc.) write the bytes to a sibling assets/
// folder and insert a markdown image reference at the cursor. Plain
// text paste falls through to CM6's default handler.
function installPasteHandler(view) {
  view.dom.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let imageItem = null;
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        imageItem = it;
        break;
      }
    }
    if (!imageItem) return;
    const tab = activeTab();
    if (!tab?.path) return;
    e.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;
    const ext = (imageItem.type.split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
    try {
      const base64 = await blobToBase64(blob);
      const result = await invoke('write_pasted_image', {
        basePath: tab.path,
        extension: ext,
        base64Data: base64,
      });
      const insertion = `![](${result.relative_href})`;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: insertion },
        selection: { anchor: sel.from + insertion.length },
      });
    } catch (err) {
      showErrorModal('Image paste failed', 'Could not save the pasted image to disk.', err);
    }
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.onload = () => {
      const result = reader.result || '';
      const idx = typeof result === 'string' ? result.indexOf(',') : -1;
      if (idx === -1) reject(new Error('Unexpected data URL'));
      else resolve(result.slice(idx + 1));
    };
    reader.readAsDataURL(blob);
  });
}

// ── Drag-and-drop image insertion ──────────────────────────────────────────
// Image extensions accepted via drag-and-drop. Mirrors the backend's
// DROP_IMAGE_EXTS so both ends agree on what counts as an image.
const DROP_IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'tif', 'tiff',
]);

function fileExt(path) {
  const base = path.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

// True when the editor is mounted (edit mode) and the client point lands on
// the CodeMirror surface — the gate for treating a file drop as an image
// insertion rather than an "open this file" drop.
function pointInEditor(x, y) {
  if (!editorView || !document.body.classList.contains('editing')) return false;
  const el = document.elementFromPoint(x, y);
  return !!el && editorView.dom.contains(el);
}

// Toggle the drop affordance while files are dragged over the window.
export function updateEditorDropHint(x, y) {
  editorPane.classList.toggle('drop-target', pointInEditor(x, y));
}
export function clearEditorDropHint() {
  editorPane.classList.remove('drop-target');
}

// Handle a file drop that landed on the editor: copy each dropped image into
// the document's assets/ folder (like paste) and insert a markdown image
// reference at the drop point. Returns true when the drop was over the editor
// and consumed here, so the caller skips its open-file fallback.
export async function dropImagesIntoEditor(paths, x, y) {
  if (!pointInEditor(x, y)) return false;
  const images = paths.filter((p) => DROP_IMAGE_EXTS.has(fileExt(p)));
  if (!images.length) return false; // non-images fall through (e.g. a .md)

  const tab = activeTab();
  if (!tab?.path) {
    // assets/ lives beside the file; an unsaved buffer has nowhere to put it.
    showToast('Save the document before adding images', 'error');
    return true; // consumed: don't also try to "open" the image
  }

  // Insert where the user dropped, falling back to the cursor position.
  let pos = editorView.state.selection.main.from;
  const at = editorView.posAtCoords({ x, y });
  if (at != null) pos = at;

  const refs = [];
  for (const src of images) {
    try {
      const result = await invoke('import_dropped_image', {
        basePath: tab.path,
        sourcePath: src,
      });
      refs.push(`![](${result.relative_href})`);
    } catch (err) {
      showErrorModal('Image drop failed', 'Could not import the dropped image.', err);
    }
  }
  if (!refs.length) return true;

  const insertion = refs.join('\n');
  editorView.dispatch({
    changes: { from: pos, to: pos, insert: insertion },
    selection: { anchor: pos + insertion.length },
  });
  editorView.focus();
  return true;
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
  // A fresh mount (tab switch / re-enter) drops any pending or live reveal so
  // it can't leak onto a different document. revealEditorLine re-queues it
  // afterwards when opening a search result.
  pendingPreviewReveal = null;
  clearPreviewReveal();

  const view = buildView(tab);
  editorPane.appendChild(view.dom);
  editorView = view;

  // Restore this tab's split layout (frac + mode) before the panes paint.
  applySplitToTab(tab);
  updateCounts(tab.raw ?? '', undefined);

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
  pendingPreviewReveal = null;
  clearPreviewReveal();
  editorPane.innerHTML = '';
  previewPane.innerHTML = '';
}

export function setPreviewHtml(html) {
  // Drop any prior reveal first: the innerHTML swap detaches its ranges and
  // the block class, so clear them explicitly to keep the registry tidy.
  clearPreviewReveal();
  previewPane.innerHTML = html;
  // Resolve local images to asset:// URLs and promote remote images only
  // if the user has enabled them — see hydrateImages.
  hydrateImages(previewPane);
  // Re-apply a queued search-result reveal now that the preview has content.
  applyPreviewReveal();
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
    if (buf !== disk) writeDraft(tab.path, buf, tab.diskHash || null);
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
// Threshold (in characters) above which we slow the preview debounce
// to LARGE_FILE_DEBOUNCE_MS — re-rendering a 1 MB+ markdown file on
// every keystroke saturates the IPC pipe.
const LARGE_FILE_THRESHOLD = 200_000;
const LARGE_FILE_DEBOUNCE_MS = 600;
let previewTimer = null;
let previewRenderSeq = 0;

function schedulePreviewRender(delay?: number) {
  if (previewTimer) clearTimeout(previewTimer);
  let computed = delay;
  if (computed === undefined) {
    const tab = activeTab();
    const len = (tab?.raw ?? '').length;
    computed = len > LARGE_FILE_THRESHOLD ? LARGE_FILE_DEBOUNCE_MS : PREVIEW_DEBOUNCE_MS;
  }
  previewTimer = setTimeout(() => {
    previewTimer = null;
    renderPreviewNow();
  }, computed);
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
    logError('editor', 'render_preview failed', e);
  }
}

export async function enterEditMode() {
  const tab = activeTab();
  // Untitled (new) tabs have no path yet but are editable; everything else
  // needs a file backing it.
  if (!tab || tab.editing || (!tab.path && !tab.isNew)) return;

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
  // Toolbar, tab bar, and outline all change with edit mode; the outline's
  // jump targets differ by mode (editor lines vs. preview headings).
  rerender();
}

export function exitEditMode({ keepHtml = true } = {}) {
  const tab = activeTab();
  if (!tab || !tab.editing) return;
  // Switching modes resets the unified search bar (its backend differs per
  // mode); enterEditMode does the same on the way in.
  closeSearch();
  // Capture pane scroll positions so re-entering edit mode lands where
  // we left off.
  tab.editorScrollTop = editorView ? editorView.scrollDOM.scrollTop : 0;
  tab.previewScrollTop = previewPane.scrollTop;
  tab.editing = false;
  document.body.classList.remove('editing');
  unmountEditor();
  if (keepHtml) renderContent(tab.html);
  // Switch the status-bar counts from the live buffer back to the tab's
  // raw source (no selection segment in read mode).
  updateCounts(tab.raw ?? '', undefined);
  applyZoom(tab.zoom);
  rerender();
  requestAnimationFrame(() => { contentScroll.scrollTop = tab.scrollTop || 0; });
}

// ── Format-on-save ─────────────────────────────────────────────────────
// The Markdown table aligner + pre-save tidier (formatMarkdownBuffer) lives
// in the dependency-free, unit-tested frontend/lib/md-table.js. Opt-in via
// editor_format_on_save.

// Save-as for an untitled tab: prompt for a destination, write the live
// buffer, then adopt the returned path so subsequent saves go in-place.
// A cancelled dialog leaves the tab untitled and unsaved (returns false so
// a close-triggered save aborts the close instead of dropping the buffer).
async function saveUntitledTab(tab) {
  setLoading();
  let result;
  try {
    result = await invoke('save_new_file', { dir: tab.newFileDir || null, content: tab.raw ?? '' });
  } catch (e) {
    clearStatus();
    showErrorModal('Save failed', 'Could not save the file.', e);
    return false;
  }
  clearStatus();
  if (!result) return false; // user cancelled the save dialog
  tab.path = result.path;
  tab.title = result.title;
  tab.html = result.html;
  tab.raw = result.raw ?? tab.raw ?? '';
  tab.savedRaw = tab.raw;
  tab.isNew = false;
  tab.newFileDir = null;
  state.lastSaveAt = Date.now();
  state.lastSavedPath = tab.path;
  invoke('file_sha256', { path: tab.path })
    .then((hash) => { tab.diskHash = hash; })
    .catch(() => {});
  // Re-render the chrome for the now-file-backed tab: window/document
  // title, status-bar path, tree highlight, and the editor rebound to the
  // new path (so the live preview and image paste resolve correctly).
  applyActiveTab();
  rerender();
  syncWatcher();
  return true;
}

export async function saveActiveFile() {
  const tab = activeTab();
  if (!tab || !tab.editing) return false;
  // An in-place save is a no-op when clean; an untitled tab always needs
  // the save-as dialog so it can choose a destination.
  if (tab.path && !isDirty(tab)) return true;

  // Format on save (opt-in). Swap the editor's buffer if the formatter
  // changed anything so the user sees the saved form and the dirty
  // tracking stays consistent. Applied before either save path writes.
  if (state.config?.editor_format_on_save) {
    const formatted = formatMarkdownBuffer(tab.raw ?? '');
    if (formatted !== (tab.raw ?? '')) {
      tab.raw = formatted;
      if (editorView) {
        editorView.dispatch({
          changes: { from: 0, to: editorView.state.doc.length, insert: formatted },
        });
      }
    }
  }

  // Untitled tabs have no path yet — route to the save-as flow.
  if (!tab.path) return saveUntitledTab(tab);

  setLoading();
  try {
    const result = await invoke('save_file', { path: tab.path, content: tab.raw ?? '' });
    tab.html = result.html;
    tab.title = result.title;
    tab.savedRaw = result.raw ?? tab.raw ?? '';
    state.lastSaveAt = Date.now();
    state.lastSavedPath = tab.path;
    clearDraft(tab.path);
    invoke('file_sha256', { path: tab.path })
      .then((hash) => { tab.diskHash = hash; })
      .catch(() => {});
    syncToolbar();
    renderTabBar();
    return true;
  } catch (e) {
    showErrorModal('Save failed', 'Could not save the file.', e);
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
  const dirty = isDirty(tab);
  (btnSave as HTMLButtonElement).disabled = true;
  if (btnDiscard) (btnDiscard as HTMLButtonElement).disabled = true;
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
    if ((e.target as HTMLElement).closest('.fmt-btn')) e.preventDefault();
  });
  editToolbarEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.fmt-btn') as HTMLElement;
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
  'bold', 'italic', 'underline', 'strike', 'code',
  'h1', 'h2', 'h3',
  'ul', 'ol', 'task',
  'link', 'image',
  'indent', 'outdent',
];
for (const id of EDITOR_FORMAT_ACTIONS) {
  registerHandler(id, (e) => { e?.preventDefault(); formatActiveEditor(id); });
}

// ── Preview-side reveal highlight ────────────────────────────────────
// The editor reveal above is precise (source line numbers map 1:1). The
// preview is rendered HTML with no line info, so we mirror the hit there
// by finding the matching occurrence of the query in the preview text:
// the substring is painted via the CSS Highlight API (oxide-reveal-match)
// and its containing block gets `.oxide-reveal-block` for the line wash.
// `ordinal` is the 0-based index of the hit among all occurrences in the
// source, so the preview highlights the *same* occurrence, not just the
// first — the rendered text preserves source order for plain queries.
let pendingPreviewReveal: any = null; // { query, ordinal } — one-shot
let revealBlockEl: any = null;
const REVEAL_BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre,dt,dd,figcaption';

function clearPreviewReveal() {
  if (supportsHighlights && revealHighlight) revealHighlight.clear();
  if (revealBlockEl) { revealBlockEl.classList.remove('oxide-reveal-block'); revealBlockEl = null; }
}

// Paint the `ordinal`-th occurrence of `query` inside `container` (the live
// preview pane or the read-mode #content) and wash its containing block.
// Returns the picked Range so the caller can scroll it into view, or null.
function highlightMatchIn(container, query, ordinal): Range | null {
  clearPreviewReveal();
  if (!query) return null;
  const needle = String(query).toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let tn: any;
  while ((tn = walker.nextNode())) {
    const text = tn.nodeValue || '';
    const hay = text.toLowerCase();
    let idx = 0;
    while ((idx = hay.indexOf(needle, idx)) !== -1) {
      const r = document.createRange();
      r.setStart(tn, idx);
      r.setEnd(tn, idx + needle.length);
      ranges.push(r);
      idx += needle.length;
    }
  }
  if (!ranges.length) return null;
  // Clamp to the occurrence count in case the renderer dropped some (e.g.
  // a match that lived inside markdown syntax that isn't rendered).
  const pick = ranges[Math.min(ordinal, ranges.length - 1)];
  if (supportsHighlights && revealHighlight) revealHighlight.add(pick);
  const block = (pick.startContainer.parentElement || container).closest(REVEAL_BLOCK_SELECTOR);
  if (block) { block.classList.add('oxide-reveal-block'); revealBlockEl = block; }
  return pick;
}

// Apply the queued preview reveal once the preview actually has content.
// Called from setPreviewHtml (after every render) and from revealEditorLine.
// Sticky, NOT one-shot: opening a search hit kicks off an async preview
// re-render (mountEditor's schedulePreviewRender) that lands *after* the
// reveal and would otherwise wipe it. By leaving `pendingPreviewReveal` set,
// that re-render re-applies it. It's cleared by a new reveal, a doc edit
// (onDocChanged), or unmount — so it can't persist onto the wrong content.
function applyPreviewReveal() {
  if (!pendingPreviewReveal) return;
  if (!previewPane.childNodes.length) return; // not rendered yet — wait
  const { query, ordinal } = pendingPreviewReveal;
  highlightMatchIn(previewPane, query, ordinal);
}

// Reveal a project-search hit in the mounted editor *and* the preview:
// scroll the 1-based source line to center, decorate the line (secondary
// accent) and the matched substring (primary accent) via a CM6 decoration,
// and queue the matching preview highlight. Line numbers come straight from
// the `search_project` backend, which greps the same source the editor
// shows, so they map 1:1.
export function revealEditorLine(line, query) {
  if (!editorView) return;
  const doc = editorView.state.doc;
  if (!Number.isFinite(line) || line < 1 || line > doc.lines) return;
  const l = doc.line(line);
  let from = l.from;
  let to = l.from;
  if (query) {
    const idx = l.text.toLowerCase().indexOf(String(query).toLowerCase());
    if (idx !== -1) { from = l.from + idx; to = from + String(query).length; }
  }
  editorView.dispatch({
    selection: EditorSelection.cursor(from),
    effects: [
      setRevealHighlight.of({ lineFrom: l.from, from, to }),
      EditorView.scrollIntoView(from, { y: 'center' }),
    ],
  });
  editorView.focus();

  // Queue the same hit for the preview. The 0-based occurrence index of
  // `from` among all matches in the source picks the matching occurrence.
  if (query && to > from) {
    const src = doc.toString();
    const needle = String(query).toLowerCase();
    const before = src.slice(0, from).toLowerCase();
    let ordinal = 0;
    let i = 0;
    while ((i = before.indexOf(needle, i)) !== -1) { ordinal++; i += needle.length; }
    pendingPreviewReveal = { query, ordinal };
  } else {
    pendingPreviewReveal = null;
    clearPreviewReveal();
  }
  applyPreviewReveal();
}

// The 0-based index of the hit on 1-based source `line` among all
// occurrences of `query` in `src` — so the rendered view highlights the
// *same* occurrence the backend matched, not just the first. Mirrors the
// ordinal math in revealEditorLine but works off a raw source string (read
// mode has no editor). Newlines are normalized so a CRLF file doesn't drift
// the offset and pick the wrong occurrence.
function matchOrdinal(src, line, query) {
  if (!query) return 0;
  const text = String(src).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (!Number.isFinite(line) || line < 1 || line > lines.length) return 0;
  const needle = String(query).toLowerCase();
  const col = lines[line - 1].toLowerCase().indexOf(needle);
  if (col === -1) return 0;
  let offset = col;
  for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1; // + '\n'
  const before = text.slice(0, offset).toLowerCase();
  let ordinal = 0;
  let i = 0;
  while ((i = before.indexOf(needle, i)) !== -1) { ordinal++; i += needle.length; }
  return ordinal;
}

// Reveal a project-search hit in read mode: highlight the matched substring
// in the rendered #content and scroll its block to center. The occurrence is
// chosen from the tab's raw source so it lines up with the backend's match.
export function revealReadLine(line, query) {
  if (!query) { clearPreviewReveal(); return; }
  const tab = activeTab();
  const ordinal = matchOrdinal(tab?.raw ?? '', line, query);
  const pick = highlightMatchIn(contentEl, query, ordinal);
  if (!pick) return;
  // Center the hit in the scroll viewport (mirrors features/search.ts).
  const rect = pick.getBoundingClientRect();
  const scrollRect = contentScroll.getBoundingClientRect();
  const target = contentScroll.scrollTop + rect.top - scrollRect.top
    - scrollRect.height / 2 + rect.height / 2;
  contentScroll.scrollTo({ top: target, behavior: 'smooth' });
}

// Mode-aware entry point used by the project-search panel. In edit mode the
// hit is shown in the editor (and mirrored into the preview); in read mode
// it's shown in the rendered content. The caller decides nothing about mode.
export function revealSearchHit(line, query) {
  const tab = activeTab();
  if (tab?.editing) revealEditorLine(line, query);
  else revealReadLine(line, query);
}

// ── Edit-mode search backend ─────────────────────────────────────────
// The unified #search-bar (features/search.ts) drives CodeMirror's search
// through these instead of CM6's built-in panel, so edit and read mode share
// one UI. Each returns the live { count, current } so the bar can show "n/m".

// Count all matches of the active query and, if the current selection is one
// of them, its 1-based index — used for the "n / m" readout.
function editorMatchInfo(): { count: number; current: number } {
  if (!editorView) return { count: 0, current: 0 };
  const q = getSearchQuery(editorView.state);
  if (!q.search) return { count: 0, current: 0 };
  const sel = editorView.state.selection.main;
  let count = 0;
  let current = 0;
  const cursor = q.getCursor(editorView.state);
  for (let it = cursor.next(); !it.done; it = cursor.next()) {
    count++;
    if (it.value.from === sel.from && it.value.to === sel.to) current = count;
  }
  return { count, current };
}

// Set the active query and highlight all matches. Does NOT move the cursor —
// navigation is explicit (Enter / next / prev) so typing in the box doesn't
// yank the editor selection around on every keystroke.
export function editorSetSearch(query, caseSensitive): number {
  if (!editorView) return 0;
  editorView.dispatch({ effects: setSearchQuery.of(
    new SearchQuery({ search: query ?? '', caseSensitive: !!caseSensitive }),
  ) });
  return query ? editorMatchInfo().count : 0;
}

export function editorNextMatch() {
  if (editorView) findNext(editorView);
  return editorMatchInfo();
}

export function editorPrevMatch() {
  if (editorView) findPrevious(editorView);
  return editorMatchInfo();
}

export function editorReplaceMatch(query, replace, caseSensitive) {
  if (editorView && query) {
    editorView.dispatch({ effects: setSearchQuery.of(
      new SearchQuery({ search: query, replace: replace ?? '', caseSensitive: !!caseSensitive }),
    ) });
    replaceNext(editorView);
  }
  return editorMatchInfo();
}

export function editorReplaceAllMatches(query, replace, caseSensitive) {
  if (editorView && query) {
    editorView.dispatch({ effects: setSearchQuery.of(
      new SearchQuery({ search: query, replace: replace ?? '', caseSensitive: !!caseSensitive }),
    ) });
    replaceAll(editorView);
  }
  return editorMatchInfo();
}

export function editorClearSearch() {
  if (editorView) {
    editorView.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
  }
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
  if (!(e.target as HTMLElement).closest('.cm-content')) return;
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
// When we write `to.scrollTop`, mark `to` so its resulting scroll event
// is treated as our own and not mirrored back. A rAF-based lock isn't
// enough — programmatic scroll events can land after rAF during wheel
// input, and the integer clamping of scrollTop then drifts the position
// on each bounce. The editor → preview direction is wired per-mount in
// `buildView` (the cm-scroller is the actual scroller, and its scroll
// events don't bubble out of cm-editor); preview → editor is wired once
// here against the module's editorView handle.
const suppressNextScroll = new WeakSet();
function mirrorScroll(from, to) {
  if (suppressNextScroll.has(from)) {
    suppressNextScroll.delete(from);
    return;
  }
  const fromMax = from.scrollHeight - from.clientHeight;
  const toMax = to.scrollHeight - to.clientHeight;
  if (fromMax <= 0 || toMax <= 0) return;
  const frac = from.scrollTop / fromMax;
  const target = toMax * frac;
  if (Math.abs(to.scrollTop - target) < 0.5) return;
  suppressNextScroll.add(to);
  to.scrollTop = target;
  // Fallback: if the write didn't end up firing a scroll event (e.g.
  // it clamped to the same integer we were already at), clear the
  // mark after two frames so a real user scroll on `to` isn't eaten.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { suppressNextScroll.delete(to); });
  });
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
  // The outline button mirrors split state in edit mode (aria-pressed /
  // tooltip / label) — repaint it so a Mod+\ cycle doesn't leave it stale.
  syncToolbar();
});

// Edit-mode repurposing of the outline button: show/hide the existing
// split preview pane. There's no parallel "preview visible" flag —
// `tab.splitMode` stays the single source of truth. "Hidden" means
// the editor-only mode; toggling back restores whichever previewing
// mode the user last had ('split' or 'preview', tracked per-tab so a
// preview-only user doesn't snap to split). `cycleSplitMode` keeps
// cycling all three modes independently — both write through
// applySplitMode, so they never disagree.
export function togglePreviewPane() {
  const tab = activeTab();
  if (!tab?.editing) return;
  const cur = tab.splitMode || 'split';
  if (cur === 'editor') {
    applySplitMode(tab.lastPreviewMode || 'split', true);
  } else {
    tab.lastPreviewMode = cur;
    applySplitMode('editor', true);
  }
}

if (btnPreview) {
  btnPreview.addEventListener('click', (e) => {
    e.preventDefault();
    togglePreviewPane();
    syncToolbar();
  });
}
