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
        let raw = PathBuf::from(&path);
        let content = fs::read_to_string(&raw).map_err(|e| e.to_string())?;
        // Canonicalize so callers always receive the same path string for
        // the same file, regardless of how it was first referenced (tree
        // entry, link, drop, CLI). This is the dedup key for tabs.
        let canonical = fs::canonicalize(&raw).unwrap_or(raw);
        let canonical = strip_windows_verbatim(canonical);
        let base_dir = canonical.parent();
        let html = markdown::render(&content, base_dir);
        let title = canonical
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("OxideMD")
            .to_string();
        Ok(OpenResult {
            html,
            title,
            path: canonical.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns every CLI argument that looks like a file path to open
/// (everything after argv\[0\]). The OS may pass several .md files via
/// "Open with…", so we forward all of them.
#[tauri::command]
pub fn get_cli_files() -> Vec<String> {
    std::env::args().skip(1).collect()
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

#[derive(serde::Serialize)]
pub struct FolderTree {
    pub root: String,
    pub name: String,
    pub entries: Vec<TreeNode>,
    /// True if the walk hit a depth or entry cap and the tree is
    /// incomplete. The sidebar uses this to show a "truncated" hint
    /// so a monster repo doesn't silently look like an empty folder.
    pub truncated: bool,
}

// Bounds on the folder walk. We pick numbers big enough that ordinary
// docs folders are never hit, and small enough that someone pointing
// at `C:\` doesn't take the process down.
const WALK_MAX_DEPTH: usize = 12;
const WALK_MAX_ENTRIES_PER_DIR: usize = 500;
const WALK_MAX_TOTAL_ENTRIES: usize = 5000;

struct WalkCtx {
    total: usize,
    truncated: bool,
}

#[derive(serde::Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

const MD_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd"];

fn is_md_file(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Walks `dir` and returns its entries. Folders are kept only if they
/// (or one of their descendants) contain a markdown file. Hidden entries
/// (names starting with '.') are skipped. Bounded by WALK_MAX_DEPTH,
/// WALK_MAX_ENTRIES_PER_DIR and WALK_MAX_TOTAL_ENTRIES — crossing any
/// limit sets `ctx.truncated = true` so the UI can warn the user.
fn walk_dir(dir: &std::path::Path, depth: usize, ctx: &mut WalkCtx) -> Vec<TreeNode> {
    let mut nodes: Vec<TreeNode> = Vec::new();
    if depth >= WALK_MAX_DEPTH {
        ctx.truncated = true;
        return nodes;
    }
    if ctx.total >= WALK_MAX_TOTAL_ENTRIES {
        ctx.truncated = true;
        return nodes;
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return nodes,
    };
    let mut per_dir: usize = 0;
    for entry in read.flatten() {
        if per_dir >= WALK_MAX_ENTRIES_PER_DIR {
            ctx.truncated = true;
            break;
        }
        if ctx.total >= WALK_MAX_TOTAL_ENTRIES {
            ctx.truncated = true;
            break;
        }
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            let children = walk_dir(&path, depth + 1, ctx);
            if !children.is_empty() {
                nodes.push(TreeNode {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    is_dir: true,
                    children,
                });
                ctx.total += 1;
                per_dir += 1;
            }
        } else if ft.is_file() && is_md_file(&path) {
            nodes.push(TreeNode {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: false,
                children: Vec::new(),
            });
            ctx.total += 1;
            per_dir += 1;
        }
    }
    // Folders first, then files, each group alphabetical (case-insensitive).
    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    nodes
}

fn build_folder_tree(root: &std::path::Path) -> FolderTree {
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_else(|| root.to_str().unwrap_or(""))
        .to_string();
    let mut ctx = WalkCtx { total: 0, truncated: false };
    let entries = walk_dir(root, 0, &mut ctx);
    FolderTree {
        root: root.to_string_lossy().into_owned(),
        name,
        entries,
        truncated: ctx.truncated,
    }
}

#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Option<FolderTree> {
    let window = app.get_webview_window("main").unwrap();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_folder()
            .map(|p| p.to_string())
    })
    .await
    .ok()
    .flatten()?;

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(picked);
        Some(build_folder_tree(&path))
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn read_folder_tree(path: String) -> Result<FolderTree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.is_dir() {
            return Err(format!("Not a directory: {path}"));
        }
        Ok(build_folder_tree(&p))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn strip_windows_verbatim(p: PathBuf) -> PathBuf {
    if cfg!(windows) {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    p
}

/// Decodes an md link href into its path portion if the link should be
/// treated as a potential local .md target. Returns `None` for remote URLs,
/// fragment-only links, non-markdown extensions, or anything we won't
/// resolve locally. Pure function — no filesystem access.
fn md_href_to_decoded_path(href: &str) -> Option<String> {
    if href.is_empty() || href.starts_with('#') {
        return None;
    }
    let lower = href.to_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with("data:")
        || lower.starts_with("javascript:")
        || lower.starts_with("//")
    {
        return None;
    }
    let mut target = href;
    if let Some(idx) = target.find('#') {
        target = &target[..idx];
    }
    if let Some(idx) = target.find('?') {
        target = &target[..idx];
    }
    if target.is_empty() {
        return None;
    }
    let decoded = percent_decode(target);
    if !is_md_file(std::path::Path::new(&decoded)) {
        return None;
    }
    Some(decoded)
}

/// Resolves a markdown link (`href`) against the file currently being viewed
/// (`base`, the absolute path of that file). Returns the absolute path of the
/// linked .md file when it exists locally; returns `None` for remote URLs,
/// non-markdown targets, or anything that can't be resolved.
#[tauri::command]
pub async fn resolve_md_path(base: String, href: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let decoded = md_href_to_decoded_path(&href)?;
        let candidate = std::path::Path::new(&decoded);
        let resolved = if candidate.is_absolute() {
            PathBuf::from(&decoded)
        } else {
            let base_path = PathBuf::from(&base);
            let parent = base_path.parent()?;
            parent.join(&decoded)
        };
        let canonical = fs::canonicalize(&resolved).ok()?;
        let canonical = strip_windows_verbatim(canonical);
        Some(canonical.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
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

/// Returns true if `url` uses a scheme we're willing to hand off to the
/// OS `open` handler. We restrict to http/https/mailto to avoid turning
/// link clicks into arbitrary-command execution (`javascript:`, shell
/// URI handlers, etc.) or local-file access escalation (`file:`).
fn is_allowed_open_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !is_allowed_open_url(&url) {
        return Err("Refusing to open URL: scheme not allowed".to_string());
    }
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
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_basic_space() {
        assert_eq!(percent_decode("a%20b"), "a b");
    }

    #[test]
    fn percent_decode_leaves_unencoded_text() {
        assert_eq!(percent_decode("plain text"), "plain text");
    }

    #[test]
    fn percent_decode_ignores_malformed_trailing_percent() {
        assert_eq!(percent_decode("abc%"), "abc%");
        assert_eq!(percent_decode("abc%2"), "abc%2");
        assert_eq!(percent_decode("abc%zz"), "abc%zz");
    }

    #[test]
    fn percent_decode_handles_percent_at_end_of_string() {
        // "%2F" fully fits in the buffer.
        assert_eq!(percent_decode("a%2F"), "a/");
    }

    #[test]
    fn percent_decode_handles_multiple_sequences() {
        assert_eq!(percent_decode("%2Fa%20b%2Fc"), "/a b/c");
    }

    #[test]
    fn is_md_file_checks_extension_case_insensitively() {
        assert!(is_md_file(std::path::Path::new("a.md")));
        assert!(is_md_file(std::path::Path::new("a.MD")));
        assert!(is_md_file(std::path::Path::new("a.markdown")));
        assert!(is_md_file(std::path::Path::new("a.MDown")));
        assert!(is_md_file(std::path::Path::new("a.mkd")));
        assert!(!is_md_file(std::path::Path::new("a.txt")));
        assert!(!is_md_file(std::path::Path::new("a")));
    }

    #[test]
    fn md_href_filter_rejects_empty_and_fragments() {
        assert!(md_href_to_decoded_path("").is_none());
        assert!(md_href_to_decoded_path("#anchor").is_none());
    }

    #[test]
    fn md_href_filter_rejects_remote_schemes() {
        assert!(md_href_to_decoded_path("http://example.com/a.md").is_none());
        assert!(md_href_to_decoded_path("HTTPS://example.com/a.md").is_none());
        assert!(md_href_to_decoded_path("mailto:a@b.c").is_none());
        assert!(md_href_to_decoded_path("data:text/plain,hi").is_none());
        assert!(md_href_to_decoded_path("javascript:alert(1)").is_none());
        assert!(md_href_to_decoded_path("//cdn.example.com/a.md").is_none());
    }

    #[test]
    fn md_href_filter_rejects_non_markdown_extensions() {
        assert!(md_href_to_decoded_path("page.html").is_none());
        assert!(md_href_to_decoded_path("./notes.txt").is_none());
        assert!(md_href_to_decoded_path("image.png").is_none());
    }

    #[test]
    fn md_href_filter_accepts_relative_md() {
        assert_eq!(
            md_href_to_decoded_path("notes.md").as_deref(),
            Some("notes.md")
        );
        assert_eq!(
            md_href_to_decoded_path("./sub/notes.md").as_deref(),
            Some("./sub/notes.md")
        );
    }

    #[test]
    fn md_href_filter_strips_query_and_fragment() {
        assert_eq!(
            md_href_to_decoded_path("notes.md#section").as_deref(),
            Some("notes.md")
        );
        assert_eq!(
            md_href_to_decoded_path("notes.md?v=2").as_deref(),
            Some("notes.md")
        );
    }

    #[test]
    fn open_url_allows_http_https_mailto() {
        assert!(is_allowed_open_url("http://example.com"));
        assert!(is_allowed_open_url("https://example.com/path?q=1"));
        assert!(is_allowed_open_url("HTTPS://EXAMPLE.COM"));
        assert!(is_allowed_open_url("mailto:a@b.c"));
        assert!(is_allowed_open_url("MAILTO:a@b.c"));
    }

    #[test]
    fn open_url_rejects_dangerous_schemes() {
        assert!(!is_allowed_open_url(""));
        assert!(!is_allowed_open_url("javascript:alert(1)"));
        assert!(!is_allowed_open_url("JAVASCRIPT:alert(1)"));
        assert!(!is_allowed_open_url("file:///etc/passwd"));
        assert!(!is_allowed_open_url("FILE:///etc/passwd"));
        assert!(!is_allowed_open_url("data:text/html,<script>"));
        assert!(!is_allowed_open_url("vbscript:msgbox(1)"));
        // No scheme at all is refused (we don't want to pass bare paths
        // or relative strings to the OS shell).
        assert!(!is_allowed_open_url("example.com"));
        assert!(!is_allowed_open_url("/etc/passwd"));
    }

    #[test]
    fn md_href_filter_decodes_percent_sequences() {
        assert_eq!(
            md_href_to_decoded_path("my%20notes.md").as_deref(),
            Some("my notes.md")
        );
    }
}

#[derive(serde::Serialize)]
pub struct UpdateResult {
    pub available: bool,
    pub version: String,
    pub body: String,
}

/// Replace the set of filesystem paths being watched for changes. Pass
/// the union of the currently-open file paths and the open folder root
/// (if any). An empty vector stops all watches.
#[tauri::command]
pub async fn watch_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    let bufs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    crate::watcher::set_watch_paths(app, bufs)
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
