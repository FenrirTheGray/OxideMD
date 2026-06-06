//! File-system watcher for the currently open file(s) and folder.
//!
//! We keep a single recursive `RecommendedWatcher` behind a mutex. When the
//! frontend calls `set_watch_paths`, the previous watcher is dropped and a
//! new one is created with just the caller's paths. Events from the OS are
//! emitted to the webview as the `fs-changed` event carrying the path that
//! changed.
//!
//! ## Coalescing
//!
//! Raw `notify` fires a burst of events per change: a single editor save is
//! several write/truncate/rename events, and a `git checkout` over a large
//! tree can produce thousands of events per second. Forwarding every one of
//! them would spam the webview. We apply a cheap leading-edge coalesce per
//! path: the first event for a path is emitted immediately (so the UI stays
//! responsive), then further events for that same path are dropped until a
//! short quiet window has elapsed. The frontend already coalesces
//! `fs-changed` per path on its side too — this just stops the Rust side
//! from flooding the IPC channel in the first place.

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

/// Minimum quiet window between two emitted `fs-changed` events for the
/// same path. The first event in a burst is emitted immediately; events
/// that arrive within this window of the last emit for that path are
/// dropped. Tuned to swallow an editor's multi-event save and a
/// `git checkout` storm while still feeling instant for a real edit.
const COALESCE_WINDOW: Duration = Duration::from_millis(150);

/// Hard cap on how many per-path timestamps `should_emit` tracks. The map
/// only needs the paths touched within the last `COALESCE_WINDOW`;
/// anything older can't suppress a future event. A long-lived watch over
/// a churning tree (a `git checkout` storm touching thousands of files)
/// would otherwise grow the map without bound. When the cap is hit we
/// clear the whole map — O(1) amortized, and forgetting debounce state at
/// worst lets a few paths re-emit once (which the frontend coalesces)
/// rather than paying an O(n) staleness sweep on every insert.
const MAX_TRACKED_PATHS: usize = 8192;

/// Decide whether an event for `path` at time `now` should be emitted,
/// updating `last_emit` when it should. Pure leading-edge debounce: emit
/// if we've never emitted for this path, or if the last emit was longer
/// ago than `window`; otherwise drop. Extracted from the watcher callback
/// so the coalesce decision can be unit-tested without spinning up
/// `notify`.
fn should_emit(
    last_emit: &mut HashMap<PathBuf, Instant>,
    path: &Path,
    now: Instant,
    window: Duration,
) -> bool {
    match last_emit.get(path) {
        Some(&prev) if now.duration_since(prev) < window => false,
        _ => {
            // Bound memory: drop everything once we cross the cap. See
            // MAX_TRACKED_PATHS for why a full clear is the right trade.
            if last_emit.len() >= MAX_TRACKED_PATHS {
                last_emit.clear();
            }
            last_emit.insert(path.to_path_buf(), now);
            true
        }
    }
}

/// Replace the currently-watched paths with `paths`. The previous watcher
/// (if any) is dropped, which stops all prior watches atomically.
///
/// Paths that fail to watch (non-existent, permission denied, etc.) are
/// silently skipped — a stale path shouldn't prevent watching the rest.
pub fn set_watch_paths(app: AppHandle, paths: Vec<PathBuf>) -> Result<(), String> {
    // Drop the old watcher FIRST, outside the channel setup, so its
    // background thread shuts down before we allocate the new one.
    {
        let mut guard = WATCHER.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    if paths.is_empty() {
        return Ok(());
    }

    let app_handle = app.clone();
    // Per-path timestamp of the last emitted `fs-changed`, owned by the
    // watcher callback closure (notify invokes it from a single
    // background thread, so a plain HashMap behind the closure's `mut`
    // capture is enough — no extra synchronization needed).
    let mut last_emit: HashMap<PathBuf, Instant> = HashMap::new();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                // Only forward events that actually represent a change. We
                // skip Access events (read-only probes, cache stats) because
                // they'd cause spurious reloads on every hover/indexer pass.
                let relevant = matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                );
                if !relevant {
                    return;
                }
                let now = Instant::now();
                for path in event.paths {
                    // Leading-edge coalesce: emit the first event for a
                    // path immediately, then drop the burst that follows
                    // it until the quiet window elapses.
                    if !should_emit(&mut last_emit, &path, now, COALESCE_WINDOW) {
                        continue;
                    }
                    let s = path.to_string_lossy().into_owned();
                    let _ = app_handle.emit("fs-changed", s);
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    for path in &paths {
        // Recursive is harmless on files (notify will treat a file path as a
        // single entry) and is what we want for folders.
        let _ = watcher.watch(path, RecursiveMode::Recursive);
    }

    let mut guard = WATCHER.lock().map_err(|e| e.to_string())?;
    *guard = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_event_for_a_path_is_emitted() {
        let mut last = HashMap::new();
        let now = Instant::now();
        assert!(should_emit(
            &mut last,
            Path::new("/a.md"),
            now,
            COALESCE_WINDOW
        ));
    }

    #[test]
    fn burst_within_window_is_dropped() {
        let mut last = HashMap::new();
        let t0 = Instant::now();
        let p = Path::new("/a.md");
        assert!(should_emit(&mut last, p, t0, COALESCE_WINDOW));
        // Two more events 10ms and 50ms later — both inside the window.
        assert!(!should_emit(
            &mut last,
            p,
            t0 + Duration::from_millis(10),
            COALESCE_WINDOW
        ));
        assert!(!should_emit(
            &mut last,
            p,
            t0 + Duration::from_millis(50),
            COALESCE_WINDOW
        ));
    }

    #[test]
    fn event_after_window_is_emitted_again() {
        let mut last = HashMap::new();
        let t0 = Instant::now();
        let p = Path::new("/a.md");
        assert!(should_emit(&mut last, p, t0, COALESCE_WINDOW));
        // Past the quiet window — a genuinely new change should get through.
        assert!(should_emit(
            &mut last,
            p,
            t0 + COALESCE_WINDOW + Duration::from_millis(1),
            COALESCE_WINDOW,
        ));
    }

    #[test]
    fn tracked_paths_stay_bounded() {
        // A storm of distinct paths must not grow the map without bound:
        // once it crosses MAX_TRACKED_PATHS the map is cleared, so its
        // size never exceeds the cap.
        let mut last = HashMap::new();
        let now = Instant::now();
        for i in 0..(MAX_TRACKED_PATHS * 3) {
            let p = PathBuf::from(format!("/file-{i}.md"));
            assert!(should_emit(&mut last, &p, now, COALESCE_WINDOW));
            assert!(
                last.len() <= MAX_TRACKED_PATHS,
                "map exceeded cap: {}",
                last.len()
            );
        }
    }

    #[test]
    fn distinct_paths_are_coalesced_independently() {
        let mut last = HashMap::new();
        let t0 = Instant::now();
        // A storm touching many distinct paths still emits one per path —
        // the coalesce is per-path, not global.
        assert!(should_emit(
            &mut last,
            Path::new("/a.md"),
            t0,
            COALESCE_WINDOW
        ));
        assert!(should_emit(
            &mut last,
            Path::new("/b.md"),
            t0,
            COALESCE_WINDOW
        ));
        // ...but a second hit on /a.md within the window is still dropped.
        assert!(!should_emit(
            &mut last,
            Path::new("/a.md"),
            t0 + Duration::from_millis(5),
            COALESCE_WINDOW,
        ));
    }
}
