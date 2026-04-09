mod commands;
mod config;
mod highlight;
mod markdown;
mod util;

use tauri::Manager;

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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OxideMD");
}
