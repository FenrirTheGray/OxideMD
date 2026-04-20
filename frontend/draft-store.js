// Per-file edit drafts persisted in localStorage so an unexpected window
// close, reload, or crash doesn't lose unsaved keystrokes. Drafts are
// keyed by absolute file path; the value carries the raw markdown plus a
// savedAt timestamp used both for the recovery prompt copy and for
// quota-eviction (oldest goes first).
//
// Lifecycle: editor.js debounces writes per input, calls clearDraft after
// a successful save, and tabs.js prompts the user via promptRecoverDraft
// when a draft exists for a freshly-opened file.
//
// v2 gaps: no conflict detection (we don't compare against the on-disk
// hash at write time), and a single shared debounce timer across tabs
// means rapid switching can drop one tab's pending write — acceptable
// for v1 since tab.raw is still authoritative until the app exits.

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
    };
  } catch {
    return null;
  }
}

export function writeDraft(path, content) {
  if (!path) return;
  const payload = JSON.stringify({ content, savedAt: Date.now() });
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
