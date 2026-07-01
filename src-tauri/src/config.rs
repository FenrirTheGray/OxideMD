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
    // Sparse overrides for the app's base UI palette, keyed by the CSS
    // custom-property name without the leading `--` (e.g. "bg",
    // "bg-toolbar", "fg-dim"). Missing entries fall back to the
    // theme-dark / theme-light defaults in style.css, so existing
    // configs (and the built-in themes) are unchanged. Populated when
    // the user customizes Interface colors or imports a full theme.
    pub palette: HashMap<String, String>,
    // Filename of the custom theme last applied via the Settings dropdown,
    // or "__default__" for the built-in palette reset. Empty when the user
    // hasn't picked a saved theme (or has modified colors since). Purely a
    // UI hint so the dropdown can show the active theme label across
    // restarts — color state lives in the fields above and `palette`.
    pub custom_theme: String,
    pub toolbar_compact: bool,
    pub printer_friendly: bool,
    // Whether the welcome screen surfaces the Recent files list. Off
    // hides the panel entirely; entries still accrue in `recent_files`
    // and the File menu picks them up so toggling back on restores them.
    pub show_recent_files: bool,
    pub preserve_line_breaks: bool,
    // Whether images with http(s) / protocol-relative URLs are loaded in
    // rendered documents. Off by default: an untrusted .md could otherwise
    // phone home to an arbitrary host on open (a tracking-pixel / IP-leak
    // vector). The Rust renderer always emits remote images as inert
    // `data-oxide-remote-src`; the frontend only promotes them to a live
    // `src` when this is on. Local and `data:` images are unaffected.
    pub load_remote_images: bool,
    pub sidebar_width: u32,
    // Whether the right-side document outline sidebar is shown. Toggled
    // by the toolbar's outline button in read mode; persisted so the
    // layout choice survives a restart, mirroring sidebar_width.
    pub outline_visible: bool,
    // Sparse overrides keyed by action id (e.g. "save" → "Mod+S").
    // Missing entries fall back to the frontend's default registry, so
    // new actions shipped in updates auto-apply without rewriting config.
    pub keybindings: HashMap<String, String>,
    pub editor_word_wrap: bool,
    pub editor_spell_check: bool,
    pub editor_line_numbers: bool,
    // Format the buffer on every save: trim trailing whitespace
    // (preserving Markdown hard-break two-space syntax) and collapse to
    // a single trailing newline. Off by default — opt-in to keep saves
    // byte-for-byte for users with strict version control diffs.
    pub editor_format_on_save: bool,
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

// Reverse-DNS triple fed to `directories::ProjectDirs`. Single source
// of truth for every OxideMD-owned path on disk so a future rebrand or
// identifier change is a one-line edit. The display-form `APP_NAME`
// surfaces on macOS (`~/Library/Application Support/com.oxidemd.OxideMD`)
// and Windows (`%APPDATA%\oxidemd\OxideMD\config`); the `directories`
// crate lowercases it to `oxidemd` on Linux (`~/.config/oxidemd`).
pub const APP_QUALIFIER: &str = "com";
pub const APP_ORGANIZATION: &str = "oxidemd";
pub const APP_NAME: &str = "OxideMD";

/// Resolves the OS-appropriate config / data / cache directories for
/// OxideMD. Returns `None` only when the OS won't tell us a home
/// directory (e.g. extremely locked-down Linux containers); callers
/// fall back to in-memory defaults in that case.
pub fn project_dirs() -> Option<ProjectDirs> {
    ProjectDirs::from(APP_QUALIFIER, APP_ORGANIZATION, APP_NAME)
}

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
            palette: HashMap::new(),
            custom_theme: String::new(),
            toolbar_compact: false,
            printer_friendly: true,
            show_recent_files: true,
            preserve_line_breaks: false,
            load_remote_images: false,
            sidebar_width: 240,
            outline_visible: false,
            keybindings: HashMap::new(),
            editor_word_wrap: true,
            editor_spell_check: false,
            editor_line_numbers: true,
            editor_format_on_save: false,
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
    project_dirs().map(|dirs| dirs.config_dir().join("config.toml"))
}

pub fn fonts_dir() -> Option<PathBuf> {
    project_dirs().map(|dirs| dirs.config_dir().join("fonts"))
}

pub fn themes_dir() -> Option<PathBuf> {
    project_dirs().map(|dirs| dirs.config_dir().join("themes"))
}

/// Directory for the daily error logs, alongside `config.toml`, `fonts/`,
/// and `themes/`. The error-log writer creates it on demand.
pub fn error_log_dir() -> Option<PathBuf> {
    project_dirs().map(|dirs| dirs.config_dir().join("error-log"))
}

/// Directory for per-file edit drafts (crash recovery). Lives under the OS
/// cache dir rather than the config dir — drafts are regenerable scratch
/// data, not user settings. The draft commands create it on demand.
pub fn drafts_dir() -> Option<PathBuf> {
    project_dirs().map(|dirs| dirs.cache_dir().join("drafts"))
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
    let config: Config = match toml::from_str(&content) {
        Ok(c) => c,
        Err(e) => {
            // The file exists but won't parse. Defaulting here is fine, but
            // the next `save_config` would overwrite it and silently lose
            // whatever the user had. Move the unparseable file aside as a
            // `.corrupt` backup first so it stays recoverable. Best-effort:
            // a failed backup still falls back to defaults.
            let warning = format!(
                "config at {} is unparseable ({e}); backing up and using defaults",
                path.display()
            );
            log::warn!("{warning}");
            crate::errorlog::append_error_line(&format!("[config] {warning}"));
            let mut backup = path.clone().into_os_string();
            backup.push(".corrupt");
            let _ = fs::rename(&path, PathBuf::from(backup));
            return Config::default();
        }
    };
    config
}

pub fn save_config(config: &Config) -> Result<(), String> {
    let path = config_path().ok_or("Could not determine config path")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = toml::to_string_pretty(config).map_err(|e| e.to_string())?;
    // Write to a sibling temp file then rename over the target, so a crash
    // mid-write can't truncate the existing config into a half-written,
    // unparseable state. `fs::rename` replaces an existing file atomically
    // on every platform we ship (POSIX rename; Windows MoveFileEx with
    // replace semantics) as long as both paths share a directory — they do.
    let mut tmp = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_replaces_existing_target() {
        // `save_config`'s atomicity relies on `fs::rename` overwriting an
        // existing file. That holds on POSIX but Windows has historically
        // been fussy, so pin the behavior down on whatever platform CI runs.
        let dir = std::env::temp_dir().join(format!(
            "oxidemd-cfg-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("config.toml");
        let tmp = dir.join("config.toml.tmp");
        fs::write(&target, "old").unwrap();
        fs::write(&tmp, "new").unwrap();

        fs::rename(&tmp, &target).expect("rename over existing target must succeed");
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert!(!tmp.exists(), "temp file should be gone after rename");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn config_round_trips_through_toml() {
        // A default config must serialize and parse back identically — the
        // load path now treats a parse failure as corruption, so a silent
        // serialize/parse drift would wrongly trip the backup branch.
        let cfg = Config::default();
        let s = toml::to_string_pretty(&cfg).unwrap();
        let parsed: Config = toml::from_str(&s).unwrap();
        assert_eq!(parsed.md_extensions, cfg.md_extensions);
        assert_eq!(parsed.theme, cfg.theme);
    }
}
