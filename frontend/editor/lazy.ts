// Lazy boundary for the editor module. editor/editor.ts (and through it
// all of CodeMirror + the lezer parsers — ~70% of the bundle) is loaded
// on first use instead of at startup, so a viewer-only launch never
// parses it. This file is the only module allowed to import editor.ts;
// everyone else goes through these two accessors:
//
//  - `editorModule()` — synchronous, null until loaded. For call sites
//    that only matter once an editor exists (search bridge, context
//    menu, drop hints): `editorModule()?.fn(...)`. A null module means
//    "no editor has ever been mounted", so the no-op is the correct
//    behavior, not a missed call.
//  - `loadEditorModule()` — the entry points that *create* an editor
//    (enter edit mode, new file, draft recovery) await this.
//
// The import() below is the code-splitting point: esbuild (--splitting)
// emits editor.ts and its CodeMirror dependencies as a separate chunk.

type EditorModule = typeof import("./editor.ts");

let mod: EditorModule | null = null;
let pending: Promise<EditorModule> | null = null;

export function editorModule(): EditorModule | null {
  return mod;
}

export function loadEditorModule(): Promise<EditorModule> {
  if (mod) return Promise.resolve(mod);
  pending ??= import("./editor.ts").then((m) => {
    mod = m;
    return m;
  });
  return pending;
}
