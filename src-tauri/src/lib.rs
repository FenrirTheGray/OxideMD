mod commands;
mod config;
mod errorlog;
mod highlight;
mod markdown;
mod util;
mod watcher;

use crate::config::project_dirs;
use std::fs;
use std::path::PathBuf;
use tauri::Emitter;
use tauri::Manager;

/// File where the currently-running instance stamps its version. A
/// freshly-launched second instance writes to this file *before*
/// `tauri_plugin_single_instance` bounces it; the surviving original
/// instance reads it in the single-instance callback to detect an
/// in-place upgrade. Lives under the app data dir so it shares the
/// blast radius of `--reset-all`.
const RUNNING_VERSION_FILE: &str = ".running_version";

fn running_version_path() -> Option<PathBuf> {
    project_dirs().map(|d| d.data_dir().join(RUNNING_VERSION_FILE))
}

fn write_running_version() {
    let Some(path) = running_version_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, env!("CARGO_PKG_VERSION"));
}

/// Wipes every OxideMD-owned directory on disk: config (settings,
/// custom themes, fonts), data (webview storage including drafts,
/// `.running_version`), and cache. Returns the paths that actually
/// existed and were removed. Invoked by the `--reset-all --yes` CLI
/// flag handled in `maybe_handle_reset_all`.
fn perform_reset_all() -> Result<Vec<PathBuf>, String> {
    let mut wiped = Vec::new();
    let Some(dirs) = project_dirs() else {
        return Err("Could not resolve OxideMD directories".into());
    };
    for dir in [dirs.config_dir(), dirs.data_dir(), dirs.cache_dir()] {
        if dir.exists() {
            fs::remove_dir_all(dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
            wiped.push(dir.to_path_buf());
        }
    }
    Ok(wiped)
}

/// Handles `--reset-all` early so the wipe happens before any plugin
/// (notably the file watcher and log file) opens handles on the
/// soon-to-be-deleted directories. Requires `--yes` (or `-y`) as a
/// second arg to actually perform the destructive action — bare
/// `--reset-all` prints a description and asks for explicit
/// confirmation, matching how `rm -rf`-shaped commands usually behave.
/// Returns `true` if the flag was present (caller should exit).
fn maybe_handle_reset_all() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.iter().any(|a| a == "--reset-all") {
        return false;
    }
    let confirmed = args.iter().any(|a| a == "--yes" || a == "-y");
    if !confirmed {
        eprintln!("--reset-all permanently deletes:");
        eprintln!("  • Config (settings, keybindings, custom themes, custom fonts, recents)");
        eprintln!("  • Webview data (drafts, cached state)");
        eprintln!("  • Logs and caches");
        eprintln!();
        eprintln!("Re-run with `oxidemd --reset-all --yes` to confirm.");
        return true;
    }
    match perform_reset_all() {
        Ok(paths) if paths.is_empty() => {
            eprintln!("Nothing to reset — no OxideMD state on disk.");
        }
        Ok(paths) => {
            eprintln!("Reset complete. Removed:");
            for p in paths {
                eprintln!("  {}", p.display());
            }
        }
        Err(e) => eprintln!("Reset failed: {}", e),
    }
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMABUF renderer commits buffers without an explicit-sync
    // acquire timeline point, which wlroots compositors (Hyprland, Sway)
    // reject with a `wp_linux_drm_syncobj_surface_v1` "Missing acquire
    // timeline" protocol error — the window dies at startup with
    // `Gdk-Message: Error 71 (Protocol error)`. Disable that renderer on
    // Wayland so the window comes up. Honor an existing override and leave
    // X11/XWayland sessions (where the path works) untouched.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_some()
            && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    if maybe_handle_reset_all() {
        return;
    }
    // Stamp our version into the data dir *before* the single-instance
    // plugin runs; if we're about to be bounced as a second instance
    // the surviving original picks this up in its callback below and
    // toasts the user that an update is sitting on disk.
    write_running_version();

    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // Re-focus the existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // Forward every file path the second instance was launched with
            // (Explorer "Open with" can pass multiple files in a single argv).
            // Canonicalize against the *second instance's* CWD — by the time
            // the main instance's `open_file` runs, its own CWD is unrelated
            // to where the user launched the second instance from, so a
            // bare relative path like `./notes.md` wouldn't resolve.
            let cwd_path = std::path::PathBuf::from(&cwd);
            let files: Vec<String> = argv
                .iter()
                .skip(1)
                .map(|arg| {
                    let p = std::path::Path::new(arg);
                    let absolute = if p.is_absolute() {
                        p.to_path_buf()
                    } else {
                        cwd_path.join(p)
                    };
                    let canonical = std::fs::canonicalize(&absolute).unwrap_or(absolute);
                    let canonical = commands::strip_windows_verbatim(canonical);
                    canonical.to_string_lossy().into_owned()
                })
                .collect();
            if !files.is_empty() {
                let _ = app.emit("open-files-from-instance", files);
            }

            // The second instance wrote its own version to
            // `.running_version` before being bounced here. If it
            // differs from ours, the user has installed a new build
            // but is still running the old one — toast them to
            // relaunch (the frontend listens for this event).
            if let Some(path) = running_version_path() {
                if let Ok(written) = fs::read_to_string(&path) {
                    let written = written.trim();
                    if !written.is_empty() && written != env!("CARGO_PKG_VERSION") {
                        let _ = app.emit("version-mismatch", written.to_string());
                    }
                }
            }
        }));
    }

    // Diagnostic log: one date-stamped file per launch, written to the
    // OS-appropriate app log dir (XDG state on Linux, %LOCALAPPDATA% on
    // Windows, ~/Library/Logs on macOS — surfaced in Settings → About).
    // Rotation is by size as a safety net; KeepAll preserves history so
    // we can ask users to attach the relevant day. Stdout target is gated
    // to debug builds so release binaries don't spam the user's terminal.
    let log_file_name = format!("OxideMD-{}", chrono::Local::now().format("%Y-%m-%d"));
    // `mut` is only needed when the stdout target is conditionally
    // pushed below; in release builds that branch is stripped, so we
    // explicitly allow the otherwise-unused `mut` to keep CI clean.
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut log_targets = vec![tauri_plugin_log::Target::new(
        tauri_plugin_log::TargetKind::LogDir {
            file_name: Some(log_file_name),
        },
    )];
    #[cfg(debug_assertions)]
    log_targets.push(tauri_plugin_log::Target::new(
        tauri_plugin_log::TargetKind::Stdout,
    ));
    let log_plugin = tauri_plugin_log::Builder::new()
        .targets(log_targets)
        .level(if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        })
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .max_file_size(5_000_000)
        .build();

    builder
        .plugin(log_plugin)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::save_file,
            commands::render_preview,
            commands::get_cli_files,
            commands::pick_file,
            commands::save_new_file,
            commands::delete_path,
            commands::pick_folder,
            commands::read_folder_tree,
            commands::search_project,
            commands::resolve_md_path,
            commands::get_config,
            commands::get_default_config,
            commands::save_config_cmd,
            commands::open_url,
            commands::install_font,
            commands::remove_font,
            commands::list_custom_fonts,
            commands::get_font_data,
            commands::watch_paths,
            commands::check_for_updates,
            commands::download_and_install_update,
            commands::list_recent_files,
            commands::mark_recent_file,
            commands::forget_recent_file,
            commands::clear_recent_files,
            commands::file_sha256,
            commands::write_draft,
            commands::read_draft,
            commands::clear_draft,
            commands::write_pasted_image,
            commands::import_dropped_image,
            commands::export_html,
            commands::pick_export_path,
            commands::export_theme,
            commands::import_theme,
            commands::save_custom_theme,
            commands::list_custom_themes,
            commands::list_builtin_themes,
            commands::delete_custom_theme,
            errorlog::append_error_log,
        ])
        .setup(|_app| {
            // Load the syntect syntax/theme definitions off the critical
            // path so the first code-block render doesn't stall on them.
            std::thread::spawn(crate::markdown::warm_highlighter);
            let cfg = config::load_config();
            // Seed the renderer's soft-break mode from saved config so
            // files opened on launch render with the right setting.
            crate::markdown::PRESERVE_LINE_BREAKS.store(
                cfg.preserve_line_breaks,
                std::sync::atomic::Ordering::Relaxed,
            );
            // Window opens at the configured default size, centered,
            // every launch — see tauri.conf.json. We deliberately do
            // not persist size/maximize state: prior attempts mixed
            // physical vs logical pixels and on HiDPI Windows each
            // cycle inflated the window beyond the screen, and even
            // the monitor-clamped restore in 4.0.1 still relied on
            // stale dimensions that no longer matched the user's
            // current setup.
            // Some key combos (Ctrl+Shift+Tab, etc.) are swallowed by
            // WebKitGTK before JS can see them. Intercept at the GTK
            // window level so we handle them before the webview does.
            #[cfg(target_os = "linux")]
            {
                let handle = _app.handle().clone();
                if let Some(window) = _app.get_webview_window("main") {
                    window.with_webview(move |webview| {
                        use gdk::keys::constants;
                        use gtk::prelude::*;

                        let wv = webview.inner();
                        let wv_widget: &gtk::Widget = wv.as_ref();
                        if let Some(toplevel) = wv_widget.toplevel() {
                            if let Ok(gtk_window) = toplevel.downcast::<gtk::Window>() {
                                gtk_window.connect_key_press_event(move |_, event| {
                                    let state = event.state();
                                    let ctrl = state.contains(gdk::ModifierType::CONTROL_MASK);
                                    let shift = state.contains(gdk::ModifierType::SHIFT_MASK);

                                    if ctrl {
                                        let keyval = event.keyval();
                                        if shift {
                                            if keyval == constants::ISO_Left_Tab
                                                || keyval == constants::Tab
                                            {
                                                let _ = handle.emit("prev-tab", ());
                                                return gtk::glib::Propagation::Stop;
                                            }
                                            if keyval == constants::Left {
                                                let _ = handle.emit("move-tab-left", ());
                                                return gtk::glib::Propagation::Stop;
                                            }
                                            if keyval == constants::Right {
                                                let _ = handle.emit("move-tab-right", ());
                                                return gtk::glib::Propagation::Stop;
                                            }
                                        } else if keyval == constants::Tab {
                                            let _ = handle.emit("next-tab", ());
                                            return gtk::glib::Propagation::Stop;
                                        }
                                    }

                                    gtk::glib::Propagation::Proceed
                                });
                            }
                        }
                    })?;
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OxideMD");
}
