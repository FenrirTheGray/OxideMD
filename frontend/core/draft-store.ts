// Per-file edit drafts persisted via the Rust backend (Tauri temp/cache
// files) so an unexpected window close, reload, or crash doesn't lose
// unsaved keystrokes. Drafts are keyed by absolute file path; the payload
// carries the raw markdown plus a savedAt timestamp.
//
// Moved off localStorage (M1/M5): localStorage's ~5 MB ceiling is a poor
// fit for a markdown editor where one note can exceed the whole budget, and
// its synchronous writes stutter mid-typing on large files. The OS-level
// draft store (see `drafts_dir` / write_draft/read_draft/clear_draft in
// src-tauri) has effectively no ceiling, so the old quota-eviction dance is
// gone, and writes happen off the UI thread.
//
// `diskHashAtWrite` records the SHA-256 of the on-disk file at the moment
// the draft was last written. On recovery, tabs.ts compares it to the live
// on-disk hash; a mismatch means the file changed under us (another tool,
// another machine) and we surface that before clobbering the external edit.
//
// Lifecycle: editor.ts debounces writes per input, calls clearDraft after a
// successful save, and tabs.ts prompts via promptRecoverDraft when a draft
// exists for a freshly-opened file. Writes/clears are fire-and-forget (the
// in-memory tab buffer stays authoritative); readDraft is awaited.

import { invoke } from "./state.ts";

type Draft = { content: string; savedAt: number; diskHashAtWrite: string | null };

export async function readDraft(path): Promise<Draft | null> {
  if (!path) return null;
  try {
    const r: any = await invoke("read_draft", { path });
    if (!r || typeof r.content !== "string") return null;
    return {
      content: r.content,
      savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
      diskHashAtWrite: typeof r.diskHashAtWrite === "string" ? r.diskHashAtWrite : null,
    };
  } catch {
    return null;
  }
}

export async function writeDraft(path, content, diskHashAtWrite = null) {
  if (!path) return;
  try {
    await invoke("write_draft", {
      path,
      content,
      diskHash: diskHashAtWrite || null,
      savedAt: Date.now(),
    });
  } catch {
    // Storage unavailable/failed — the in-memory tab buffer is the user's
    // source of truth, so a missed draft only weakens crash recovery.
  }
}

export async function clearDraft(path) {
  if (!path) return;
  try {
    await invoke("clear_draft", { path });
  } catch {}
}
