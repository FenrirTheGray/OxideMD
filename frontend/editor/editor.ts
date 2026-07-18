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
  statusIndicator, statusText,
  modKey,
  pathExtension,
} from "../core/state.ts";
import { syncToolbar, renderTabBar, rerender, applyActiveTab } from "../ui/tabs.ts";
import { syncWatcher } from "../ui/folder.ts";
import {
  activeTab, isDirty, renderContent, hydrateImages,
  setLoading, clearStatus, applyZoom,
} from "../core/tab-state.ts";
import { closeSearch } from "../features/search.ts";
import { updateCounts, updateCountsFrom, countWords } from "../ui/counts.ts";
import { promptDiscardChanges, promptOverwriteChanged } from "../ui/confirm.ts";
import { clearReveal, highlightMatchIn } from "../ui/reveal.ts";
import { applyFormat } from "./editor-format.ts";
import { registerHandler, dispatchKey } from "../core/keybindings.ts";
import { writeDraft, clearDraft } from "../core/draft-store.ts";
import { refreshOutline } from "../ui/outline.ts";
import { logError } from "../core/logger.ts";
import { showErrorModal } from "../ui/error-modal.ts";
import { showToast } from "../ui/toast.ts";
import { formatMarkdownBuffer } from "../lib/md-table.ts";
import { diffSplice } from "./md-transform.ts";
import { debounce } from "../lib/timing.ts";

import { EditorView, keymap, lineNumbers, Decoration, ViewPlugin } from '@codemirror/view';
import { EditorState, EditorSelection, Prec, StateField, StateEffect, RangeSetBuilder, Compartment } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, syntaxTree } from '@codemirror/language';
import { tags, Tag, styleTags } from '@lezer/highlight';
import {
  search, SearchQuery, setSearchQuery, getSearchQuery,
  findNext, findPrevious, replaceNext, replaceAll,
} from '@codemirror/search';
import { Idiomorph } from 'idiomorph';
import { nextSnippetField, prevSnippetField, clearSnippet, hasNextSnippetField, hasPrevSnippetField } from '@codemirror/autocomplete';

// Module-level handle to the current EditorView. The CM6 scroller
// (view.scrollDOM) is the actual scrolling element, not editor-pane.
let editorView = null;

// Compartments for the three editor settings that used to be baked into the
// view at build time (so a toggle only took effect on the next full remount).
// Wrapping them lets reconfigureEditorSettings() apply a Settings change to
// the live editor while preserving undo history and selection. Reused across
// mounts — only one view exists at a time.
const wrapCompartment = new Compartment();
const gutterCompartment = new Compartment();
const attrsCompartment = new Compartment();

// Exposed so other modules (tabs.js, contextmenu.js) can read the live
// buffer and scroll position without poking at the DOM.
export function getEditorValue() {
  return editorView ? editorView.state.doc.toString() : null;
}
export function getEditorScrollTop() {
  return editorView ? editorView.scrollDOM.scrollTop : 0;
}
export function getEditorSelectionHead() {
  return editorView ? editorView.state.selection.main.head : 0;
}
// The live CM EditorState — snapshotted per tab so switching away and back
// restores undo history + selection instead of rebuilding from the string.
export function getEditorState() {
  return editorView ? editorView.state : undefined;
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

// Incremental line/word/char counts held in the editor state. Chars and
// lines are O(1) from the doc; word count is maintained by recomputing only
// the line-span each change touched (a `\S+` word never crosses a newline,
// so a line's word count is self-contained — recomputing just the touched
// lines and applying the delta is exact). This replaces the old
// doc.toString()+full-rescan on every debounced fire, which was O(doc) per
// keystroke on large files.
function docCounts(doc) {
  return {
    lines: doc.length === 0 ? 0 : doc.lines,
    words: countWords(doc.toString()),
    chars: doc.length,
  };
}
const countField = StateField.define({
  create(state) { return docCounts(state.doc); },
  update(value, tr) {
    if (!tr.docChanged) return value;
    let minA = Infinity, maxA = -1, minB = Infinity, maxB = -1;
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      if (fromA < minA) minA = fromA;
      if (toA > maxA) maxA = toA;
      if (fromB < minB) minB = fromB;
      if (toB > maxB) maxB = toB;
    });
    let words = value.words;
    if (maxA >= 0) {
      const oldDoc = tr.startState.doc, newDoc = tr.state.doc;
      const oldWords = countWords(
        oldDoc.sliceString(oldDoc.lineAt(minA).from, oldDoc.lineAt(maxA).to));
      const newWords = countWords(
        newDoc.sliceString(newDoc.lineAt(minB).from, newDoc.lineAt(maxB).to));
      words += newWords - oldWords;
    }
    const doc = tr.state.doc;
    return { lines: doc.length === 0 ? 0 : doc.lines, words, chars: doc.length };
  },
});

// Edit-mode counts refresh, debounced off the keystroke path. Reads the
// incrementally-maintained countField (no full rescan) and counts the small
// selection string on demand. CM6 states are immutable snapshots, so a
// trailing-edge fire against an already-replaced state is merely stale,
// never wrong-document; mount/unmount cancel any pending fire before the
// active tab can change underneath it.
const debouncedEditorCounts = debounce((cmState) => {
  const sel = cmState.selection.main;
  const selectionText = sel.empty ? '' : cmState.sliceDoc(sel.from, sel.to);
  updateCountsFrom(cmState.field(countField), selectionText);
}, 100);

// Outline refresh re-parses the whole buffer and rebuilds the sidebar
// DOM via innerHTML; debounce it off the keystroke path. Mode switches
// and tab switches still call refreshOutline() directly for an instant
// repaint.
const debouncedOutlineRefresh = debounce(() => refreshOutline({ idle: true }), 200);

// ── Smart list / quote continuation on Enter ─────────────────────────
// Enter inside a list item or blockquote continues the marker on the new
// line (`- `, `2. `, `> `, `- [ ] `), composing through quote prefixes
// (`> - item` continues `> - `). Mid-line, the tail after the caret moves
// down as the new item's content — the item is split, matching every other
// markdown editor. On an empty item (Enter twice in a row) the marker
// unwinds progressively: a nested item outdents one level, a quoted list
// drops the list marker but keeps the quote, and a top-level marker line
// is cleared to a true blank line. Continuation never fires inside code
// blocks (a shell snippet's `- foo` is code, not a list) or on thematic
// breaks (`- - -`). Anything unmatched falls through to CM6's
// defaultKeymap so plain Enter still inserts a newline.
const QUOTE_PREFIX_RE = /^\s*(?:>[ \t]*)+/;
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])(\s+\[[ xX]\])?(\s+)(.*)$/;
// An empty task item with no trailing space (`- [ ]`): LIST_LINE would see
// the box as content, but the item is empty for breakout purposes.
const EMPTY_TASK_LINE = /^(\s*)(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s*$/;
const HR_LINE = /^\s*([-*_])(\s*\1){2,}\s*$/;

function smartEnter(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.from);

  // Inside a code block nothing is a list or a quote.
  for (let n = syntaxTree(view.state).resolveInner(sel.from, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return false;
  }

  const prefix = QUOTE_PREFIX_RE.exec(line.text)?.[0] ?? '';
  const rest = line.text.slice(prefix.length);
  const restFrom = line.from + prefix.length;
  if (HR_LINE.test(rest)) return false;

  const apply = (changes, cursor) => {
    view.dispatch({
      changes,
      selection: EditorSelection.cursor(cursor),
      scrollIntoView: true,
      userEvent: 'input',
    });
    return true;
  };
  // Empty item — unwind one level instead of continuing.
  const unwind = (indent) => {
    let insert;
    if (indent) {
      const outdented = indent[0] === '\t' ? indent.slice(1) : indent.slice(2);
      insert = prefix + outdented + rest.slice(indent.length);
    } else if (prefix) {
      insert = prefix; // quoted list item: drop the marker, keep the quote
    } else {
      insert = '';
    }
    return apply({ from: line.from, to: line.to, insert }, line.from + insert.length);
  };

  const et = EMPTY_TASK_LINE.exec(rest);
  if (et) return sel.from === line.to ? unwind(et[1]) : false;

  const m = LIST_LINE.exec(rest);
  if (m) {
    const [, indent, marker, taskBox, sep, content] = m;
    // Unwind only from the line end — Enter with the caret at column 0 (or
    // inside the marker) of an empty item pushes the line down instead.
    if (content === '') return sel.from === line.to ? unwind(indent) : false;
    // Splitting is only meaningful from inside the content; a caret inside
    // the marker itself gets a plain newline.
    const markerEnd = restFrom + indent.length + marker.length
      + (taskBox?.length ?? 0) + sep.length;
    if (sel.from < markerEnd) return false;
    // Continue (or split) the item. For an ordered item we bump the number
    // purely as a typing convenience — Markdown ordered lists render like
    // an HTML <ol> (only the first item's number matters; the rest are
    // ignored and auto-incremented by the renderer, CommonMark §5.3), so we
    // never rewrite the numbers of the lines below: that fought the user's
    // edits and mangled documents like CHANGELOG.md. Accepted flip side:
    // deleting the first item changes the rendered start number, because
    // that one number is exactly what the renderer honors.
    let newMarker = marker;
    const om = /^(\d+)([.)])$/.exec(marker);
    if (om) newMarker = `${parseInt(om[1], 10) + 1}${om[2]}`;
    const insert = '\n' + prefix + indent + newMarker + (taskBox != null ? ' [ ]' : '') + sep;
    return apply({ from: sel.from, to: sel.from, insert }, sel.from + insert.length);
  }

  if (prefix) {
    // Quote line without a list marker.
    if (rest === '') {
      return sel.from === line.to
        ? apply({ from: line.from, to: line.to, insert: '' }, line.from)
        : false;
    }
    if (sel.from < restFrom) return false; // caret inside the quote marker
    const insert = '\n' + prefix;
    return apply({ from: sel.from, to: sel.from, insert }, sel.from + insert.length);
  }

  return false;
}

// Shift+Enter always inserts a plain newline, bypassing marker continuation
// — a one-key opt-out of the smart list/quote behavior (GitHub-style).
function plainNewline(view) {
  view.dispatch(view.state.replaceSelection('\n'), { scrollIntoView: true, userEvent: 'input' });
  return true;
}

const smartListKeymap = Prec.high(keymap.of([
  { key: 'Enter', run: smartEnter },
  { key: 'Shift-Enter', run: plainNewline },
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
    clearReveal();
    scheduleDraftWrite(cur);
    schedulePreviewRender(undefined);
    // Headings may have been added/removed/edited — keep the outline
    // sidebar fresh. Debounced: it re-parses the whole buffer and
    // rebuilds the sidebar DOM, so it shouldn't run per keystroke.
    // (Still a no-op while the sidebar is hidden.)
    debouncedOutlineRefresh();
  };

  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged) onDocChanged(u.state.doc.toString());
    if (u.docChanged || u.selectionSet) debouncedEditorCounts(u.state);
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
    // Snippet field navigation (link/image inserts use snippet tab-stops).
    // Each command is a no-op returning false when no field is active, so
    // these bindings are inert otherwise. The capture-phase handler below
    // defers Tab to this keymap while a field is active so indent doesn't
    // eat it.
    Prec.high(keymap.of([
      { key: 'Tab', run: nextSnippetField, shift: prevSnippetField },
      { key: 'Escape', run: clearSnippet },
    ])),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ extensions: [oxideMarkdownExt] }),
    syntaxHighlighting(oxideHighlightStyle),
    revealHighlightField,
    countField,
    // These three are wrapped in Compartments so a Settings change can
    // reconfigure them on the live editor (see reconfigureEditorSettings)
    // without destroying the view — preserving undo history and selection.
    attrsCompartment.of(EditorView.contentAttributes.of({
      'aria-label': `Edit ${tab.title}`,
      'spellcheck': spellCheck ? 'true' : 'false',
    })),
    wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
    gutterCompartment.of(showLineNumbers ? lineNumbers() : []),
    oxideCmTheme,
    updateListener,
  ];

  // Restore the tab's full CM state (undo history + selection) if we parked
  // one on switch/exit; otherwise build fresh from the string buffer. The
  // fresh path seeds the caret from tab.editorSelection (clamped to the
  // buffer, which may have shrunk on discard/reload) so it doesn't drop to
  // offset 0. Reload / draft recovery clear tab.editorState so a stale state
  // can't override newer disk content.
  //
  // The parked state is only trusted when its doc still matches tab.raw:
  // tab.raw tracks every keystroke, so a mismatch means the park is stale
  // (some path abandoned the live view without re-parking) and restoring it
  // would silently revert the user's text to an old snapshot. Fall back to
  // a fresh build from tab.raw — undo history is lost, text never is.
  const restored = tab.editorState;
  let editorState;
  if (restored && restored.doc.toString() === (tab.raw ?? '')) {
    editorState = restored;
  } else {
    const doc = tab.raw ?? '';
    const anchor = Math.min(tab.editorSelection ?? 0, doc.length);
    editorState = EditorState.create({
      doc,
      selection: EditorSelection.cursor(anchor),
      extensions: baseExtensions,
    });
  }

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
let lastDropKey = '';
let lastDropAt = 0;

export async function dropImagesIntoEditor(paths, x, y) {
  if (!pointInEditor(x, y)) return false;
  const images = paths.filter((p) => DROP_IMAGE_EXTS.has(pathExtension(p)));
  if (!images.length) return false; // non-images fall through (e.g. a .md)

  // Tauri v2 can fire a single file-drop twice (tauri#14134). Ignore an
  // identical payload (same paths + drop point) landing within a short
  // window so the image isn't imported and inserted twice.
  const key = `${x},${y}|${images.join('|')}`;
  const now = Date.now();
  if (key === lastDropKey && now - lastDropAt < 600) return true;
  lastDropKey = key;
  lastDropAt = now;

  const tab = activeTab();
  if (!tab?.path) {
    // assets/ lives beside the file; an unsaved buffer has nowhere to put it.
    showToast('Save the document before adding images', 'error');
    return true; // consumed: don't also try to "open" the image
  }

  // Insert where the user dropped, falling back to the cursor position.
  const view = editorView;
  let pos = view.state.selection.main.from;
  const at = view.posAtCoords({ x, y });
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
  // The imports above are async — the editor may have been remounted for
  // another tab meanwhile, and the doc may have shrunk below the drop point.
  if (editorView !== view) return true;
  pos = Math.min(pos, view.state.doc.length);

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
  // Drop pending debounced repaints from the previous view so they can't
  // fire 100–200ms into the new tab with the old document's data.
  debouncedEditorCounts.cancel();
  debouncedOutlineRefresh.cancel();
  editorPane.innerHTML = '';
  previewPane.innerHTML = '';
  // A fresh mount (tab switch / re-enter) drops any pending or live reveal so
  // it can't leak onto a different document. revealEditorLine re-queues it
  // afterwards when opening a search result.
  pendingPreviewReveal = null;
  clearReveal();

  const view = buildView(tab);
  editorPane.appendChild(view.dom);
  editorView = view;
  // Sync the setting compartments to the current config — a no-op for a
  // freshly-built state, but corrects a restored state whose compartments
  // were parked under a since-changed Settings value.
  applyEditorSettings(view, state.config);

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
  debouncedEditorCounts.cancel();
  debouncedOutlineRefresh.cancel();
  pendingPreviewReveal = null;
  clearReveal();
  editorPane.innerHTML = '';
  previewPane.innerHTML = '';
}

// Set the three editor-setting compartments on `view` to match `cfg` in one
// dispatch. Idempotent — reconfiguring to the same value is a cheap no-op —
// so it doubles as the "resync a restored state's stale compartments" call
// in buildView and the live-toggle path from Settings.
function applyEditorSettings(view, cfg) {
  if (!view) return;
  const tab = activeTab();
  view.dispatch({ effects: [
    wrapCompartment.reconfigure((cfg?.editor_word_wrap !== false) ? EditorView.lineWrapping : []),
    gutterCompartment.reconfigure(cfg?.editor_line_numbers ? lineNumbers() : []),
    attrsCompartment.reconfigure(EditorView.contentAttributes.of({
      'aria-label': `Edit ${tab?.title ?? ''}`,
      'spellcheck': cfg?.editor_spell_check ? 'true' : 'false',
    })),
  ] });
}

// Apply word-wrap / line-number / spell-check changes to the live editor via
// compartment reconfiguration instead of a destructive remount, so a Settings
// toggle takes effect immediately without losing undo history or selection.
// No-op when no editor is mounted. Called from settings save.
export function reconfigureEditorSettings(_prev, next) {
  applyEditorSettings(editorView, next ?? state.config);
}

export function setPreviewHtml(html) {
  // Drop any prior reveal first: the patch may detach its ranges and
  // the block class, so clear them explicitly to keep the registry tidy.
  clearReveal();
  patchPreviewDom(previewPane, html);
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

// Morph the preview's children to match the new render instead of an
// innerHTML swap. A full swap re-parses and re-lays-out the whole document
// and — worst on weak machines — re-creates every <img>, re-fetching and
// re-decoding it through the asset protocol on every debounced render while
// the user types. idiomorph matches nodes by structure + id (headings carry
// ids) and mutates in place, so an unchanged block — decoded image bitmap
// included — survives untouched, and it handles moved/inserted blocks the
// old prefix/suffix scan couldn't (e.g. inserting a paragraph near the top).
function patchPreviewDom(container: HTMLElement, html: string) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  // Hydrate before morphing so old (already-hydrated) and new <img> nodes
  // compare equal — convertFileSrc is deterministic, so an unchanged image
  // is left in place with its decoded bitmap intact.
  hydrateImages(tpl.content);
  Idiomorph.morph(container, tpl.content, { morphStyle: 'innerHTML' });
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
// Debounce grows continuously with document size instead of a hard cliff at
// one threshold: re-rendering a 1 MB+ file on every keystroke saturates the
// IPC pipe, but a 199k→201k step change felt arbitrary. Scale linearly from
// the base up to a ceiling (~600ms is reached around 200k chars).
const PREVIEW_DEBOUNCE_MAX_MS = 600;
let previewTimer = null;
let previewRenderSeq = 0;

function previewDebounceForLength(len) {
  return Math.min(PREVIEW_DEBOUNCE_MAX_MS, PREVIEW_DEBOUNCE_MS + Math.floor(len / 1000) * 2);
}

function schedulePreviewRender(delay?: number) {
  if (previewTimer) clearTimeout(previewTimer);
  let computed = delay;
  if (computed === undefined) {
    const tab = activeTab();
    computed = previewDebounceForLength((tab?.raw ?? '').length);
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
  tab.editorSelection = editorView ? editorView.state.selection.main.head : 0;
  // Park the full CM state so a Ctrl+E back into this tab restores undo
  // history + selection rather than rebuilding from the string buffer.
  tab.editorState = editorView ? editorView.state : tab.editorState;
  tab.previewScrollTop = previewPane.scrollTop;
  tab.editing = false;
  document.body.classList.remove('editing');
  unmountEditor();
  if (keepHtml) {
    renderContent(tab.html);
    // tab.html is the last *saved* render — stale when the buffer has
    // unsaved edits. Re-render the live buffer and swap it in when it
    // lands (unless the user already switched tabs or re-entered editing).
    if (isDirty(tab)) {
      invoke('render_preview', { content: tab.raw ?? '', path: tab.path ?? '' })
        .then((html) => {
          tab.html = html;
          const cur = activeTab();
          if (cur === tab && !cur.editing) renderContent(html);
        })
        .catch(() => {});
    }
  }
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

// Swap the editor buffer to `next` via the smallest possible splice so the
// selection and scroll survive (a whole-document replacement maps the caret
// to the change boundary). No-op when the buffer already matches.
function replaceEditorBuffer(next) {
  if (!editorView) return;
  const splice = diffSplice(editorView.state.doc.toString(), next);
  if (splice) editorView.dispatch({ changes: splice, scrollIntoView: true });
}

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
  // Park the live CM state so the remount below keeps undo history,
  // selection, and scroll instead of rebuilding from the string (the first
  // save of an untitled note used to wipe undo and jump the caret to the
  // top). Skipped if the backend normalized the content — a parked state
  // whose doc differs from tab.raw would diverge from the saved buffer.
  if (editorView && editorView.state.doc.toString() === tab.raw) {
    tab.editorState = editorView.state;
    tab.editorScrollTop = editorView.scrollDOM.scrollTop;
  }
  // Re-render the chrome for the now-file-backed tab: window/document
  // title, status-bar path, tree highlight, and the editor rebound to the
  // new path (so the live preview and image paste resolve correctly).
  applyActiveTab();
  rerender();
  syncWatcher();
  return true;
}

export async function saveActiveFile({ skipFormat = false } = {}) {
  const tab = activeTab();
  // No `editing` gate: a tab that exited edit mode with unsaved changes is
  // still dirty and must be savable (the close-tab prompt's "save" routes
  // here). With no editor mounted, the buffer swap below is just a no-op.
  if (!tab) return false;
  // An in-place save is a no-op when clean; an untitled tab always needs
  // the save-as dialog so it can choose a destination.
  if (tab.path && !isDirty(tab)) return true;

  // Format on save (opt-in). Swap the editor's buffer if the formatter
  // changed anything so the user sees the saved form and the dirty
  // tracking stays consistent. Applied before either save path writes.
  // `skipFormat` (the Save-without-formatting action) bypasses it one-off.
  if (!skipFormat && state.config?.editor_format_on_save) {
    const formatted = formatMarkdownBuffer(tab.raw ?? '');
    if (formatted !== (tab.raw ?? '')) {
      tab.raw = formatted;
      replaceEditorBuffer(formatted);
    }
  }

  // Untitled tabs have no path yet — route to the save-as flow.
  if (!tab.path) return saveUntitledTab(tab);

  // If the file changed on disk since we opened/last-saved it (another tool
  // or machine), warn before overwriting that external edit. Best-effort: a
  // hash we can't compute doesn't block the save.
  if (tab.diskHash) {
    try {
      const live = await invoke('file_sha256', { path: tab.path });
      if (live && live !== tab.diskHash) {
        const decision = await promptOverwriteChanged(tab);
        if (decision !== 'save') return false;
      }
    } catch {}
  }

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
    replaceEditorBuffer(restored);
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
// by finding the matching occurrence of the query in the preview text
// (highlightMatchIn — shared with read mode via ui/reveal.ts).
// `ordinal` is the 0-based index of the hit among all occurrences in the
// source, so the preview highlights the *same* occurrence, not just the
// first — the rendered text preserves source order for plain queries.
let pendingPreviewReveal: any = null; // { query, ordinal } — one-shot

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
    clearReveal();
  }
  applyPreviewReveal();
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
  // While a snippet field is active, let Tab/Shift-Tab reach CM6's snippet
  // keymap to move between fields instead of routing to indent/outdent.
  if ((e.key === 'Tab' || e.key === 'Escape') && editorView &&
      (hasNextSnippetField(editorView.state) || hasPrevSnippetField(editorView.state))) {
    return;
  }
  if (dispatchKey(e, state.bindings, 'editor')) e.stopPropagation();
}, true);

// The shared confirm dialog (unsaved-changes / draft-recovery / settings
// prompts) lives in ui/confirm.ts so read mode can use it without
// loading this (lazy, CodeMirror-heavy) module.

// Jump the mounted editor's cursor to a 1-based source line and center
// it. Used by the outline sidebar, which is a read-mode module and so
// can't touch CodeMirror types itself; a missing editor is a no-op.
export function jumpEditorToLine(line) {
  if (!editorView) return;
  const totalLines = editorView.state.doc.lines;
  const lineNo = Math.max(1, Math.min(line, totalLines));
  const lineObj = editorView.state.doc.line(lineNo);
  editorView.dispatch({
    selection: EditorSelection.cursor(lineObj.from),
    scrollIntoView: true,
  });
  editorView.focus();
}

// ── Edit-mode context menu ───────────────────────────────────────────
// Cut/copy/paste/select-all + formatting for the CM6 editor, built here
// (rather than in ui/contextmenu.ts) because they need EditorSelection
// and the live view. Each edit goes through a single transaction so
// undo/redo gets one history entry per action; cut and copy use the
// async clipboard API since CM6 owns the contenteditable and
// execCommand('cut'/'copy') from outside doesn't fire its handlers.
async function cmCopy(view, sel) {
  const text = view.state.sliceDoc(sel.start, sel.end);
  if (!text) return;
  try { await navigator.clipboard.writeText(text); }
  catch { showToast('Clipboard copy failed', 'error'); }
}
async function cmCut(view, sel) {
  const text = view.state.sliceDoc(sel.start, sel.end);
  if (!text) return;
  // Only delete once the clipboard write actually succeeds — otherwise a
  // rejected writeText would drop the selection without it ever reaching the
  // clipboard, i.e. silent data loss.
  try { await navigator.clipboard.writeText(text); }
  catch { showToast('Clipboard write failed — text not cut', 'error'); return; }
  view.dispatch({
    changes: { from: sel.start, to: sel.end, insert: '' },
    selection: EditorSelection.cursor(sel.start),
  });
  view.focus();
}
async function cmPaste(view, sel) {
  let text = '';
  // Distinguish a blocked read (worth surfacing) from a genuinely empty
  // clipboard (a legitimate no-op) by catching into an early return.
  try { text = await navigator.clipboard.readText(); }
  catch { showToast('Clipboard access was blocked', 'error'); return; }
  if (!text) return;
  view.dispatch({
    changes: { from: sel.start, to: sel.end, insert: text },
    selection: EditorSelection.cursor(sel.start + text.length),
  });
  view.focus();
}
function cmSelectAll(view) {
  view.dispatch({
    selection: EditorSelection.range(0, view.state.doc.length),
  });
  view.focus();
}

// Display accelerator for a rebindable action id, sourced from the live
// keybindings so the menu label follows a user's rebind instead of a
// hardcoded string (fixes stale Underline / missing Code labels). Returns
// undefined when the action is unbound, so the menu simply omits the hint.
function accelFor(id) {
  const primary = state.bindings?.[id]?.primary;
  return primary ? primary.replace('Mod', modKey) : undefined;
}

// Item list for a right-click on the editor surface, consumed by
// ui/contextmenu.ts through the lazy facade (editorModule()); an
// unmounted editor yields no items.
export function buildEditorContextMenu() {
  const view = editorView;
  if (!view) return [];
  // Snapshot selection; the menu click momentarily blurs the editor and
  // we want Cut/Copy/Paste to act on what the user was looking at.
  const r = view.state.selection.main;
  const sel = { start: r.from, end: r.to };
  const hasSelection = sel.start !== sel.end;
  return [
    { label: 'Cut',    action: () => cmCut(view, sel),   disabled: !hasSelection, shortcut: `${modKey}+X` },
    { label: 'Copy',   action: () => cmCopy(view, sel),  disabled: !hasSelection, shortcut: `${modKey}+C` },
    { label: 'Paste',  action: () => cmPaste(view, sel), shortcut: `${modKey}+V` },
    { label: 'Select All', action: () => cmSelectAll(view), shortcut: `${modKey}+A` },
    { separator: true },
    { label: 'Bold',   action: () => applyFormat(view, 'bold'),   shortcut: accelFor('bold') },
    { label: 'Italic', action: () => applyFormat(view, 'italic'), shortcut: accelFor('italic') },
    { label: 'Strikethrough', action: () => applyFormat(view, 'strike'), shortcut: accelFor('strike') },
    { label: 'Underline', action: () => applyFormat(view, 'underline'), shortcut: accelFor('underline') },
    { label: 'Code',   action: () => applyFormat(view, 'code'),   shortcut: accelFor('code') },
    { label: 'Link',   action: () => applyFormat(view, 'link'),   shortcut: accelFor('link') },
  ];
}

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
// Coalesce a burst of scroll events into a single rAF. Doing the
// measure-and-write inline on every scroll event forces a synchronous
// reflow of the other pane (we read its scrollHeight right after writing
// its scrollTop on the previous event) — classic layout thrash. On
// WebKitGTK that reflow lands on the scroll-event path and stalls the
// compositor, so the editor scroll crawls. Deferring to rAF touches
// layout at most once per frame and keeps it off the scroll event.
let scrollSyncFrame = 0;

// Write `target` to `to.scrollTop`, marking it so the resulting scroll event
// isn't mirrored back, with the same two-frame unmark fallback the
// proportional path uses (a clamped write may fire no scroll event).
function writeSyncedScroll(to, target) {
  const toMax = to.scrollHeight - to.clientHeight;
  if (toMax <= 0) return;
  const clamped = Math.max(0, Math.min(toMax, target));
  if (Math.abs(to.scrollTop - clamped) < 0.5) return;
  suppressNextScroll.add(to);
  to.scrollTop = clamped;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { suppressNextScroll.delete(to); });
  });
}

// ── Source-line scroll mapping (D9) ──────────────────────────────────
// Proportional sync drifts whenever the document has tall blocks (images,
// tables, code) because a source line's fractional position ≠ its rendered
// fractional position. When the renderer annotates top-level preview blocks
// with `data-source-line`, we instead map by source line: find the two
// mapped blocks bounding the current position and linearly interpolate.
// Falls back to proportional when no annotations are present, so this is a
// no-op until the renderer emits them.
function sourceLineBlocks() {
  const els = previewPane.querySelectorAll('[data-source-line]');
  const out: { line: number; top: number }[] = [];
  const base = previewPane.getBoundingClientRect().top - previewPane.scrollTop;
  els.forEach((el) => {
    const line = parseInt(el.getAttribute('data-source-line') ?? '', 10);
    if (Number.isFinite(line)) out.push({ line, top: el.getBoundingClientRect().top - base });
  });
  return out; // document order == ascending line and ascending top
}

// Bracket `key` between the last block at/below it and the next one, and
// return the linear interpolation of their `val`s. `pick`/`other` select
// which field is the search key vs the interpolated output.
function interpolateBlocks(blocks, key, pick, other) {
  let lo = blocks[0];
  let hi = null;
  for (const b of blocks) {
    if (b[pick] <= key) lo = b;
    else { hi = b; break; }
  }
  if (!hi) return lo[other];
  const span = hi[pick] - lo[pick];
  const frac = span > 0 ? (key - lo[pick]) / span : 0;
  return lo[other] + frac * (hi[other] - lo[other]);
}

function syncEditorToPreviewByLine(ev) {
  const blocks = sourceLineBlocks();
  if (!blocks.length) return false;
  const info = ev.lineBlockAtHeight(ev.scrollDOM.scrollTop);
  const topLine = ev.state.doc.lineAt(info.from).number;
  writeSyncedScroll(previewPane, interpolateBlocks(blocks, topLine, 'line', 'top'));
  return true;
}

function syncPreviewToEditorByLine(ev) {
  const blocks = sourceLineBlocks();
  if (!blocks.length) return false;
  const line = interpolateBlocks(blocks, previewPane.scrollTop, 'top', 'line');
  const lineNo = Math.max(1, Math.min(ev.state.doc.lines, Math.round(line)));
  const top = ev.lineBlockAt(ev.state.doc.line(lineNo).from).top;
  writeSyncedScroll(ev.scrollDOM, top);
  return true;
}

function mirrorScroll(from, to) {
  if (suppressNextScroll.has(from)) {
    suppressNextScroll.delete(from);
    return;
  }
  if (scrollSyncFrame) return;
  scrollSyncFrame = requestAnimationFrame(() => {
    scrollSyncFrame = 0;
    // Prefer source-line mapping when the renderer annotated the preview;
    // otherwise fall back to the proportional map below.
    const ev = editorView;
    if (ev && previewPane.querySelector('[data-source-line]')) {
      const done = from === ev.scrollDOM
        ? syncEditorToPreviewByLine(ev)
        : syncPreviewToEditorByLine(ev);
      if (done) return;
    }
    // Read the live positions inside the frame so a coalesced burst maps
    // from the gesture's final scrollTop, not the first event's.
    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    if (fromMax <= 0 || toMax <= 0) return;
    const frac = from.scrollTop / fromMax;
    writeSyncedScroll(to, toMax * frac);
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
