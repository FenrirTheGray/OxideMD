// Strip labels: a file name shared by several open tabs gets its parent
// folder appended so the tabs can be told apart.
// shortcut: same-named parents (a/x/note.md, b/x/note.md) still read alike; the tooltip has the full path. Walk further up if users hit it.
export function tabLabels(tabs: { title: string; path?: string | null }[]): string[] {
  return tabs.map((t) => {
    if (!t.path || tabs.filter((o) => o.title === t.title).length < 2) return t.title;
    const parent = t.path.split(/[\\/]/).at(-2);
    return parent ? `${t.title} — ${parent}` : t.title;
  });
}

// "Untitled", then "Untitled 2", "Untitled 3", ... reusing the lowest free number.
export function nextUntitledTitle(titles: string[]): string {
  const name = (n: number) => (n === 1 ? 'Untitled' : `Untitled ${n}`);
  let n = 1;
  while (titles.includes(name(n))) n++;
  return name(n);
}
