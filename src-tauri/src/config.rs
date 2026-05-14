use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub theme: String,
    pub font_family: String,
    pub font_size: u32,
    pub line_height: f32,
    pub reading_width: u32,
    pub h1_color: String,
    pub h2_color: String,
    pub h3_color: String,
    pub bullet_color: String,
    pub code_bg_color: String,
    pub code_accent_color: String,
    pub note_bg_color: String,
    pub note_accent_color: String,
    pub toolbar_compact: bool,
    pub printer_friendly: bool,
    pub preserve_line_breaks: bool,
    pub sidebar_width: u32,
    pub window_width: u32,
    pub window_height: u32,
    pub window_maximized: bool,
    // Sparse overrides keyed by action id (e.g. "save" → "Mod+S").
    // Missing entries fall back to the frontend's default registry, so
    // new actions shipped in updates auto-apply without rewriting config.
    pub keybindings: HashMap<String, String>,
    pub editor_word_wrap: bool,
    pub editor_spell_check: bool,
    // File extensions (lowercased, no leading dot) the folder browser
    // treats as Markdown. Normalized on save by the frontend; an empty
    // list falls back to MD_EXTS_DEFAULT at the read sites.
    pub md_extensions: Vec<String>,
    // Most-recently-opened files, newest first. Capped at RECENT_FILES_LIMIT
    // entries by add_recent_file. Surfaced on the welcome screen.
    pub recent_files: Vec<String>,
}

pub const RECENT_FILES_LIMIT: usize = 12;

// Canonical default set of Markdown file extensions. Referenced by
// `Config::default` so the shipped default can't drift from this list.
pub const MD_EXTS_DEFAULT: &[&str] = &["md", "markdown", "mdown", "mkd"];

impl Default for Config {
    fn default() -> Self {
        Config {
            theme: "dark".into(),
            font_family: "system-ui".into(),
            font_size: 16,
            line_height: 1.8,
            reading_width: 800,
            h1_color: "#c084fc".into(),
            h2_color: "#67e8f9".into(),
            h3_color: "#fbbf24".into(),
            bullet_color: "#8b5cf6".into(),
            code_bg_color: "#1e2127".into(),
            code_accent_color: "#61afef".into(),
            note_bg_color: "#2a2f3a".into(),
            note_accent_color: "#c678dd".into(),
            toolbar_compact: false,
            printer_friendly: true,
            preserve_line_breaks: false,
            sidebar_width: 240,
            window_width: 600,
            window_height: 700,
            window_maximized: false,
            keybindings: HashMap::new(),
            editor_word_wrap: true,
            editor_spell_check: false,
            md_extensions: MD_EXTS_DEFAULT.iter().map(|e| e.to_string()).collect(),
            recent_files: Vec::new(),
        }
    }
}

pub fn add_recent_file(config: &mut Config, path: &str) {
    config.recent_files.retain(|p| p != path);
    config.recent_files.insert(0, path.to_string());
    if config.recent_files.len() > RECENT_FILES_LIMIT {
        config.recent_files.truncate(RECENT_FILES_LIMIT);
    }
}

fn config_path() -> Option<PathBuf> {
    ProjectDirs::from("com", "oxidemd", "OxideMD")
        .map(|dirs| dirs.config_dir().join("config.toml"))
}

pub fn fonts_dir() -> Option<PathBuf> {
    ProjectDirs::from("com", "oxidemd", "OxideMD")
        .map(|dirs| dirs.config_dir().join("fonts"))
}

pub fn load_config() -> Config {
    let path = match config_path() {
        Some(p) => p,
        None => return Config::default(),
    };
    let content = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Config::default(),
    };
    toml::from_str(&content).unwrap_or_default()
}

pub fn save_config(config: &Config) -> Result<(), String> {
    let path = config_path().ok_or("Could not determine config path")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = toml::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}
