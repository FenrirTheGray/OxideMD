# Architecture

This document orients contributors on how OxideMD fits together. For a
file-by-file index see the Project Structure section of the [README](README.md);
this doc explains how the pieces interact.

## High-level shape

OxideMD is a [Tauri v2](https://tauri.app/) desktop app: a **Rust backend**
(`src-tauri/`) owns the OS-facing work — filesystem, dialogs, markdown
rendering, syntax highlighting, the file watcher, diagnostic logging, the
updater — and a **webview frontend** (`frontend/`) owns all UI and
interaction. There is no server and no bundled browser; the frontend runs in
the platform's native webview (WebView2 / WebKitGTK / WKWebView).

The two halves talk over Tauri's **IPC bridge**:

- Frontend → backend: `invoke('command_name', args)` calls a Rust function
  annotated `#[tauri::command]`. All commands are registered in the
  `generate_handler!` list in `src-tauri/src/lib.rs`.
- Backend → frontend: the Rust side `emit`s named **events**; the frontend
  subscribes with `listen('event-name', cb)`.

The frontend is plain ES modules (no framework). `npm run build:frontend` runs
esbuild to bundle `frontend/app.js` and its imports — including the CodeMirror 6
packages from `node_modules` — into a single file the webview loads.
`cargo tauri dev` / `cargo tauri build` drive the whole thing.

## Naming

OxideMD's name appears on disk and on screen in two forms. Pick the one that
matches the context and don't mix them:

- **`OxideMD`** — display form. Used anywhere a human reads the name: window
  title, `productName` in `tauri.conf.json`, README/CHANGELOG prose, the
  welcome wordmark, the About dialog, GitHub release names, log file prefix,
  bundle artifact filenames, and the `application` arg to `ProjectDirs` (which
  preserves casing on macOS / Windows paths).
- **`oxidemd`** — identifier form. Used wherever the OS or another tool reads
  the name as a slug: the Cargo crate, the Linux binary (`Exec=oxidemd`),
  `StartupWMClass`, `pkill -x oxidemd`, the CLI invocation, the localStorage
  prefix (`oxidemd:draft:`), temp-file slugs, and the `organization` component
  of the bundle ID.

The reverse-DNS bundle identifier `com.oxidemd.viewer` is set once in
`tauri.conf.json` and the `APP_QUALIFIER` / `APP_ORGANIZATION` / `APP_NAME`
constants in `config.rs`. Reach for those constants rather than re-spelling
the triple, so a future rename is a single edit.

## The IPC boundary

### Commands (frontend → backend)

All live in `src-tauri/src/commands.rs` unless noted. They group as:

- **File I/O** — `open_file` (read + render to HTML, canonicalized path used as
  the tab dedup key), `save_file` (write + re-render), `render_preview`
  (re-render source to HTML without touching disk; powers the live preview),
  `create_file` (native save dialog → new empty `.md`), `pick_file` (multi-file
  open dialog). The IO-heavy ones run on blocking threads; the content-loading
  ones (`open_file` / `save_file` / `create_file`) return an
  `OpenResult { html, title, path, raw }`.
- **Folder browsing** — `pick_folder` (folder dialog, returns the path only),
  `read_folder_tree` (recursive walk → `FolderTree` of nested `TreeNode`s,
  markdown files only, with a visited-entry safety cap), `resolve_md_path`
  (resolve a markdown link's href against the current file to an absolute path).
- **Project search** — `search_project` (recursive case-insensitive substring
  grep of every markdown file under a root; returns per-file grouped matches
  with total/truncated flags).
- **Config** — `get_config`, `get_default_config`, `save_config_cmd` (persists
  and mirrors the soft-break setting into the renderer).
- **Fonts** — `install_font` (pick a font file, copy into the config folder),
  `remove_font`, `list_custom_fonts`, `get_font_data` (base64 bytes for the
  webview to register a `@font-face`).
- **Recent files** — `list_recent_files`, `mark_recent_file`,
  `forget_recent_file`, `clear_recent_files`; backed by a capped list in config.
- **Image paste** — `write_pasted_image` (decode base64 image bytes into an
  `assets/` folder beside the file; returns both the absolute path and the
  markdown-relative href).
- **Export / print** — `export_html` (render to a self-contained, theme-agnostic
  HTML file), `pick_export_path`. Print-to-PDF itself is frontend-only (see
  Rendering, below).
- **Theme import/export** — `export_theme` / `import_theme` move the flat
  color-config map to/from a user-picked `.json` file.
- **File watching** — `watch_paths` replaces the whole watched set in one call.
- **Updates** — `check_for_updates` queries the updater plugin for the
  remote `latest.json`; `download_and_install_update` runs the full
  download → install → restart pipeline, streaming `update-progress`
  events during the download. On Linux RPM/DEB (detected via absence of
  the `APPIMAGE` env var) it returns `UPDATE_UNSUPPORTED_PACKAGE` so the
  frontend can route the user to the releases page instead.
- **Misc** — `get_cli_files` (argv paths to open on launch), `open_url`
  (hand an http/https/mailto URL to the OS, other schemes refused),
  `file_sha256` (hex digest, used for draft conflict detection).

### Events (backend → frontend)

- **`fs-changed`** — emitted by `watcher.rs` when a watched file/folder changes;
  carries the changed path. Leading-edge debounced per path (150 ms window).
- **`open-files-from-instance`** — emitted by the single-instance plugin in
  `lib.rs` when a second launch forwards its argv file paths to the running
  instance.
- **`version-mismatch`** — emitted by the single-instance callback when a
  freshly-launched second instance's stamped version differs from the
  running one (i.e. an update was installed on disk but the user is still
  running the old build). Payload is the new version string; the frontend
  surfaces it as a long-lived toast asking the user to relaunch.
- **`update-progress`** — emitted during `download_and_install_update`
  with `{ downloaded, total }` byte counters so the settings panel can
  drive its progress bar.
- **`prev-tab` / `next-tab` / `move-tab-left` / `move-tab-right`** — **Linux
  only**. WebKitGTK swallows some Ctrl+Tab combos before JS sees them, so
  `lib.rs` intercepts them at the GTK window level and re-emits them as events.

## Rust module map (`src-tauri/src/`)

- **`main.rs`** — thin entry point; calls `oxidemd_lib::run()`.
- **`lib.rs`** — Tauri builder: handles the `--reset-all [--yes]` CLI flag
  before any plugin opens disk handles; stamps the current version into
  `<data_dir>/.running_version`; configures `tauri-plugin-log` with a
  date-stamped file target; registers plugins (log, dialog, shell, updater,
  single-instance) plus the version-mismatch detection in the
  single-instance callback; declares the `generate_handler!` command list;
  `setup` seeds the renderer's soft-break flag and (on Linux only) installs
  a GTK key interceptor that re-emits the Ctrl+Tab family as IPC events.
- **`commands.rs`** — every `#[tauri::command]` plus their helper types and
  pure helpers (path canonicalization, the folder walk, the search scanner).
- **`config.rs`** — the `Config` struct, its `Default`, TOML load/save,
  `migrate_config` for schema-version upgrades, the per-platform config /
  fonts / themes paths, the `APP_QUALIFIER` / `APP_ORGANIZATION` / `APP_NAME`
  identifier triple + `project_dirs()` helper, and recent-files maintenance.
- **`markdown.rs`** — pulldown-cmark source → HTML string; heading slugs/ids,
  footnotes, local-image resolution, raw-HTML escaping, the soft-break atomic.
- **`highlight.rs`** — syntect-based fenced-code-block syntax highlighting.
- **`watcher.rs`** — single recursive `notify` watcher behind a mutex; per-path
  leading-edge coalesce; emits `fs-changed`.
- **`util.rs`** — HTML-escaping helpers for text content and attributes.

## Frontend module map (`frontend/`)

- **`app.js`** — entry point: init, wires global keyboard + button handlers,
  subscribes to backend events.
- **`state.js`** — shared-state hub: exports the Tauri API handles, DOM
  references, and the mutable `state` / `tabs` objects (mutable values live on
  an object because ES-module `let` can't be reassigned by importers).
- **`keybindings.js`** — pure keybinding layer: the `ACTIONS` registry,
  accelerator parse/serialize, `registerHandler` / `runAction` / `dispatchKey`,
  `effectiveBindings` (config overrides merged over defaults).
- **`tabs.js`** — tab bar, tab switching, file load/reload, zoom, overflow
  scrolling, anchor-click handling, content mounting.
- **`editor.js`** — CodeMirror 6 editor surface, edit/save lifecycle,
  split-view layout, scroll sync, dirty tracking, draft recovery prompts.
- **`editor-format.js`** — markdown formatting commands (bold, italic, lists,
  headings, link, etc.) shared by the toolbar and shortcuts.
- **`draft-store.js`** — per-file `localStorage` draft autosave and recovery,
  with the SHA-256 disk-hash stamp for conflict detection.
- **`folder.js`** — sidebar folder tree, filename filter, divider resize, and
  the `syncWatcher` that pushes the watched-path set to the backend.
- **`search.js`** — in-document search (match highlighting, next/prev, counter).
- **`search-project.js`** — project-wide content search panel inside the
  sidebar (calls `search_project`, lists file-grouped results).
- **`outline.js`** — document outline sidebar (heading list, jump-to); the
  toolbar button is repurposed as a preview toggle in edit mode.
- **`settings.js`** — the tabbed settings dialog (General / Reading / Editor /
  Colors / Shortcuts / About), config apply, custom-font loading, the update
  check and in-app install pipeline (drives the progress UI from
  `update-progress` events).
- **`shortcuts-display.js`** — renders shortcut chips in the popover, welcome
  screen, and tooltips from `state.bindings`.
- **`contextmenu.js`** — context-aware right-click menus for the sidebar tree
  and tab bar (the default webview menu is suppressed).
- **`print.js`** — print the active document to PDF via the webview's native
  print dialog, using a `@media print` stylesheet and the `#print-root` element.
- **`window-size.js`** — once-after-layout: measures the welcome-screen min
  height, caps both axes against `screen.avail{Width,Height}` so a stale
  geometry can't open off-screen, and calls `setMinSize` / `setSize`
  accordingly. Also owns the responsive toolbar compact-mode toggle and
  the 8 invisible edge / corner resize-handle overlays whose mousedown
  hands off to `appWindow.startResizeDragging`.
- **`toast.js`** — lightweight bottom-right toast notifications; auto-dismiss
  with an optional per-call `lifetimeMs` override for messages that need to
  linger (e.g. "restart to apply update").
- **`logger.js`** — frontend `logError` / `logWarn` / `logInfo` helpers that
  invoke `plugin:log|log` so messages reach the same date-stamped file as
  Rust-side logs. Installs `window.onerror` + `unhandledrejection` listeners
  on import so uncaught exceptions land in the log automatically. Must be
  imported first in `app.js` so the global handlers are live before any
  other module runs.

## Key lifecycles

### Config

`Config` (`config.rs`) is serialized as TOML at the platform config dir
(`%APPDATA%\oxidemd\OxideMD\config` on Windows, `~/.config/oxidemd` on Linux,
`~/Library/Application Support/com.oxidemd.OxideMD` on macOS), resolved via the
`directories` crate from the `APP_QUALIFIER` / `APP_ORGANIZATION` / `APP_NAME`
triple in `config.rs`. `load_config` falls back to `Config::default()` on any
read/parse error. The struct is `#[serde(default)]`, so a config file written by
an older version backfills any newly-added field from its default. For schema
changes that *can't* be expressed as a new default (renamed keys, reinterpreted
values), bump `CURRENT_CONFIG_VERSION` and add a step to `migrate_config`; it
runs once on load when the stored `config_version` is behind, then re-saves.
The frontend fetches the whole struct once at init
(`state.config = await invoke('get_config')`) and `save_config_cmd` persists it
back. Some settings need to reach the renderer immediately: the soft-break flag
is mirrored into the `PRESERVE_LINE_BREAKS` atomic in `markdown.rs` (seeded in
`lib.rs` setup, updated by `save_config_cmd`) so live preview and reopened files
reflect a change without a restart.

### Draft / autosave

`draft-store.js` keeps unsaved editor buffers in `localStorage`, keyed by
absolute file path. `editor.js` debounces a `writeDraft` per input; a successful
save clears the draft. Each draft also records `diskHashAtWrite` — the
`file_sha256` of the file at write time. On reopening a file with a draft,
`tabs.js` compares that stamp to the live disk hash; a mismatch means the file
changed externally, so the user is prompted before a stale draft can clobber it.

### File watching

`watcher.rs` holds one recursive `notify` watcher behind a mutex.
`folder.js`'s `syncWatcher` collects the union of open file paths and the open
folder root and calls `watch_paths`, which atomically drops the old watcher and
builds a new one. Raw `notify` fires bursts (a single save is several events),
so the watcher applies a per-path leading-edge debounce before emitting
`fs-changed`; the frontend coalesces per path again on its side.

### Keybinding registry

`keybindings.js` defines `ACTIONS` (every command id, its default accelerator,
and metadata). `effectiveBindings` merges the user's sparse config overrides
over those defaults — so actions added in an update auto-apply without
rewriting config. Modules call `registerHandler(id, fn)` to bind behavior;
`dispatchKey` matches a `KeyboardEvent` against the active bindings and invokes
the handler; `runAction(id)` invokes one directly. Toolbar buttons funnel
through the same handlers — clicks call `runAction` so the toolbar, the
welcome shortcuts, and keyboard accelerators all share one code path.

### Logging

`lib.rs` initializes `tauri-plugin-log` at startup with a date-stamped file
target (`OxideMD-YYYY-MM-DD.log`) in the OS app log dir (`~/.local/state` on
Linux, `%LOCALAPPDATA%` on Windows, `~/Library/Logs` on macOS), plus a
stdout target gated to `cfg(debug_assertions)` so release builds stay quiet.
Rotation is by size (5 MB) with `KeepAll` so history survives for incident
forensics. On the frontend side, `logger.js` invokes `plugin:log|log` so its
`logError` / `logWarn` / `logInfo` calls land in the same file as Rust-side
`log::error!` / `log::warn!`. The module's import side effect installs
`window.onerror` and `unhandledrejection` listeners — uncaught JS errors are
captured automatically without each call site having to remember to wrap.

### Updates

`check_for_updates` returns the available version + release-notes body.
`download_and_install_update` does the whole flow in one command: re-checks,
calls `download_and_install` on the resulting `Update` handle, and finishes
with `app.restart()` (which diverges). During the download, the closure
passed to the plugin emits `update-progress` events with the running byte
counters so the settings panel can drive its progress bar. On Linux without
`APPIMAGE` set in the environment (RPM/DEB installs need root to replace
`/usr/bin/oxidemd`) we return `UPDATE_UNSUPPORTED_PACKAGE` so the frontend
falls back to opening the GitHub releases page.

### Version-mismatch detection

Linux RPM/DEB upgrades don't kill the running process (`dpkg`/`dnf` just
swap files on disk), and AppImage / Windows-portable / macOS drag-replace
have the same problem. With `tauri-plugin-single-instance` active, the
user's "relaunch" then just refocuses the stale in-memory process. Two
mechanisms guard against this:

- **Post-install scriptlet** — `src-tauri/scripts/post-install.sh` runs
  `pkill -x oxidemd` after the package manager writes the new binary; the
  next launch is guaranteed to be the new process. Wired into RPM and DEB
  via `bundle.linux.{deb,rpm}.postInstallScript` in `tauri.conf.json`.
- **Version stamp** — every launch writes `env!("CARGO_PKG_VERSION")` to
  `<data_dir>/.running_version` *before* the single-instance plugin can
  bounce it. When a freshly-launched second instance triggers the
  callback in the surviving original, that callback reads the file: if
  the value doesn't match its own version, it emits `version-mismatch`
  and the frontend shows a long-lived toast asking the user to relaunch.

### `--reset-all` flag

`oxidemd --reset-all` prints what would be deleted and exits; `--reset-all
--yes` deletes the OxideMD config dir, data dir (including webview
storage / drafts / `.running_version`), and cache dir. Runs in `lib.rs`
before any plugin opens handles in those directories. Last-resort recovery
for users whose state is in a state we can't reason about — the routine
escape hatch is "Reset settings" in the Settings dialog.

### Rendering

`markdown.rs::render` turns markdown source into an HTML **string** on the Rust
side using pulldown-cmark, with fenced code blocks syntax-highlighted by
`highlight.rs` (syntect). Raw HTML in the source is escaped, not executed. Local
image paths are emitted as `data-oxide-src` attributes; the frontend rewrites
them to `asset://` URLs via `convertFileSrc` when it mounts the HTML into the
content area. In read mode the HTML comes from `open_file` / `save_file`; in
edit mode the live preview pane re-renders on a debounce by calling
`render_preview` with the current editor buffer.
