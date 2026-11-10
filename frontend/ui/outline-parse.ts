// Outline parser, split from outline.ts so it can be unit-tested in Node
// (outline.ts touches the DOM at load) and loaded lazily (lezer-markdown is
// about as big as the startup bundle; the editor chunk shares it).
//
// A real CommonMark block parser, because the read-mode jump picks the Nth
// rendered <hN>: every heading pulldown-cmark renders (in quotes, list items,
// indented, empty, setext after any paragraph) must be an entry, and nothing
// else may be.

import { parser, GFM } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';

const md = parser.configure(GFM);

// Trailing `{#id .class}` heading attributes (pulldown-cmark's
// ENABLE_HEADING_ATTRIBUTES); the renderer strips them, so the outline must too.
const HEADING_ATTRS_RE = /\s*\{[^{}]*\}\s*$/;
const HEADING_RE = /^(?:ATXHeading|SetextHeading)(\d)$/;

export interface OutlineEntry { level: number; text: string; line: number }

// The heading's visible text: its source minus markup (`#`, `**`, backticks,
// link targets, quote markers on setext continuation lines).
function headingText(node: SyntaxNode, src: string): string {
  let out = '';
  let pos = node.from;
  const walk = (n: SyntaxNode) => {
    for (let ch = n.firstChild; ch; ch = ch.nextSibling) {
      const inLink = n.name === 'Link' || n.name === 'Image';
      if (ch.name.endsWith('Mark') || (inLink && /^(URL|LinkTitle|LinkLabel)$/.test(ch.name))) {
        out += src.slice(pos, ch.from);
        pos = ch.to;
      } else if (ch.name === 'Escape') {
        out += src.slice(pos, ch.from) + src.slice(ch.from + 1, ch.to);
        pos = ch.to;
      } else {
        walk(ch);
      }
    }
  };
  walk(node);
  out += src.slice(pos, node.to);
  return out.replace(/\s+/g, ' ').replace(HEADING_ATTRS_RE, '').trim();
}

// `line` is the 1-based line the heading starts on (the text line of a
// setext heading), so the edit-mode jump lands on the heading itself.
export function parseOutline(text: string): OutlineEntry[] {
  if (!text) return [];
  // Line numbers are unchanged; CodeMirror splits lines on the same endings.
  const src = text.replace(/\r\n?/g, '\n');
  const out: OutlineEntry[] = [];
  let line = 1;
  let counted = 0;
  md.parse(src).iterate({
    enter(n) {
      const m = HEADING_RE.exec(n.name);
      if (!m) return;
      for (; counted < n.from; counted++) if (src.charCodeAt(counted) === 10) line++;
      out.push({ level: Number(m[1]), text: headingText(n.node, src), line });
      return false;
    },
  });
  return out;
}
