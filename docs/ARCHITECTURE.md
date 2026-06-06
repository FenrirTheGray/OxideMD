# Architecture

This document is for contributors: it explains how OxideMD's Rust backend and
webview frontend divide the work, how they communicate, and how the moving
parts behave at runtime. For a tour of what the app does, see the
[README](../README.md).

## The big picture

OxideMD is a [Tauri v2](https://tauri.app/) desktop application. It has two
halves:

- A **Rust backend** (`src-tauri/`) that owns everything OS-facing: the
  filesystem, native dialogs, Markdown rendering, syntax highlighting, the file
  watcher, diagnostic logging, and the updater.
- A **TypeScript frontend** (`frontend/`) that owns all UI and interaction.

There is no server and no bundled browser — the frontend runs inside the
platform's native webview (WebView2 on Windows, WebKitGTK on Linux, WKWebView
on macOS). The frontend is plain ES modules with no UI framework;
`npm run build:frontend` runs esbuild to bundle `frontend/app.ts` and its
imports — including the CodeMirror 6 packages from `node_modules` — into a
single file the webview loads. `cargo tauri dev` and `cargo tauri build` drive
the whole build.

The two halves talk over Tauri's **IPC bridge**:

- **Frontend → backend:** `invoke('command_name', args)` calls a Rust function
  annotated `#[tauri::command]`. Every command is registered in the
  `generate_handler!` list in `src-tauri/src/lib.rs`.
- **Backend → frontend:** the Rust side `emit`s named **events**; the frontend
  subscribes with `listen('event-name', cb)`.

## Naming

The name appears in two forms; pick the one that fits the context and don't mix
them:

- **`OxideMD`** — the display form, for anything a human reads: the window
  title, `productName` in `tauri.conf.json`, prose in the README and CHANGELOG,
  the welcome wordmark, the About dialog, GitHub release names, the log-file
  prefix, and bundle artifact filenames.
- **`oxidemd`** — the identifier form, for anything a machine reads as a slug:
  the Cargo crate, the Linux binary (`Exec=oxidemd`), `StartupWMClass`,
  `pkill -x oxidemd`, the CLI invocation, the localStorage prefix
  (`oxidemd:draft:`), and temp-file slugs.

Two distinct reverse-DNS identifiers exist, for two different systems — don't
conflate them:

- The **Tauri bundle identifier** is `com.oxidemd.viewer`, set once in
  `tauri.conf.json`.
- The **config/data path identifier** comes from the `APP_QUALIFIER` /
  `APP_ORGANIZATION` / `APP_NAME` triple (`"com"` / `"oxidemd"` / `"OxideMD"`)
  in `config.rs`, fed to the `directories` crate's `ProjectDirs`. That triple
  produces `com.oxidemd.OxideMD` on macOS paths and preserves casing on
  Windows. Reach for those constants rather than re-spelling the triple, so a
  future rename is a single edit.

## The IPC boundary

### Commands (frontend → backend)

All live in `src-tauri/src/commands.rs` unless noted. They group as:

- **File I/O** — `open_file` (read and render to HTML; the canonicalized path is
  the tab-dedup key), `save_file` (write and re-render), `render_preview`
  (re-render source to HTML without touching disk — this powers the live
  preview), `create_file` (native save dialog → a new empty `.md`), `pick_file`
  (multi-file open dialog). The IO-heavy commands run on blocking threads; the
  content-loading ones (`open_file` / `save_file` / `create_file`) return an
  `OpenResult { html, title, path, raw }`.
- **Folder browsing** — `pick_folder` (folder dialog, returns the path only),
  `read_folder_tree` (recursive walk → a `FolderTree` of nested `TreeNode`s,
  Markdown only, with a visited-entry safety cap), `resolve_md_path` (resolve a
  Markdown link's href against the current file to an absolute path).
- **Project search** — `search_project` (recursive, case-insensitive substring
  scan of every Markdown file under a root; returns per-file grouped matches
  with total and truncated flags).
- **Config** — `get_config`, `get_default_config`, `save_config_cmd` (persists,
  and mirrors the soft-break setting into the renderer).
- **Fonts** — `install_font` (pick a font file and copy it into the config
  folder), `remove_font`, `list_custom_fonts`, `get_font_data` (base64 bytes so
  the webview can register a `@font-face`).
- **Recent files** — `list_recent_files`, `mark_recent_file`,
  `forget_recent_file`, `clear_recent_files`; backed by a capped list in config.
- **Image paste** — `write_pasted_image` (decode base64 image bytes into an
  `assets/` folder beside the file; returns both the absolute path and the
  Markdown-relative href).
- **Export / print** — `export_html` (render to a self-contained,
  theme-agnostic HTML file), `pick_export_path`. Print-to-PDF itself is
  frontend-only (see [Rendering](#rendering)).
- **Theme import/export** — `export_theme` / `import_theme` move the flat
  color-config map to and from a user-picked `.json` file.
- **File watching** — `watch_paths` replaces the whole watched set in one call.
- **Updates** — `check_for_updates` queries the updater plugin for the remote
  `latest.json`; `download_and_install_update` runs the full
  download → install → restart pipeline, streaming `update-progress` events
  during the download. On Linux RPM/DEB (detected by the absence of the
  `APPIMAGE` env var) it returns `UPDATE_UNSUPPORTED_PACKAGE` so the frontend
  can route the user to the releases page instead.
- **Misc** — `get_cli_files` (argv paths to open on launch), `open_url` (hand an
  http/https/mailto URL to the OS; other schemes are refused), `file_sha256`
  (hex digest, used for draft conflict detection).

### Events (backend → frontend)

- **`fs-changed`** — emitted by `watcher.rs` when a watched file or folder
  changes; carries the changed path. Leading-edge debounced per path (150 ms
  window).
- **`open-files-from-instance`** — emitted by the single-instance plugin in
  `lib.rs` when a second launch forwards its argv file paths to the running
  instance.
- **`version-mismatch`** — emitted by the single-instance callback when a
  freshly launched second instance's stamped version differs from the running
  one (an update was installed on disk but the user is still running the old
  build). The payload is the new version string; the frontend surfaces it as a
  long-lived toast asking the user to relaunch.
- **`update-progress`** — emitted during `download_and_install_update` with
  `{ downloaded, total }` byte counters so the settings panel can drive its
  progress bar.
- **`prev-tab` / `next-tab` / `move-tab-left` / `move-tab-right`** — **Linux
  only.** WebKitGTK swallows some `Ctrl+Tab` combos before JS sees them, so
  `lib.rs` intercepts them at the GTK window level and re-emits them as events.

## Rust module map (`src-tauri/src/`)

- **`main.rs`** — a thin entry point that calls `oxidemd_lib::run()`.
- **`lib.rs`** — the Tauri builder. Handles the `--reset-all [--yes]` CLI flag
  before any plugin opens disk handles; stamps the current version into
  `<data_dir>/.running_version`; configures `tauri-plugin-log` with a
  date-stamped file target; registers plugins (log, dialog, shell, updater,
  single-instance) plus version-mismatch detection in the single-instance
  callback; declares the `generate_handler!` command list; and in `setup` seeds
  the renderer's soft-break flag and (Linux only) installs a GTK key
  interceptor that re-emits the `Ctrl+Tab` family as IPC events.
- **`commands.rs`** — every `#[tauri::command]`, their helper types, and the
  pure helpers (path canonicalization, the folder walk, the search scanner).
- **`config.rs`** — the `Config` struct and its `Default`, TOML load/save,
  `migrate_config` for schema-version upgrades, the per-platform config / fonts
  / themes paths, the `APP_QUALIFIER` / `APP_ORGANIZATION` / `APP_NAME`
  identifier triple and the `project_dirs()` helper, and recent-files
  maintenance.
- **`markdown.rs`** — pulldown-cmark source → HTML string: heading slugs/ids,
  footnotes, local-image resolution, raw-HTML escaping, and the soft-break
  atomic.
- **`highlight.rs`** — syntect-based syntax highlighting for fenced code blocks.
- **`watcher.rs`** — a single recursive `notify` watcher behind a mutex, with a
  per-path leading-edge coalesce; emits `fs-changed`.
- **`util.rs`** — HTML-escaping helpers for text content and attributes.

## Frontend module map (`frontend/`)

The frontend is organized into subdirectories by role. `app.ts` is the entry
point esbuild bundles; everything else is imported from there or from its
siblings.

**`app.ts`** — the entry point: runs `init()`, wires the global keyboard and
button handlers, registers action handlers against the keybinding registry, and
subscribes to backend events. It imports `core/logger` first so the global
error handlers are live before anything else runs.

**`core/`** — cross-cutting state and pure infrastructure.

- **`state.ts`** — the shared-state hub: exports the Tauri API handles, platform
  flags, DOM references, and the mutable `state` / `tabs` objects (mutable
  values live on an object because an ES-module `let` can't be reassigned by
  importers).
- **`tab-state.ts`** — a neutral seam below both `ui/tabs.ts` and
  `editor/editor.ts`: the active-tab accessor, the pure dirty/preview
  predicates, content mounting, status helpers, and zoom. Hoisting these here
  removed the mutual dependency the two modules used to have; it imports only
  from `state.ts`, so it has no load-time side effects.
- **`keybindings.ts`** — the keybinding layer: the `ACTIONS` registry,
  `registerHandler` / `runAction` / `dispatchKey`, the platform-dependent
  accelerator matchers, and `effectiveBindings` (config overrides merged over
  defaults). The pure parse/serialize half lives in `lib/accel.ts`.
- **`draft-store.ts`** — per-file `localStorage` draft autosave and recovery,
  keyed by absolute path, each draft stamped with the SHA-256 disk hash at
  write time for conflict detection.
- **`logger.ts`** — `logError` / `logWarn` / `logInfo` helpers that invoke
  `plugin:log|log` so messages reach the same date-stamped file as the Rust
  logs, teeing to the console in dev builds. Its import side effect installs
  `window.onerror` and `unhandledrejection` listeners — which is why `app.ts`
  imports it first.

**`lib/`** — pure, dependency-free utilities, unit-tested in Node (each has a
co-located `*.test.ts`).

- **`accel.ts`** — accelerator parse/serialize, split out of `keybindings.ts`
  so it can be tested without the DOM or Tauri globals.
- **`md-table.ts`** — `formatMarkdownBuffer` and its table-alignment /
  grapheme-width helpers, split out of `editor.ts`; powers the opt-in
  format-on-save.
- **`timing.ts`** — `debounce` / `throttle`, the shared trailing-edge timing
  helpers used across the UI modules.

**`editor/`** — the editing surface.

- **`editor.ts`** — the CodeMirror 6 editor, the edit/save lifecycle, split-view
  layout, scroll sync, dirty tracking, and draft-recovery prompts.
- **`editor-format.ts`** — the Markdown formatting commands (bold, italic,
  lists, headings, link, …), each a single CM6 transaction, shared by the
  toolbar and the shortcuts.

**`features/`** — self-contained user-facing features.

- **`search.ts`** — in-document search (match highlighting, next/prev, counter).
- **`search-project.ts`** — the project-wide content-search panel that lives
  inside the sidebar (calls `search_project`, lists file-grouped results).
- **`print.ts`** — prints the active document to PDF via the webview's native
  print dialog, using the `@media print` stylesheet and the `#print-root`
  element.

**`settings/`** — the tabbed settings dialog, split from one large module.

- **`index.ts`** — the dialog itself: opening/closing, config apply, custom-font
  loading, and the tab orchestration (General / Reading / Editor / Colors /
  Shortcuts / About).
- **`controls.ts`** — the generic custom form controls (custom selects,
  segmented toggles, number steppers) and the dialog focus trap.
- **`fonts.ts`** — the dynamic font dropdown on the Reading tab.
- **`palette.ts`** — color-palette data plus the pure `effectivePalette` /
  `effectiveBgColor` helpers and the body appliers.
- **`updates.ts`** — the update check and in-app install pipeline on the About
  tab, driving its progress UI from `update-progress` events.

**`ui/`** — chrome and view modules.

- **`tabs.ts`** — the tab bar, tab switching, file load/reload, zoom, overflow
  scrolling, anchor-click handling, and content mounting.
- **`folder.ts`** — the sidebar folder tree, name filter, divider resize, and
  the `syncWatcher` that pushes the watched-path set to the backend.
- **`outline.ts`** — the document outline sidebar (heading list, jump-to). In
  edit mode the same toolbar button is repurposed as the preview toggle.
- **`contextmenu.ts`** — context-aware right-click menus for the tree and tab
  bar (the default webview menu is suppressed).
- **`shortcuts-display.ts`** — renders the shortcut chips in the popover,
  welcome screen, and tooltips from `state.bindings`.
- **`toast.ts`** — bottom-right toast notifications with an optional per-call
  `lifetimeMs` for messages that need to linger.
- **`window-size.ts`** — the on-launch geometry clamp, the display-scaled
  minimum size (`max(screen/4, 480×270)`, capped to the available work area),
  and the responsive-layout logic: the two-stage toolbar collapse, the
  `body.narrow` drawer mode below 720 px, and the invisible edge/corner resize
  handles.

## Key lifecycles

### Config

`Config` (`config.rs`) is serialized as TOML in the platform config dir
(`%APPDATA%\oxidemd\OxideMD\config` on Windows, `~/.config/oxidemd` on Linux,
`~/Library/Application Support/com.oxidemd.OxideMD` on macOS), resolved via the
`directories` crate from the `APP_QUALIFIER` / `APP_ORGANIZATION` / `APP_NAME`
triple. `load_config` falls back to `Config::default()` on any read or parse
error. The struct is `#[serde(default)]`, so a file written by an older version
backfills any newly added field from its default. For schema changes that
*can't* be expressed as a new default (renamed keys, reinterpreted values), bump
`CURRENT_CONFIG_VERSION` and add a step to `migrate_config`; it runs once on
load when the stored `config_version` is behind, then re-saves. The frontend
fetches the whole struct once at init (`state.config = await
invoke('get_config')`) and `save_config_cmd` persists it back. Some settings
must reach the renderer immediately: the soft-break flag is mirrored into the
`PRESERVE_LINE_BREAKS` atomic in `markdown.rs` (seeded in `lib.rs` setup,
updated by `save_config_cmd`) so live preview and reopened files reflect a
change without a restart.

### Draft / autosave

`core/draft-store.ts` keeps unsaved editor buffers in `localStorage`, keyed by
absolute file path. `editor/editor.ts` debounces a `writeDraft` per input; a
successful save clears the draft. Each draft also records `diskHashAtWrite` —
the `file_sha256` of the file at write time. On reopening a file that has a
draft, `ui/tabs.ts` compares that stamp to the live disk hash; a mismatch means
the file changed externally, so the user is prompted before a stale draft can
clobber it.

### File watching

`watcher.rs` holds one recursive `notify` watcher behind a mutex.
`ui/folder.ts`'s `syncWatcher` collects the union of open file paths and the
open folder root and calls `watch_paths`, which atomically drops the old watcher
and builds a new one. Raw `notify` fires bursts (one save is several events), so
the watcher applies a per-path leading-edge debounce before emitting
`fs-changed`; the frontend coalesces per path again on its side.

### Keybinding registry

`core/keybindings.ts` defines `ACTIONS` (every command id, its default
accelerator, and metadata). `effectiveBindings` merges the user's sparse config
overrides over those defaults, so actions added in an update apply automatically
without rewriting config. Modules call `registerHandler(id, fn)` to bind
behavior; `dispatchKey` matches a `KeyboardEvent` against the active bindings
and invokes the handler; `runAction(id)` invokes one directly. Toolbar buttons
funnel through the same handlers, so the toolbar, the welcome-screen shortcuts,
and keyboard accelerators all share one code path.

### Logging

`lib.rs` initializes `tauri-plugin-log` at startup with a date-stamped file
target (`OxideMD-YYYY-MM-DD.log`) in the OS app log dir (`~/.local/state` on
Linux, `%LOCALAPPDATA%` on Windows, `~/Library/Logs` on macOS), plus a stdout
target gated to `cfg(debug_assertions)` so release builds stay quiet. Rotation
is by size (5 MB) with `KeepAll`, so history survives for incident forensics. On
the frontend, `core/logger.ts` invokes `plugin:log|log` so its `logError` /
`logWarn` / `logInfo` calls land in the same file as the Rust-side
`log::error!` / `log::warn!`. The module's import side effect installs
`window.onerror` and `unhandledrejection` listeners, so uncaught JS errors are
captured without each call site remembering to wrap.

### Updates

`check_for_updates` returns the available version and release-notes body.
`download_and_install_update` does the whole flow in one command: it re-checks,
calls `download_and_install` on the resulting `Update` handle, and finishes with
`app.restart()` (which diverges). During the download, the closure passed to the
plugin emits `update-progress` events with running byte counters so the settings
panel can drive its progress bar. On Linux without `APPIMAGE` set (RPM/DEB
installs need root to replace `/usr/bin/oxidemd`) we return
`UPDATE_UNSUPPORTED_PACKAGE`, and the frontend falls back to opening the GitHub
releases page.

### Version-mismatch detection

Linux RPM/DEB upgrades don't kill the running process (`dpkg`/`dnf` just swap
files on disk), and AppImage / Windows-portable / macOS drag-replace have the
same problem. With `tauri-plugin-single-instance` active, the user's "relaunch"
then just refocuses the stale in-memory process. Two mechanisms guard against
this:

- **Post-install scriptlet** — `src-tauri/scripts/post-install.sh` runs
  `pkill -x oxidemd` after the package manager writes the new binary, so the
  next launch is guaranteed to be the new process. Wired into RPM and DEB via
  `bundle.linux.{deb,rpm}.postInstallScript` in `tauri.conf.json`.
- **Version stamp** — every launch writes `env!("CARGO_PKG_VERSION")` to
  `<data_dir>/.running_version` *before* the single-instance plugin can bounce
  it. When a freshly launched second instance triggers the callback in the
  surviving original, that callback reads the file: if the value doesn't match
  its own version, it emits `version-mismatch` and the frontend shows a
  long-lived toast asking the user to relaunch.

### `--reset-all` flag

`oxidemd --reset-all` prints what would be deleted and exits; `--reset-all
--yes` deletes the OxideMD config dir, data dir (including webview storage,
drafts, and `.running_version`), and cache dir. It runs in `lib.rs` before any
plugin opens handles in those directories. This is last-resort recovery for
users whose state is in a shape we can't reason about — the routine escape hatch
is "Reset settings" in the Settings dialog.

### Rendering

`markdown.rs::render` turns Markdown source into an HTML **string** on the Rust
side using pulldown-cmark, with fenced code blocks highlighted by `highlight.rs`
(syntect). Raw HTML in the source is escaped, not executed. Local image paths
are emitted as `data-oxide-src` attributes; the frontend rewrites them to
`asset://` URLs via `convertFileSrc` when it mounts the HTML into the content
area. In read mode the HTML comes from `open_file` / `save_file`; in edit mode
the live preview pane re-renders on a debounce by calling `render_preview` with
the current editor buffer.
