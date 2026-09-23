// Text selection painted line by line with rounded corners, the way VS Code
// draws it and the preview's native selection reads. CM6's drawSelection
// paints a multi-line selection as a slab instead: the first line out to the
// right edge, one full-width block for every line between, the last line in
// from the left edge. drawSelection stays mounted for the cursors and for
// hiding the native selection; the theme hides its selection rectangles.

import { EditorView, layer, RectangleMarker } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';

const CLS = 'cm-lineSelection';
// Horizontal inset of a selection pill at a line's start / end (px), the
// same as its corner radius in the theme.
const PAD = 4;
// Vertical inset from the line box, so stacked pills sit apart (px).
const VPAD = 2;

const lineSelectionLayer = layer({
  above: false,
  class: 'cm-lineSelectionLayer',
  update: (u) => u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged,
  markers(view) {
    // Layer coordinates are relative to the scroller's content origin (the
    // same base RectangleMarker.forRange uses; the app is LTR only).
    const box = view.scrollDOM.getBoundingClientRect();
    const baseLeft = box.left - view.scrollDOM.scrollLeft * view.scaleX;
    const baseTop = box.top - view.scrollDOM.scrollTop * view.scaleY;
    const breakWidth = view.defaultCharacterWidth;
    const out: RectangleMarker[] = [];
    for (const r of view.state.selection.ranges) {
      if (r.empty) continue;
      const end = Math.min(r.to, view.viewport.to);
      for (let pos = Math.max(r.from, view.viewport.from); pos <= end;) {
        const line = view.state.doc.lineAt(pos);
        const from = Math.max(r.from, line.from);
        const to = Math.min(r.to, line.to);
        const block = view.lineBlockAt(line.from);
        const top = (view.documentTop + block.top - baseTop) / view.scaleY + VPAD;
        const height = block.height / view.scaleY - 2 * VPAD;
        let pieces: RectangleMarker[] = from < to ? [...RectangleMarker.forRange(view, CLS, EditorSelection.range(from, to))] : [];
        // forRange sizes a piece to the glyphs; an unwrapped line takes its
        // line box instead (less VPAD top and bottom), so every row's pill is
        // the same height and stacked rows sit an even gap apart.
        // (A wrapped line keeps forRange's per-row pieces.)
        if (pieces.length === 1) pieces = [new RectangleMarker(CLS, pieces[0].left, top, pieces[0].width, height)];
        // Only the line break selected (a blank line, or a selection starting
        // at the line's end): a zero-width piece there, widened below.
        if (!pieces.length && r.to > line.to) {
          const c = view.coordsAtPos(from);
          if (c) pieces.push(new RectangleMarker(CLS, (c.left - baseLeft) / view.scaleX, top, 0, height));
        }
        if (pieces.length) {
          // Breathing room at each end: PAD where the pill meets the line's
          // start or end, or whitespace next to a mid-line boundary; a
          // character's width when the selection takes the line break (so
          // selected line ends show). A boundary inside a word stays exact,
          // so no neighbouring glyph is covered.
          const doc = view.state.doc;
          const lead = from === line.from || /\s/.test(doc.sliceString(from - 1, from)) ? PAD : 0;
          const trail = r.to > line.to ? breakWidth
            : to === line.to || /\s/.test(doc.sliceString(to, to + 1)) ? PAD : 0;
          const first = pieces[0];
          pieces[0] = new RectangleMarker(CLS, first.left - lead, first.top, (first.width ?? 0) + lead, first.height);
          const last = pieces[pieces.length - 1];
          pieces[pieces.length - 1] = new RectangleMarker(CLS, last.left, last.top, (last.width ?? 0) + trail, last.height);
        }
        out.push(...pieces);
        pos = line.to + 1;
      }
    }
    return out;
  },
});

// `cm-hasSelection` on the editor while any range is non-empty, so the theme
// can drop the active-line wash, which is painted over this (below-text)
// layer and would tint the selection on the cursor's line differently.
const hasSelectionClass = EditorView.editorAttributes.compute(['selection'], (s) =>
  s.selection.ranges.some((r) => !r.empty) ? { class: 'cm-hasSelection' } : {});

export const lineSelection = [lineSelectionLayer, hasSelectionClass];
