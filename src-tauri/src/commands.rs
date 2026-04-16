use crate::config::{fonts_dir, load_config, save_config, Config};
use crate::markdown;
use base64::Engine;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

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
pub fn get_default_config() -> Config {
    Config::default()
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
pub struct FontInfo {
    pub name: String,
    pub filename: String,
}

#[tauri::command]
pub async fn install_font(app: tauri::AppHandle) -> Result<Option<FontInfo>, String> {
    let window = app.get_webview_window("main").unwrap();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter("Font Files", &["ttf", "otf", "woff", "woff2"])
            .blocking_pick_file()
            .map(|p| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    let src_path = match picked {
        Some(p) => p,
        None => return Ok(None),
    };

    let dir = fonts_dir().ok_or("Could not determine fonts directory")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let src = PathBuf::from(&src_path);
    let filename = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid font filename")?
        .to_string();
    let dest = dir.join(&filename);
    fs::copy(&src, &dest).map_err(|e| format!("Failed to copy font: {e}"))?;

    let name = src
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or(&filename)
        .to_string();

    Ok(Some(FontInfo { name, filename }))
}

#[tauri::command]
pub fn remove_font(filename: String) -> Result<(), String> {
    let dir = fonts_dir().ok_or("Could not determine fonts directory")?;
    let path = dir.join(&filename);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to remove font: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_custom_fonts() -> Vec<FontInfo> {
    let dir = match fonts_dir() {
        Some(d) => d,
        None => return vec![],
    };
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let extensions = ["ttf", "otf", "woff", "woff2"];
    let mut fonts = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if extensions.contains(&ext.to_lowercase().as_str()) {
                let filename = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string();
                let name = path
                    .file_stem()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&filename)
                    .to_string();
                fonts.push(FontInfo { name, filename });
            }
        }
    }
    fonts.sort_by(|a, b| a.name.cmp(&b.name));
    fonts
}

#[tauri::command]
pub async fn get_font_data(filename: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = fonts_dir().ok_or("Could not determine fonts directory")?;
        let path = dir.join(&filename);
        let bytes = fs::read(&path).map_err(|e| format!("Failed to read font: {e}"))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct OpenResult {
    pub html: String,
    pub title: String,
}

#[derive(serde::Serialize)]
pub struct UpdateResult {
    pub available: bool,
    pub version: String,
    pub body: String,
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateResult, String> {
    let updater = app
        .updater_builder()
        .build()
        .map_err(|e: tauri_plugin_updater::Error| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateResult {
            available: true,
            version: update.version.clone(),
            body: update.body.clone().unwrap_or_default(),
        }),
        Ok(None) => Ok(UpdateResult {
            available: false,
            version: String::new(),
            body: String::new(),
        }),
        Err(e) => Err(format!("{e}")),
    }
}
