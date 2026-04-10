mod commands;
mod config;
mod highlight;
mod markdown;
mod util;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::get_cli_file,
            commands::pick_file,
            commands::get_config,
            commands::save_config_cmd,
            commands::save_window_geometry,
            commands::open_url,
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

                                    if ctrl && shift {
                                        let keyval = event.keyval();
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
