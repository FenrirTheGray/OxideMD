use crate::config::{load_config, save_config, Config};
use crate::markdown;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn open_file(path: String) -> Result<OpenResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&path);
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let base_dir = path.parent();
        let html = markdown::render(&content, base_dir);
        let title = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("OxideMD")
            .to_string();
        Ok(OpenResult { html, title })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns the first CLI argument (i.e. a file path to open), if provided.
#[tauri::command]
pub fn get_cli_file() -> Option<String> {
    std::env::args().nth(1)
}

#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle) -> Vec<String> {
    let window = app.get_webview_window("main").unwrap();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
            .add_filter("All Files", &["*"])
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string())
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub fn get_config() -> Config {
    load_config()
}

#[tauri::command]
pub fn save_config_cmd(config: Config) -> Result<(), String> {
    save_config(&config)
}

#[tauri::command]
pub fn save_window_geometry(width: u32, height: u32, maximized: bool) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.window_width = width;
    cfg.window_height = height;
    cfg.window_maximized = maximized;
    save_config(&cfg)
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open::that(&url).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct OpenResult {
    pub html: String,
    pub title: String,
}
