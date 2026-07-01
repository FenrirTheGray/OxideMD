// Markdown formatting actions for the CodeMirror 6 editor.
//
// Every mutation is a single CM6 transaction so undo/redo gets a clean
// history entry per action. After dispatch we re-focus the view because
// toolbar clicks momentarily blur the editor.

import { EditorSelection } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { snippet } from '@codemirror/autocomplete';
import {
  toggleOrderedBlock, buildHrInsert, LIST_PREFIX_RE,
  codeSpan, unpadCode, codeFence, stripCodeSpan,
} from './md-transform.ts';

// Walk up from `pos` to the nearest enclosing lezer-markdown node named
// `nodeName` (e.g. 'StrongEmphasis', 'Emphasis', 'Strikethrough',
// 'InlineCode'). Returns the node or null. Used so a bare cursor sitting
// inside an inline span can toggle it off — the one toggle case pure string
// slicing can't cover.
function enclosingNode(state, pos, nodeName) {
  let n = syntaxTree(state).resolveInner(pos, 0);
  for (; n; n = n.parent) if (n.name === nodeName) return n;
  return null;
}

// The two delimiter mark nodes (open, close) of an inline span — their names
// end in 'Mark' (EmphasisMark, CodeMark). Returns null unless both are found.
function delimiterMarks(node) {
  const marks = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name.endsWith('Mark')) marks.push(c);
  }
  return marks.length >= 2 ? [marks[0], marks[marks.length - 1]] : null;
}

function getSel(view) {
  const r = view.state.selection.main;
  return { s: r.from, e: r.to };
}
function getDoc(view) { return view.state.doc.toString(); }

// Apply a change and (optionally) a new selection in one transaction. The
// selection coordinates are absolute positions in the *new* doc, so callers
// compute them in terms of the inserted text's length. Re-focuses the view
// because toolbar clicks pull focus away.
function edit(view: any, from: any, to: any, insert: any, selFrom?: any, selTo?: any) {
  const tr: any = { changes: { from, to, insert } };
  if (selFrom != null) {
    tr.selection = EditorSelection.range(selFrom, selTo ?? selFrom);
  }
  view.dispatch(tr);
  view.focus();
}

function atLineStart(v, pos) {
  return pos === 0 || v[pos - 1] === '\n';
}

// Block-op helper: expand the current selection to cover whole lines.
// Mirrors the textarea version's edge case where a selection ending at a
// line boundary doesn't pull in the empty line below.
function expandToLines(view) {
  const v = getDoc(view);
  const { s, e } = getSel(view);
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = v.indexOf('\n', e);
  if (lineEnd === -1) lineEnd = v.length;
  if (e > s && e === lineStart && lineEnd !== v.length) lineEnd = lineStart;
  return { lineStart, lineEnd, block: v.slice(lineStart, lineEnd) };
}

// ── Inline wrappers (bold / italic / strike / code) ───────────────────
// Toggle an inline marker (**, *, ~~) across every selection range in one
// transaction. Multi-cursor aware, and reads only the per-range slices via
// `sliceDoc` rather than materializing the whole document on each call. The
// three toggle cases match the previous single-selection behavior exactly.
function wrapInline(view, marker, placeholder, nodeName?) {
  const mLen = marker.length;
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const { from, to } = range;
    const sel = state.sliceDoc(from, to);

    // Case 0: bare cursor inside an existing span of this kind — unwrap it
    // by deleting its two delimiter marks. This is the toggle-off case that
    // string matching around an empty selection can't see.
    if (range.empty && nodeName) {
      const node = enclosingNode(state, from, nodeName);
      const marks = node && delimiterMarks(node);
      if (marks) {
        const [open, close] = marks;
        return {
          changes: [
            { from: open.from, to: open.to, insert: '' },
            { from: close.from, to: close.to, insert: '' },
          ],
          range: EditorSelection.cursor(from - (open.to - open.from)),
        };
      }
    }

    // Case A: marker sits just outside the range (caret was inside an
    // existing **bold** pair, range covers just `bold`) — strip the markers.
    if (sel && from >= mLen && to + mLen <= state.doc.length
        && state.sliceDoc(from - mLen, from) === marker
        && state.sliceDoc(to, to + mLen) === marker) {
      return {
        changes: { from: from - mLen, to: to + mLen, insert: sel },
        range: EditorSelection.range(from - mLen, from - mLen + sel.length),
      };
    }
    // Case B: range includes the markers (user selected `**bold**`) — strip.
    if (sel.length >= 2 * mLen && sel.startsWith(marker) && sel.endsWith(marker)) {
      const inner = sel.slice(mLen, -mLen);
      return {
        changes: { from, to, insert: inner },
        range: EditorSelection.range(from, from + inner.length),
      };
    }
    // Case C: wrap. With no selection, drop a placeholder and select it.
    const inner = sel || placeholder;
    return {
      changes: { from, to, insert: marker + inner + marker },
      range: EditorSelection.range(from + mLen, from + mLen + inner.length),
    };
  });
  view.dispatch(state.update(tr, { userEvent: 'input', scrollIntoView: true }));
  view.focus();
}

// Inline code gets its own wrapper because — unlike bold/italic/strike — the
// backtick fence isn't a fixed length: it has to be longer than the longest
// backtick run in the content, with edge backticks padded by a space. Toggle
// detection therefore works against a backtick fence of any length.
function wrapCode(view) {
  const { state } = view;
  // A code fence can't be longer than a handful of backticks in practice;
  // bound the before-cursor look-back so Case A stays O(1) instead of slicing
  // the whole prefix on every call.
  const LOOKBACK = 16;
  const tr = state.changeByRange((range) => {
    const { from, to } = range;
    const sel = state.sliceDoc(from, to);

    // Case 0: bare cursor inside an existing inline-code span — unwrap it by
    // deleting its two CodeMark delimiters (the syntax-tree case a string
    // scan around an empty selection can't cover).
    if (range.empty) {
      const node = enclosingNode(state, from, 'InlineCode');
      const marks = node && delimiterMarks(node);
      if (marks) {
        const [open, close] = marks;
        return {
          changes: [
            { from: open.from, to: open.to, insert: '' },
            { from: close.from, to: close.to, insert: '' },
          ],
          range: EditorSelection.cursor(from - (open.to - open.from)),
        };
      }
    }

    // Case B: the selection itself is a code span (`x`, ``x``, …) — strip it.
    const inner = stripCodeSpan(sel);
    if (inner != null) {
      return {
        changes: { from, to, insert: inner },
        range: EditorSelection.range(from, from + inner.length),
      };
    }
    // Case A: matching backtick fences sit just outside the selection — strip.
    const before = sel ? /(`+)$/.exec(state.sliceDoc(Math.max(0, from - LOOKBACK), from)) : null;
    if (before && state.sliceDoc(to, to + before[1].length) === before[1]) {
      const fence = before[1];
      const stripped = unpadCode(sel);
      return {
        changes: { from: from - fence.length, to: to + fence.length, insert: stripped },
        range: EditorSelection.range(from - fence.length, from - fence.length + stripped.length),
      };
    }
    // Case C: wrap, sizing the fence to the content and padding edge backticks.
    const content = sel || 'code';
    const { fence, pad } = codeSpan(content);
    const start = from + fence.length + pad.length;
    return {
      changes: { from, to, insert: fence + pad + content + pad + fence },
      range: EditorSelection.range(start, start + content.length),
    };
  });
  view.dispatch(state.update(tr, { userEvent: 'input', scrollIntoView: true }));
  view.focus();
}

// ── Underline (asymmetric <u>…</u> wrap) ──────────────────────────────
// Markdown has no native underline, so this wraps the selection in the
// HTML <u> tag (the renderer allowlists the bare tag). Unlike wrapInline
// the open/close markers differ, so toggle-off has to check for `<u>`
// before and `</u>` after the selection.
const U_OPEN = '<u>';
const U_CLOSE = '</u>';
function toggleUnderline(view) {
  const v = getDoc(view);
  const { s, e } = getSel(view);
  const sel = v.slice(s, e);

  // Case A: tags sit just outside the selection — strip them.
  if (
    sel &&
    s >= U_OPEN.length &&
    v.slice(s - U_OPEN.length, s) === U_OPEN &&
    v.slice(e, e + U_CLOSE.length) === U_CLOSE
  ) {
    edit(view, s - U_OPEN.length, e + U_CLOSE.length, sel, s - U_OPEN.length, s - U_OPEN.length + sel.length);
    return;
  }
  // Case B: selection includes the tags — strip them.
  if (sel.startsWith(U_OPEN) && sel.endsWith(U_CLOSE) && sel.length >= U_OPEN.length + U_CLOSE.length) {
    const inner = sel.slice(U_OPEN.length, -U_CLOSE.length);
    edit(view, s, e, inner, s, s + inner.length);
    return;
  }
  // Case C: wrap. With no selection, drop a placeholder and select it.
  const inner = sel || 'underline';
  edit(view, s, e, U_OPEN + inner + U_CLOSE, s + U_OPEN.length, s + U_OPEN.length + inner.length);
}

// ── Line prefix toggles (headings / list / quote / task) ──────────────
function togglePrefix(view, prefix, exactRe, familyRe = exactRe) {
  const { lineStart, lineEnd, block } = expandToLines(view);
  const lines = block.length === 0 ? [''] : block.split('\n');
  const allExact = lines.every(l => exactRe.test(l));

  const next = allExact
    ? lines.map(l => l.replace(exactRe, ''))
    : lines.map(l => prefix + l.replace(familyRe, ''));
  const result = next.join('\n');
  edit(view, lineStart, lineEnd, result, lineStart, lineStart + result.length);
}

function toggleOrdered(view) {
  const { lineStart, lineEnd, block } = expandToLines(view);
  const result = toggleOrderedBlock(block);
  edit(view, lineStart, lineEnd, result, lineStart, lineStart + result.length);
}

// ── Block inserts (link / image / code block / hr) ────────────────────
// A scheme-prefixed URL on the clipboard fills the url slot directly instead
// of the `url` placeholder (mirrors Google Docs / GitHub). Kept strict —
// scheme-only — so arbitrary clipboard text never lands in the url slot.
const CLIPBOARD_URL_RE = /^(?:https?:\/\/|mailto:|tel:)\S+$/i;
async function clipboardUrl() {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    return CLIPBOARD_URL_RE.test(t) ? t : null;
  } catch { return null; }
}

async function insertLink(view) {
  const { s, e } = getSel(view);
  // No selection: insert with snippet tab-stops so Tab jumps text → url.
  if (s === e) {
    snippet('[${text}](${url})')(view, null, s, e);
    view.focus();
    return;
  }
  // Text selected: it becomes the label; fill the url from a clipboard URL
  // when one is present, else drop the `url` placeholder selected.
  const text = getDoc(view).slice(s, e);
  const url = await clipboardUrl();
  const out = `[${text}](${url ?? 'url'})`;
  if (url) {
    const end = s + out.length;  // whole link filled — caret after it
    edit(view, s, e, out, end, end);
  } else {
    const urlStart = s + 1 + text.length + 2;  // '[' + text + ']('
    edit(view, s, e, out, urlStart, urlStart + 3);
  }
}

async function insertImage(view) {
  const { s, e } = getSel(view);
  if (s === e) {
    snippet('![${alt}](${url})')(view, null, s, e);
    view.focus();
    return;
  }
  const alt = getDoc(view).slice(s, e);
  const url = await clipboardUrl();
  const out = `![${alt}](${url ?? 'url'})`;
  if (url) {
    const end = s + out.length;
    edit(view, s, e, out, end, end);
  } else {
    const urlStart = s + 2 + alt.length + 2;  // '![' + alt + ']('
    edit(view, s, e, out, urlStart, urlStart + 3);
  }
}

function insertCodeBlock(view) {
  const v = getDoc(view);
  const { s, e } = getSel(view);
  const sel = v.slice(s, e);
  const pre = atLineStart(v, s) ? '' : '\n';
  const fence = codeFence(sel);  // ≥3 backticks, longer than any run inside
  const snippet = `${pre}${fence}\n${sel}\n${fence}\n`;
  if (!sel) {
    const caret = s + pre.length + fence.length + 1;  // pre + fence + '\n'
    edit(view, s, e, snippet, caret, caret);
  } else {
    edit(view, s, e, snippet);
  }
}

function insertHr(view) {
  const v = getDoc(view);
  const { s } = getSel(view);
  edit(view, s, s, buildHrInsert(v.slice(0, s)));
}

// ── Indent / outdent (Tab / Shift+Tab) ────────────────────────────────
// ponytail: single indent unit shared by indent/outdent so the insert width
// and the strip-count never drift. Read from an editor indent-width config
// here if such a setting is ever added.
const INDENT = '  ';
const OUTDENT_RE = new RegExp(`^ {1,${INDENT.length}}`);

function indent(view) {
  const { s, e } = getSel(view);
  // No selection: insert an indent at the caret (acts like Tab).
  if (s === e) {
    edit(view, s, e, INDENT, s + INDENT.length, s + INDENT.length);
    return;
  }
  // A selection (single- or multi-line): indent every line it spans rather
  // than replacing the selected text with spaces, and keep the lines selected
  // so the action can be repeated or reversed with outdent.
  const { lineStart, lineEnd, block } = expandToLines(view);
  const result = block.split('\n').map(l => INDENT + l).join('\n');
  edit(view, lineStart, lineEnd, result, lineStart, lineStart + result.length);
}

function outdent(view) {
  const { lineStart, lineEnd, block } = expandToLines(view);
  const lines = block.split('\n');
  const result = lines.map(l => l.replace(OUTDENT_RE, '')).join('\n');
  if (result === block) return;
  edit(view, lineStart, lineEnd, result, lineStart, lineStart + result.length);
}

// ── Dispatcher ────────────────────────────────────────────────────────
const H1_EXACT   = /^#\s/;
const H2_EXACT   = /^##\s/;
const H3_EXACT   = /^###\s/;
const HEADING_RE = /^#{1,6}\s/;
const BULLET_EXACT = /^-\s(?!\[)/;
const TASK_EXACT   = /^-\s\[[ xX]\]\s/;
const QUOTE_RE   = /^>\s/;

export function applyFormat(view, action) {
  if (!view) return;
  switch (action) {
    case 'bold':      return wrapInline(view, '**', 'bold text', 'StrongEmphasis');
    case 'italic':    return wrapInline(view, '*',  'italic text', 'Emphasis');
    case 'strike':    return wrapInline(view, '~~', 'strikethrough', 'Strikethrough');
    case 'underline': return toggleUnderline(view);
    case 'code':      return wrapCode(view);
    case 'h1':        return togglePrefix(view, '# ',     H1_EXACT, HEADING_RE);
    case 'h2':        return togglePrefix(view, '## ',    H2_EXACT, HEADING_RE);
    case 'h3':        return togglePrefix(view, '### ',   H3_EXACT, HEADING_RE);
    case 'ul':        return togglePrefix(view, '- ',     BULLET_EXACT, LIST_PREFIX_RE);
    case 'task':      return togglePrefix(view, '- [ ] ', TASK_EXACT,   LIST_PREFIX_RE);
    case 'quote':     return togglePrefix(view, '> ',     QUOTE_RE);
    case 'ol':        return toggleOrdered(view);
    case 'link':      return insertLink(view);
    case 'image':     return insertImage(view);
    case 'codeblock': return insertCodeBlock(view);
    case 'hr':        return insertHr(view);
    case 'indent':    return indent(view);
    case 'outdent':   return outdent(view);
  }
}
