//! File-system watcher for the currently open file(s) and folder.
//!
//! We keep a single recursive `RecommendedWatcher` behind a mutex. When the
//! frontend calls `set_watch_paths`, the previous watcher is dropped and a
//! new one is created with just the caller's paths. Events from the OS are
//! emitted to the webview as the `fs-changed` event carrying the path that
//! changed. Debouncing is left to the frontend (many editors produce a
//! burst of events per save and the right wait time depends on how the UI
//! wants to react).

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

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
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                // Only forward events that actually represent a change. We
                // skip Access events (read-only probes, cache stats) because
                // they'd cause spurious reloads on every hover/indexer pass.
                let relevant = matches!(
                    event.kind,
                    EventKind::Create(_)
                        | EventKind::Modify(_)
                        | EventKind::Remove(_)
                );
                if !relevant {
                    return;
                }
                for path in event.paths {
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
