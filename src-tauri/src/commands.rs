use crate::config::{add_recent_file, fonts_dir, load_config, save_config, Config, MD_EXTS_DEFAULT};
use crate::markdown;
use base64::Engine;
use std::fs;
use std::io::{BufRead, BufReader};
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
            raw: content,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Re-renders `content` as HTML without touching disk. Used by the live
/// preview pane while the user types; `path` is only consulted to resolve
/// relative image references via its parent directory.
#[tauri::command]
pub async fn render_preview(content: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let base_dir = if path.is_empty() { None } else { p.parent() };
        Ok(markdown::render(&content, base_dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_file(path: String, content: String) -> Result<OpenResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw = PathBuf::from(&path);
        fs::write(&raw, &content).map_err(|e| e.to_string())?;
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
            raw: content,
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
        let exts = md_extensions(&load_config());
        let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter("Markdown", &ext_refs)
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

/// Opens a native save dialog and creates a new, empty markdown file at
/// the chosen location, returning it as an `OpenResult` so the frontend
/// can open it in a tab exactly like `open_file`. `dir`, when provided
/// and non-empty, seeds the dialog's starting directory — used by the
/// sidebar's "New File…" entry so the file lands inside the folder the
/// user right-clicked. Returns `Ok(None)` when the user cancels.
///
/// The native save dialog handles the overwrite confirmation itself, so
/// writing an empty string here is the expected, user-approved outcome.
#[tauri::command]
pub async fn create_file(
    app: tauri::AppHandle,
    dir: Option<String>,
) -> Result<Option<OpenResult>, String> {
    let window = app.get_webview_window("main").unwrap();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let exts = md_extensions(&load_config());
        let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        let mut builder = app
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("Markdown", &ext_refs)
            .set_file_name("untitled.md");
        if let Some(d) = dir.as_deref() {
            if !d.is_empty() {
                builder = builder.set_directory(d);
            }
        }
        builder.blocking_save_file().map(|p| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    let chosen = match picked {
        Some(p) => p,
        None => return Ok(None),
    };

    tauri::async_runtime::spawn_blocking(move || {
        let exts = md_extensions(&load_config());
        let path = ensure_md_extension(PathBuf::from(&chosen), &exts);
        fs::write(&path, "").map_err(|e| e.to_string())?;
        let canonical = fs::canonicalize(&path).unwrap_or(path);
        let canonical = strip_windows_verbatim(canonical);
        let base_dir = canonical.parent();
        let html = markdown::render("", base_dir);
        let title = canonical
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("OxideMD")
            .to_string();
        Ok(Some(OpenResult {
            html,
            title,
            path: canonical.to_string_lossy().into_owned(),
            raw: String::new(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct FolderTree {
    pub root: String,
    pub name: String,
    pub entries: Vec<TreeNode>,
    /// True if the scan hit the visited-entries safety cap and some
    /// files may have been missed. The sidebar uses this to warn the
    /// user so a monster folder doesn't silently look incomplete.
    pub truncated: bool,
}

// Single safety cap: the maximum number of raw filesystem entries we'll
// stat during the scan. Large enough to cover typical dev workspaces
// (including node_modules-heavy trees), small enough to refuse someone
// pointing at `~/` or `C:\`.
const WALK_MAX_VISITED: usize = 500_000;

#[derive(serde::Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

/// Resolves the effective list of Markdown extensions from a loaded
/// config, falling back to the canonical defaults when the config's
/// list is empty (older config files, or a field cleared by hand).
fn md_extensions(config: &Config) -> Vec<String> {
    if config.md_extensions.is_empty() {
        MD_EXTS_DEFAULT.iter().map(|e| e.to_string()).collect()
    } else {
        config.md_extensions.clone()
    }
}

fn is_md_file(path: &std::path::Path, exts: &[String]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| exts.contains(&e.to_lowercase()))
        .unwrap_or(false)
}

/// Normalizes a path chosen from the "new file" save dialog so it ends
/// with a markdown extension. If it already has a recognized markdown
/// extension it is left alone; otherwise `.md` is appended (covers a
/// bare name typed with no extension). A non-markdown extension is kept
/// and `.md` appended rather than replaced, so the user's intent is
/// never silently discarded.
fn ensure_md_extension(path: PathBuf, exts: &[String]) -> PathBuf {
    if is_md_file(&path, exts) {
        path
    } else {
        let mut s = path.into_os_string();
        s.push(".md");
        PathBuf::from(s)
    }
}

/// Descends into every non-hidden directory under `dir` and appends any
/// markdown file paths to `out`. No depth or per-directory cap — the
/// only guard is `visited`, which counts raw filesystem entries and
/// aborts the scan once it crosses `WALK_MAX_VISITED`.
fn collect_md_paths(
    dir: &std::path::Path,
    exts: &[String],
    out: &mut Vec<PathBuf>,
    visited: &mut usize,
    truncated: &mut bool,
) {
    if *truncated {
        return;
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten() {
        *visited += 1;
        if *visited >= WALK_MAX_VISITED {
            *truncated = true;
            return;
        }
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
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
            collect_md_paths(&path, exts, out, visited, truncated);
            if *truncated {
                return;
            }
        } else if ft.is_file() && is_md_file(&path, exts) {
            out.push(path);
        }
    }
}

/// Reconstructs a folder/file tree from a flat list of markdown file
/// paths. All ancestor directories of any included file are synthesized;
/// directories with no markdown descendant never appear. Within each
/// level, folders sort before files and each group is alphabetical
/// (case-insensitive).
fn build_nodes(parent: &std::path::Path, files: &[PathBuf]) -> Vec<TreeNode> {
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    let mut direct_files: Vec<(String, String)> = Vec::new();

    for f in files {
        let rel = match f.strip_prefix(parent) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut comps = rel.components();
        let first = match comps.next() {
            Some(c) => c.as_os_str().to_string_lossy().into_owned(),
            None => continue,
        };
        if comps.clone().next().is_none() {
            direct_files.push((first, f.to_string_lossy().into_owned()));
        } else {
            groups.entry(first).or_default().push(f.clone());
        }
    }

    let mut nodes: Vec<TreeNode> = Vec::new();
    for (name, group_paths) in groups {
        let subdir = parent.join(&name);
        let children = build_nodes(&subdir, &group_paths);
        if children.is_empty() {
            continue;
        }
        nodes.push(TreeNode {
            name,
            path: subdir.to_string_lossy().into_owned(),
            is_dir: true,
            children,
        });
    }
    for (name, full_path) in direct_files {
        nodes.push(TreeNode {
            name,
            path: full_path,
            is_dir: false,
            children: Vec::new(),
        });
    }
    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    nodes
}

fn build_folder_tree(root: &std::path::Path, exts: &[String]) -> FolderTree {
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_else(|| root.to_str().unwrap_or(""))
        .to_string();
    let mut md_paths: Vec<PathBuf> = Vec::new();
    let mut visited: usize = 0;
    let mut truncated = false;
    collect_md_paths(root, exts, &mut md_paths, &mut visited, &mut truncated);
    let entries = build_nodes(root, &md_paths);
    FolderTree {
        root: root.to_string_lossy().into_owned(),
        name,
        entries,
        truncated,
    }
}

// Returns just the picked path; the folder scan happens in a separate
// read_folder_tree call so the frontend can show a loading indicator
// between the OS dialog closing and the tree being ready.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    let window = app.get_webview_window("main").unwrap();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_folder()
            .map(|p| p.to_string())
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
        // Load config once here, not per-entry inside the recursive walk.
        let exts = md_extensions(&load_config());
        Ok(build_folder_tree(&p, &exts))
    })
    .await
    .map_err(|e| e.to_string())?
}

// Per-line text is truncated to this many characters so a minified-JSON
// line inside a fenced code block can't bloat the result payload. The
// cut is on a char boundary (chars().take), never a byte index.
const SEARCH_MAX_LINE_LEN: usize = 200;
// Hard ceiling on total matches across every file — once crossed the
// scan stops so a query like "e" against a huge tree can't hang or
// produce a megabyte of results. `truncated` is surfaced to the UI.
const SEARCH_MAX_MATCHES: usize = 1000;

#[derive(serde::Serialize)]
pub struct SearchMatch {
    pub line_number: usize,
    pub line_text: String,
}

#[derive(serde::Serialize)]
pub struct SearchFileResult {
    pub path: String,
    pub name: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(serde::Serialize)]
pub struct SearchResults {
    pub results: Vec<SearchFileResult>,
    /// Total number of matches across all files in `results`.
    pub total: usize,
    /// True if the scan stopped early — either the folder walk hit
    /// `WALK_MAX_VISITED` or the match count hit `SEARCH_MAX_MATCHES`.
    /// The sidebar uses this to warn the results may be incomplete.
    pub truncated: bool,
}

/// Truncates `line` to at most `max` characters, cutting on a char
/// boundary so multibyte UTF-8 is never split. Returns an owned String.
fn truncate_line(line: &str, max: usize) -> String {
    if line.chars().count() <= max {
        line.to_string()
    } else {
        line.chars().take(max).collect()
    }
}

/// Scans one file's text for a case-insensitive plain-substring match of
/// `query_lower` (which the caller has already lowercased). Pure string
/// logic — no filesystem, no regex — kept separate so it's unit-testable.
/// Stops early once `remaining` matches have been collected and reports
/// how many were left via the returned count.
fn scan_lines(content: &str, query_lower: &str, max_line_len: usize, remaining: usize) -> Vec<SearchMatch> {
    let mut out: Vec<SearchMatch> = Vec::new();
    if query_lower.is_empty() || remaining == 0 {
        return out;
    }
    for (i, line) in content.lines().enumerate() {
        if line.to_lowercase().contains(query_lower) {
            out.push(SearchMatch {
                line_number: i + 1,
                line_text: truncate_line(line, max_line_len),
            });
            if out.len() >= remaining {
                break;
            }
        }
    }
    out
}

/// Recursively greps every Markdown file under `root` for `query`.
/// Case-insensitive plain substring match (no regex). Results are
/// grouped per file; files that fail to read are skipped rather than
/// aborting the whole search. Runs on a blocking thread like the other
/// IO-heavy commands here.
#[tauri::command]
pub async fn search_project(query: String, root: String) -> Result<SearchResults, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(SearchResults {
                results: Vec::new(),
                total: 0,
                truncated: false,
            });
        }
        let root_path = PathBuf::from(&root);
        if !root_path.is_dir() {
            return Err(format!("Not a directory: {root}"));
        }
        // Load config once, then reuse the existing folder walk so the
        // extension filter and the WALK_MAX_VISITED guard stay shared.
        let exts = md_extensions(&load_config());
        let mut md_paths: Vec<PathBuf> = Vec::new();
        let mut visited: usize = 0;
        let mut walk_truncated = false;
        collect_md_paths(&root_path, &exts, &mut md_paths, &mut visited, &mut walk_truncated);
        md_paths.sort();

        let mut results: Vec<SearchFileResult> = Vec::new();
        let mut total: usize = 0;
        let mut truncated = walk_truncated;
        for path in md_paths {
            if total >= SEARCH_MAX_MATCHES {
                truncated = true;
                break;
            }
            let file = match fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue, // unreadable file — skip, don't abort
            };
            let mut content = String::new();
            // Read line by line so a single huge file can't blow memory;
            // a read error mid-file just ends that file's scan.
            for line in BufReader::new(file).lines() {
                match line {
                    Ok(l) => {
                        content.push_str(&l);
                        content.push('\n');
                    }
                    Err(_) => break,
                }
            }
            let matches = scan_lines(
                &content,
                &needle,
                SEARCH_MAX_LINE_LEN,
                SEARCH_MAX_MATCHES - total,
            );
            if matches.is_empty() {
                continue;
            }
            total += matches.len();
            results.push(SearchFileResult {
                name: path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string(),
                path: path.to_string_lossy().into_owned(),
                matches,
            });
        }
        Ok(SearchResults {
            results,
            total,
            truncated,
        })
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
fn md_href_to_decoded_path(href: &str, exts: &[String]) -> Option<String> {
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
    if !is_md_file(std::path::Path::new(&decoded), exts) {
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
        let exts = md_extensions(&load_config());
        let decoded = md_href_to_decoded_path(&href, &exts)?;
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
    save_config(&config)?;
    // Mirror the line-break setting into the renderer's atomic so it
    // takes effect immediately (live preview, reopened files) without a
    // restart. Only after a successful save — a failed write shouldn't
    // leave the renderer reflecting an unpersisted setting.
    crate::markdown::PRESERVE_LINE_BREAKS
        .store(config.preserve_line_breaks, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn save_window_geometry(width: u32, height: u32, maximized: bool) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.window_width = width;
    cfg.window_height = height;
    cfg.window_maximized = maximized;
    save_config(&cfg)
}

#[derive(serde::Serialize)]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub exists: bool,
}

fn build_recent_entries(paths: &[String]) -> Vec<RecentFile> {
    paths
        .iter()
        .map(|p| {
            let pb = std::path::Path::new(p);
            RecentFile {
                path: p.clone(),
                name: pb
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(p)
                    .to_string(),
                exists: pb.is_file(),
            }
        })
        .collect()
}

#[tauri::command]
pub fn list_recent_files() -> Vec<RecentFile> {
    build_recent_entries(&load_config().recent_files)
}

#[tauri::command]
pub fn mark_recent_file(path: String) -> Result<Vec<RecentFile>, String> {
    let mut cfg = load_config();
    add_recent_file(&mut cfg, &path);
    save_config(&cfg)?;
    Ok(build_recent_entries(&cfg.recent_files))
}

#[tauri::command]
pub fn forget_recent_file(path: String) -> Result<Vec<RecentFile>, String> {
    let mut cfg = load_config();
    cfg.recent_files.retain(|p| p != &path);
    save_config(&cfg)?;
    Ok(build_recent_entries(&cfg.recent_files))
}

#[tauri::command]
pub fn clear_recent_files() -> Result<(), String> {
    let mut cfg = load_config();
    cfg.recent_files.clear();
    save_config(&cfg)
}

/// SHA-256 of a file's bytes, hex-encoded. Used for draft conflict
/// detection — if the on-disk hash at draft-write time disagrees with
/// the on-disk hash at recovery time, the file changed externally and
/// the user is prompted before we replace disk content with the draft.
#[tauri::command]
pub async fn file_sha256(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let mut h = Sha256::new();
        h.update(&bytes);
        let digest = h.finalize();
        let mut out = String::with_capacity(digest.len() * 2);
        for b in digest {
            out.push_str(&format!("{:02x}", b));
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct PastedImage {
    pub absolute_path: String,
    pub relative_href: String,
}

/// Writes raw image bytes (base64-encoded by the frontend) into an
/// `assets/` folder beside the markdown file `base_path`. Returns both
/// the absolute path (for asset:// preview) and the markdown-relative
/// href the editor should insert.
#[tauri::command]
pub async fn write_pasted_image(
    base_path: String,
    extension: String,
    base64_data: String,
) -> Result<PastedImage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = PathBuf::from(&base_path);
        let parent = base
            .parent()
            .ok_or("base_path has no parent directory")?
            .to_path_buf();
        let assets = parent.join("assets");
        fs::create_dir_all(&assets).map_err(|e| format!("Failed to create assets dir: {e}"))?;

        let ext = extension.trim_start_matches('.').to_lowercase();
        let allowed = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp");
        if !allowed {
            return Err(format!("Unsupported image extension: {ext}"));
        }

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_data.as_bytes())
            .map_err(|e| format!("Invalid base64: {e}"))?;

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let filename = format!("paste-{}.{}", stamp, ext);
        let abs = assets.join(&filename);
        fs::write(&abs, &bytes).map_err(|e| format!("Failed to write image: {e}"))?;

        let canonical = fs::canonicalize(&abs).unwrap_or(abs);
        let canonical = strip_windows_verbatim(canonical);
        Ok(PastedImage {
            absolute_path: canonical.to_string_lossy().into_owned(),
            relative_href: format!("assets/{}", filename),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

const EXPORT_HTML_TEMPLATE: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>__TITLE__</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1.5rem; color: #1a1a1a; line-height: 1.7; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.6em; margin-bottom: 0.6em; line-height: 1.25; }
  h1 { border-bottom: 1px solid #e0e0e0; padding-bottom: 0.3em; }
  h2 { border-bottom: 1px solid #efefef; padding-bottom: 0.2em; }
  pre { background: #f6f8fa; border-radius: 8px; padding: 14px 18px; overflow-x: auto; }
  code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.9em; background: #f3f3f3; padding: 1px 5px; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #d8d8d8; margin: 1em 0; padding: 0.4em 1em; color: #555; background: #fafafa; }
  table { border-collapse: collapse; width: 100%; margin: 1.2em 0; }
  th, td { border: 1px solid #e1e4e8; padding: 8px 14px; text-align: left; }
  th { background: #f6f8fa; }
  img { max-width: 100%; height: auto; }
  hr { border: 0; border-top: 1px solid #e0e0e0; margin: 2em 0; }
  .codeblock { position: relative; }
  .codeblock-copy, .codeblock-lang { display: none; }
  .task-list-checkbox { margin-right: 0.4em; }
  @media print {
    body { max-width: none; margin: 0; padding: 0; color: #000; }
    a { color: #000; text-decoration: underline; }
    pre, blockquote, table { page-break-inside: avoid; }
  }
</style>
</head>
<body>
__BODY__
</body>
</html>
"#;

/// Renders the markdown source to a self-contained HTML file at
/// `out_path`. The styling is intentionally minimal and theme-agnostic
/// so the exported file looks reasonable in any browser without
/// shipping the editor's design tokens.
#[tauri::command]
pub async fn export_html(
    source: String,
    base_path: String,
    out_path: String,
    title: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = PathBuf::from(&base_path);
        let base_dir = base.parent();
        let body = markdown::render(&source, base_dir);
        let document = EXPORT_HTML_TEMPLATE
            .replace("__TITLE__", &crate::util::html_escape(&title))
            .replace("__BODY__", &body);
        fs::write(&out_path, document).map_err(|e| format!("Failed to write HTML: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pick_export_path(
    app: tauri::AppHandle,
    suggested_name: String,
) -> Option<String> {
    let window = app.get_webview_window("main").unwrap();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter("HTML", &["html", "htm"])
            .set_file_name(&suggested_name)
            .blocking_save_file()
            .map(|p| p.to_string())
    })
    .await
    .ok()
    .flatten()
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
    pub raw: String,
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

    // Default extension set, as a Vec<String>, for tests that exercise
    // the extension-aware helpers with today's shipped behaviour.
    fn default_exts() -> Vec<String> {
        MD_EXTS_DEFAULT.iter().map(|e| e.to_string()).collect()
    }

    #[test]
    fn is_md_file_checks_extension_case_insensitively() {
        let exts = default_exts();
        assert!(is_md_file(std::path::Path::new("a.md"), &exts));
        assert!(is_md_file(std::path::Path::new("a.MD"), &exts));
        assert!(is_md_file(std::path::Path::new("a.markdown"), &exts));
        assert!(is_md_file(std::path::Path::new("a.MDown"), &exts));
        assert!(is_md_file(std::path::Path::new("a.mkd"), &exts));
        assert!(!is_md_file(std::path::Path::new("a.txt"), &exts));
        assert!(!is_md_file(std::path::Path::new("a"), &exts));
    }

    #[test]
    fn is_md_file_honors_a_custom_extension_list() {
        // A user-configured list replaces the defaults entirely: .mdx
        // matches, the dropped default .mkd no longer does.
        let exts = vec!["md".to_string(), "mdx".to_string()];
        assert!(is_md_file(std::path::Path::new("a.mdx"), &exts));
        assert!(is_md_file(std::path::Path::new("a.MDX"), &exts));
        assert!(is_md_file(std::path::Path::new("a.md"), &exts));
        assert!(!is_md_file(std::path::Path::new("a.mkd"), &exts));
    }

    #[test]
    fn md_extensions_falls_back_to_defaults_when_empty() {
        let mut cfg = Config::default();
        cfg.md_extensions = Vec::new();
        assert_eq!(md_extensions(&cfg), default_exts());
        // A non-empty list is returned unchanged.
        cfg.md_extensions = vec!["mdx".to_string()];
        assert_eq!(md_extensions(&cfg), vec!["mdx".to_string()]);
    }

    #[test]
    fn ensure_md_extension_appends_when_missing() {
        let exts = default_exts();
        assert_eq!(
            ensure_md_extension(PathBuf::from("notes"), &exts).to_string_lossy(),
            "notes.md"
        );
    }

    #[test]
    fn ensure_md_extension_keeps_existing_markdown_extensions() {
        let exts = default_exts();
        assert_eq!(
            ensure_md_extension(PathBuf::from("notes.md"), &exts).to_string_lossy(),
            "notes.md"
        );
        assert_eq!(
            ensure_md_extension(PathBuf::from("notes.markdown"), &exts).to_string_lossy(),
            "notes.markdown"
        );
        assert_eq!(
            ensure_md_extension(PathBuf::from("notes.MKD"), &exts).to_string_lossy(),
            "notes.MKD"
        );
    }

    #[test]
    fn ensure_md_extension_appends_to_non_markdown_extension() {
        let exts = default_exts();
        // A non-markdown extension is preserved, not replaced.
        assert_eq!(
            ensure_md_extension(PathBuf::from("notes.txt"), &exts).to_string_lossy(),
            "notes.txt.md"
        );
    }

    #[test]
    fn md_href_filter_rejects_empty_and_fragments() {
        let exts = default_exts();
        assert!(md_href_to_decoded_path("", &exts).is_none());
        assert!(md_href_to_decoded_path("#anchor", &exts).is_none());
    }

    #[test]
    fn md_href_filter_rejects_remote_schemes() {
        let exts = default_exts();
        assert!(md_href_to_decoded_path("http://example.com/a.md", &exts).is_none());
        assert!(md_href_to_decoded_path("HTTPS://example.com/a.md", &exts).is_none());
        assert!(md_href_to_decoded_path("mailto:a@b.c", &exts).is_none());
        assert!(md_href_to_decoded_path("data:text/plain,hi", &exts).is_none());
        assert!(md_href_to_decoded_path("javascript:alert(1)", &exts).is_none());
        assert!(md_href_to_decoded_path("//cdn.example.com/a.md", &exts).is_none());
    }

    #[test]
    fn md_href_filter_rejects_non_markdown_extensions() {
        let exts = default_exts();
        assert!(md_href_to_decoded_path("page.html", &exts).is_none());
        assert!(md_href_to_decoded_path("./notes.txt", &exts).is_none());
        assert!(md_href_to_decoded_path("image.png", &exts).is_none());
    }

    #[test]
    fn md_href_filter_accepts_relative_md() {
        let exts = default_exts();
        assert_eq!(
            md_href_to_decoded_path("notes.md", &exts).as_deref(),
            Some("notes.md")
        );
        assert_eq!(
            md_href_to_decoded_path("./sub/notes.md", &exts).as_deref(),
            Some("./sub/notes.md")
        );
    }

    #[test]
    fn md_href_filter_honors_custom_extensions() {
        // With .mdx configured, a relative .mdx link resolves; the
        // dropped .mkd default no longer does.
        let exts = vec!["md".to_string(), "mdx".to_string()];
        assert_eq!(
            md_href_to_decoded_path("notes.mdx", &exts).as_deref(),
            Some("notes.mdx")
        );
        assert!(md_href_to_decoded_path("notes.mkd", &exts).is_none());
    }

    #[test]
    fn md_href_filter_strips_query_and_fragment() {
        let exts = default_exts();
        assert_eq!(
            md_href_to_decoded_path("notes.md#section", &exts).as_deref(),
            Some("notes.md")
        );
        assert_eq!(
            md_href_to_decoded_path("notes.md?v=2", &exts).as_deref(),
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
        let exts = default_exts();
        assert_eq!(
            md_href_to_decoded_path("my%20notes.md", &exts).as_deref(),
            Some("my notes.md")
        );
    }

    #[test]
    fn scan_lines_matches_case_insensitively() {
        // The caller lowercases the query; scan_lines lowercases each
        // line, so a mixed-case line matches a lowercased needle and
        // vice versa.
        let content = "Hello FOO world\nnothing here\nfoo again\n";
        let m = scan_lines(content, "foo", 200, 1000);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].line_number, 1);
        assert_eq!(m[0].line_text, "Hello FOO world");
        assert_eq!(m[1].line_number, 3);
        assert_eq!(m[1].line_text, "foo again");
    }

    #[test]
    fn scan_lines_treats_query_as_literal_not_regex() {
        // `.` and `[abc]` are literal characters here — a plain substring
        // search, never a regex. `a.b` matches only the literal "a.b".
        let content = "axb should not match\na.b literal match\n[abc] bracket line\n";
        let dot = scan_lines(content, "a.b", 200, 1000);
        assert_eq!(dot.len(), 1);
        assert_eq!(dot[0].line_number, 2);
        let bracket = scan_lines(content, "[abc]", 200, 1000);
        assert_eq!(bracket.len(), 1);
        assert_eq!(bracket[0].line_number, 3);
    }

    #[test]
    fn scan_lines_empty_query_yields_nothing() {
        let content = "anything at all\n";
        assert!(scan_lines(content, "", 200, 1000).is_empty());
    }

    #[test]
    fn truncate_line_cuts_on_char_boundary() {
        // A line of multibyte chars truncated mid-string must stay valid
        // UTF-8 — byte slicing would panic here, char-based never does.
        let line = "héllo wörld ".repeat(40); // well over 200 chars, multibyte
        let cut = truncate_line(&line, 200);
        assert_eq!(cut.chars().count(), 200);
        // Round-tripping through chars() proves it's still valid UTF-8.
        assert_eq!(cut.chars().count(), cut.chars().collect::<String>().chars().count());
        // A short line is returned unchanged.
        assert_eq!(truncate_line("hôla", 200), "hôla");
    }

    #[test]
    fn scan_lines_truncates_long_match_lines() {
        let long = format!("match {}", "x".repeat(500));
        let content = format!("{long}\n");
        let m = scan_lines(&content, "match", 200, 1000);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].line_text.chars().count(), 200);
    }

    #[test]
    fn scan_lines_stops_at_remaining_cap() {
        // `remaining` is the global budget left; scan_lines must stop
        // collecting once it's reached even if more lines would match.
        let content = "foo\nfoo\nfoo\nfoo\nfoo\n";
        let m = scan_lines(content, "foo", 200, 3);
        assert_eq!(m.len(), 3);
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
