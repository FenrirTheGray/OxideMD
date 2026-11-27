// Rendered editing: the Markdown source stays the document, and decorations
// make it read like the rendered page. Markup is hidden until the selection
// touches it, headings / quotes / code get their rendered look, a bullet's
// dash is painted over with a dot and a task marker with a box. Nothing here
// writes to the document except a click on a task box, which flips its one
// character.
//
// Every decoration is a mark or a line class, styled in editor.css under
// `.cm-live`; nothing is replaced and there are no widgets. A replaced range
// is a non-editable island in the editable text, and WebKitGTK aborts its
// web process when an assistive technology is attached, the document holds
// a character outside Latin-1 (an em dash is enough) and the caret reaches
// the end. Hiding with CSS keeps the DOM plain editable text (editor.css
// says which CSS, and why not the obvious kinds).
//
// Kept free of app imports so the range builder runs headlessly in Node.
//
// shortcut: images and tables are not drawn. An image shows as its Markdown,
// a table as aligned monospace source (liveTableAlign keeps the columns).
// Drawing them needs block widgets, which are exactly the islands above; do
// it when rendered mode has to match the read view for them and the WebKit
// crash is gone or worked around.

import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

// The `x` (or space) inside a task marker starting at `from`: `[ ]` / `[x]`.
export function taskToggleChange(state: EditorState, from: number) {
  const marker = state.doc.sliceString(from, from + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return null;
  return { from: from + 1, to: from + 2, insert: marker[1] === ' ' ? 'x' : ' ' };
}

const hide = Decoration.mark({ class: 'cm-lp-hide' });
const lineDeco = (cls: string) => Decoration.line({ class: cls });
const HEADING = [1, 2, 3, 4, 5, 6].map((n) => lineDeco(`cm-lp-h cm-lp-h${n}`));
const QUOTE = lineDeco('cm-lp-quote');
const CODE = lineDeco('cm-lp-mono cm-lp-codeblock');
const CODE_FIRST = lineDeco('cm-lp-codeblock-first');
const CODE_LAST = lineDeco('cm-lp-codeblock-last');
const TABLE = lineDeco('cm-lp-mono cm-lp-table');
const RULE = lineDeco('cm-lp-hr');
const PREFIX = Decoration.mark({ class: 'cm-lp-prefix' });
const INLINE_CODE = Decoration.mark({ class: 'cm-lp-code' });
const CODE_INFO = Decoration.mark({ class: 'cm-lp-codeinfo' });
const LITERAL = Decoration.mark({ class: 'cm-lp-literal' });
// The dash stays in the DOM and CSS paints over it: a `•`, or nothing on a
// task item, where the box stands in for the bullet.
const BULLET = Decoration.mark({ class: 'cm-lp-bullet' });
const BULLET_BLANK = Decoration.mark({ class: 'cm-lp-bullet cm-lp-bullet-blank' });
// The `[ ]` stays as text under a painted box. The role makes it a checkbox
// to assistive technology, whose press arrives as the same click.
const BOX = [false, true].map((on) => Decoration.mark({
  class: on ? 'cm-lp-task cm-lp-task-done' : 'cm-lp-task',
  attributes: { role: 'checkbox', 'aria-checked': String(on), 'aria-label': 'Task done' },
}));

// Marks hidden until the selection touches the node they belong to.
const NODE_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'URL', 'LinkTitle', 'LinkLabel']);

// `deco` is everything drawn; `atomic` is the subset the caret must step
// over whole (the task boxes, whose three characters are never visible).
export function buildLivePreview(state: EditorState, visible: readonly { from: number; to: number }[]) {
  const doc = state.doc;
  const deco: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const touched = (from: number, to: number) =>
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const lineTouched = (pos: number) => { const l = doc.lineAt(pos); return touched(l.from, l.to); };

  for (const { from, to } of visible) {
    // Only the lines in view: a long code block is not decorated end to end.
    const lines = (nFrom: number, nTo: number, d: Decoration) => {
      for (let pos = Math.max(nFrom, from); pos <= Math.min(nTo, to);) {
        const l = doc.lineAt(pos);
        deco.push(d.range(l.from));
        pos = l.to + 1;
      }
    };
    syntaxTree(state).iterate({
      from, to,
      enter(n) {
        const name = n.name;
        // Columns are padded source; hiding marks inside would break them.
        if (name === 'Table') { lines(n.from, n.to, TABLE); return false; }
        // Drawn as source (see the note at the top of the file).
        if (name === 'Image') return false;
        if (name === 'FencedCode' || name === 'CodeBlock') {
          lines(n.from, n.to, CODE);
          deco.push(CODE_FIRST.range(doc.lineAt(n.from).from), CODE_LAST.range(doc.lineAt(n.to).from));
          return;
        }
        if (name === 'Blockquote') { lines(n.from, n.to, QUOTE); return; }
        if (name === 'CodeInfo') { deco.push(CODE_INFO.range(n.from, n.to)); return; }
        if (name === 'InlineCode') { deco.push(INLINE_CODE.range(n.from, n.to)); return; }
        // `[text]` with no target is literal text to the renderer, so it
        // keeps its brackets and loses the link colour.
        if (name === 'Link' && !n.node.getChild('URL') && !n.node.getChild('LinkLabel')) {
          deco.push(LITERAL.range(n.from, n.to));
          return false;
        }
        const h = /Heading(\d)$/.exec(name);
        if (h) { deco.push(HEADING[+h[1] - 1].range(doc.lineAt(n.from).from)); return; }

        if (name === 'HorizontalRule') {
          if (lineTouched(n.from)) return;
          deco.push(RULE.range(doc.lineAt(n.from).from), hide.range(n.from, n.to));
          return;
        }
        if (name === 'TaskMarker') {
          const box = BOX[+/x/i.test(doc.sliceString(n.from + 1, n.from + 2))].range(n.from, n.to);
          deco.push(box);
          atomic.push(box);
          return;
        }
        if (name === 'ListMark') {
          const l = doc.lineAt(n.from);
          const task = n.node.nextSibling?.firstChild;
          const isTask = task?.name === 'TaskMarker';
          let end = isTask ? task.to : n.to;
          while (end < l.to && /[ \t]/.test(doc.sliceString(end, end + 1))) end++;
          // A hanging indent, so wrapped text lines up under the item's
          // first word. Not inside a quote: its `>` prefix is not columns.
          if (/^[ \t]*$/.test(l.text.slice(0, n.from - l.from))) {
            const cols = end - l.from;
            deco.push(
              Decoration.line({ class: 'cm-lp-li', attributes: { style: `--lp-hang:${cols}` } }).range(l.from),
              PREFIX.range(l.from, end),
            );
          }
          const bullet = /^[-*+]$/.test(doc.sliceString(n.from, n.to));
          if (bullet && !touched(l.from, l.to)) deco.push((isTask ? BULLET_BLANK : BULLET).range(n.from, n.to));
          return;
        }
        // `#` and `>` come back for the whole line (a heading for its whole
        // node, so the caret on a setext title shows the underline).
        if (name === 'HeaderMark' || name === 'QuoteMark') {
          const p = n.node.parent;
          if (name === 'HeaderMark' ? touched(p.from, p.to) : lineTouched(n.from)) return;
          const space = doc.sliceString(n.to, n.to + 1) === ' ' ? 1 : 0;
          deco.push(hide.range(n.from, n.to + space));
          return;
        }
        if (NODE_MARKS.has(name)) {
          const p = n.node.parent;
          if (!p || touched(p.from, p.to)) return;
          if (p.name === 'LinkReference') return; // a definition line is all source
          // Outside a link only the marks go (an autolink's URL is its content).
          if (p.name !== 'Link' && !name.endsWith('Mark')) return;
          deco.push(hide.range(n.from, n.to));
        }
      },
    });
  }
  return { deco: Decoration.set(deco, true), atomic: Decoration.set(atomic, true) };
}

const plugin = ViewPlugin.fromClass(class {
  deco: DecorationSet;
  atomic: DecorationSet;
  // The reading column is narrower than the scroller, and a press beside it
  // lands on the scroller, outside the editable content: left to the
  // browser it may take focus away from the editor. Put the caret on the
  // nearest line instead, as a press beside the text does in source mode.
  onMargin: (e: MouseEvent) => void;
  constructor(readonly view: EditorView) {
    this.build(view);
    this.onMargin = (e) => {
      const sd = view.scrollDOM;
      if (e.target !== sd || e.button !== 0) return;
      if (e.clientX > sd.getBoundingClientRect().right - 20) return; // the scrollbar
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtCoords({ x: e.clientX, y: e.clientY }, false) } });
      view.focus();
    };
    view.scrollDOM.addEventListener('mousedown', this.onMargin);
  }
  destroy() { this.view.scrollDOM.removeEventListener('mousedown', this.onMargin); }
  update(u: ViewUpdate) {
    // The parser works ahead of the viewport in the background, so a new
    // tree arrives without a document change.
    if (u.docChanged || u.selectionSet || u.viewportChanged
        || syntaxTree(u.startState) !== syntaxTree(u.state)) this.build(u.view);
  }
  build(view: EditorView) {
    ({ deco: this.deco, atomic: this.atomic } = buildLivePreview(view.state, view.visibleRanges));
  }
}, { decorations: (v) => v.deco });

// A click past the end of a line lands at the end of the text that is
// drawn. When only hidden markup follows (`**bold**` ends the line), the end
// of the line is what was pointed at; left alone, the caret would sit inside
// the bold and the next words typed would be bold too.
export const snapPastHidden = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.isUserEvent('select.pointer')) return tr;
  const sel = tr.newSelection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return tr;
  const line = tr.startState.doc.lineAt(sel.main.head);
  let pos = sel.main.head;
  if (pos === line.to) return tr;
  // What was hidden when the click landed: the state before this selection.
  buildLivePreview(tr.startState, [line]).deco.between(pos, line.to, (from, to, d) => {
    if (d.spec.class === 'cm-lp-hide' && from <= pos) pos = Math.max(pos, to);
  });
  return pos < line.to ? tr : [tr, { selection: { anchor: line.to } }];
});

// A press on a task box flips it. mousedown is swallowed so the press does
// not move the caret into the box; the flip waits for `click`, which is also
// what an assistive-technology press sends. The box's position is read from
// the DOM at click time. No userEvent on the change: liveTableAlign re-pads
// on typed input and would also touch a table the caret happens to sit in.
const taskBox = (e: Event) => (e.target as Element | null)?.closest?.('.cm-lp-task') ?? null;
const taskClicks = EditorView.domEventHandlers({
  mousedown(e) {
    if (!taskBox(e)) return false;
    e.preventDefault();
    return true;
  },
  click(e, view) {
    const box = taskBox(e);
    if (!box) return false;
    e.preventDefault();
    const change = taskToggleChange(view.state, view.posAtDOM(box));
    if (change) view.dispatch({ changes: change });
    view.focus();
    return true;
  },
});

export const livePreview = [
  plugin,
  taskClicks,
  snapPastHidden,
  EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  EditorView.editorAttributes.of({ class: 'cm-live' }),
];
