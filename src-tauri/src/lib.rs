mod commands;
mod config;
mod highlight;
mod markdown;
mod util;
mod watcher;

use tauri::Emitter;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::save_file,
            commands::render_preview,
            commands::get_cli_files,
            commands::pick_file,
            commands::pick_folder,
            commands::read_folder_tree,
            commands::resolve_md_path,
            commands::get_config,
            commands::get_default_config,
            commands::save_config_cmd,
            commands::save_window_geometry,
            commands::open_url,
            commands::install_font,
            commands::remove_font,
            commands::list_custom_fonts,
            commands::get_font_data,
            commands::watch_paths,
            commands::check_for_updates,
        ])
        .setup(|app| {
            // Restore saved window geometry
            let cfg = config::load_config();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_size(tauri::LogicalSize::new(
                    cfg.window_width as f64,
                    cfg.window_height as f64,
                ));
                if cfg.window_maximized {
                    let _ = window.maximize();
                }
            }
            // Some key combos (Ctrl+Shift+Tab, etc.) are swallowed by
            // WebKitGTK before JS can see them. Intercept at the GTK
            // window level so we handle them before the webview does.
            #[cfg(target_os = "linux")]
            {
                let handle = app.handle().clone();
                if let Some(window) = app.get_webview_window("main") {
                    window.with_webview(move |webview| {
                        use gtk::prelude::*;
                        use gdk::keys::constants;

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
