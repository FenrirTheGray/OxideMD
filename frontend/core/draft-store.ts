// Per-file edit drafts persisted in localStorage so an unexpected window
// close, reload, or crash doesn't lose unsaved keystrokes. Drafts are
// keyed by absolute file path; the value carries the raw markdown plus a
// savedAt timestamp used both for the recovery prompt copy and for
// quota-eviction (oldest goes first).
//
// `diskHashAtWrite` records the SHA-256 of the on-disk file at the
// moment the draft was last written. On recovery, tabs.js compares it
// to the live on-disk hash; a mismatch means the file changed under us
// (another tool, another machine) and we surface that to the user
// before potentially clobbering their external edit with a stale draft.
//
// Lifecycle: editor.js debounces writes per input, calls clearDraft after
// a successful save, and tabs.js prompts the user via promptRecoverDraft
// when a draft exists for a freshly-opened file.

const PREFIX = 'oxidemd:draft:';
const keyFor = (path) => PREFIX + path;

export function readDraft(path) {
  if (!path) return null;
  try {
    const raw = localStorage.getItem(keyFor(path));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.content !== 'string') return null;
    return {
      content: parsed.content,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
      diskHashAtWrite: typeof parsed.diskHashAtWrite === 'string' ? parsed.diskHashAtWrite : null,
    };
  } catch {
    return null;
  }
}

export function writeDraft(path, content, diskHashAtWrite = null) {
  if (!path) return;
  const payload = JSON.stringify({
    content,
    savedAt: Date.now(),
    diskHashAtWrite: diskHashAtWrite || null,
  });
  try {
    localStorage.setItem(keyFor(path), payload);
  } catch (e) {
    // Quota or storage unavailable. Try once more after evicting the
    // oldest draft; if that still fails we silently give up — the
    // in-memory tab buffer is the user's source of truth either way.
    if (e?.name === 'QuotaExceededError' && evictOldestDraft()) {
      try { localStorage.setItem(keyFor(path), payload); } catch {}
    }
  }
}

export function clearDraft(path) {
  if (!path) return;
  try { localStorage.removeItem(keyFor(path)); } catch {}
}

function evictOldestDraft() {
  let oldestKey = null;
  let oldestAt = Infinity;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      const at = typeof parsed?.savedAt === 'number' ? parsed.savedAt : 0;
      if (at < oldestAt) { oldestAt = at; oldestKey = key; }
    } catch {
      // Corrupt entry — evict it preferentially.
      oldestKey = key;
      break;
    }
  }
  if (!oldestKey) return false;
  try { localStorage.removeItem(oldestKey); return true; } catch { return false; }
}
