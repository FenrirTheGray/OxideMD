// Literal, non-overlapping substring search that returns offsets into the
// ORIGINAL text. Case folding runs per code point and keeps a map back to the
// source, because folding can change length (`İ` lowercases to `i̇`, two code
// units) and offsets found in a folded copy would otherwise drift.

function fold(text: string, caseSensitive: boolean): { folded: string; origin: number[] } {
  if (caseSensitive) return { folded: text, origin: [] };
  let folded = '';
  const origin: number[] = []; // origin[k] = index in `text` of the char folded[k] came from
  let i = 0;
  for (const ch of text) {
    const lower = ch.toLowerCase();
    folded += lower;
    for (let k = 0; k < lower.length; k++) origin.push(i);
    i += ch.length;
  }
  origin.push(i); // sentinel: end of text
  return { folded, origin };
}

export function findMatches(text: string, query: string, caseSensitive: boolean): Array<[number, number]> {
  if (!query) return [];
  const { folded, origin } = fold(text, caseSensitive);
  const needle = fold(query, caseSensitive).folded;
  const out: Array<[number, number]> = [];
  let idx = 0;
  for (;;) {
    const pos = folded.indexOf(needle, idx);
    if (pos === -1) break;
    const end = pos + needle.length;
    if (caseSensitive) out.push([pos, end]);
    else {
      // A match ending mid-way through one source char's fold covers that char.
      const last = origin[end - 1];
      out.push([origin[pos], last + String.fromCodePoint(text.codePointAt(last)!).length]);
    }
    idx = end;
  }
  return out;
}
