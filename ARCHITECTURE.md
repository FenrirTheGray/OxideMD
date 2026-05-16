# Architecture

This document orients contributors on how OxideMD fits together. For a
file-by-file index see the Project Structure section of the [README](README.md);
this doc explains how the pieces interact.

## High-level shape

OxideMD is a [Tauri v2](https://tauri.app/) desktop app: a **Rust backend**
(`src-tauri/`) owns the OS-facing work — filesystem, dialogs, markdown
rendering, syntax highlighting, the native menu, the file watcher, updates —
and a **webview frontend** (`frontend/`) owns all UI and interaction. There is
no server and no bundled browser; the frontend runs in the platform's native
webview (WebView2 / WebKitGTK / WKWebView).

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
- **Updates** — `check_for_updates` queries the updater plugin.
- **Misc** — `get_cli_files` (argv paths to open on launch), `open_url`
  (hand an http/https/mailto URL to the OS, other schemes refused),
  `file_sha256` (hex digest, used for draft conflict detection).

### Events (backend → frontend)

- **`fs-changed`** — emitted by `watcher.rs` when a watched file/folder changes;
  carries the changed path. Leading-edge debounced per path (150 ms window).
- **`menu-action`** — emitted by `menu.rs` on a native menu click; carries the
  menu item's id, which is identical to a frontend action id.
- **`open-files-from-instance`** — emitted by the single-instance plugin in
  `lib.rs` when a second launch forwards its argv file paths to the running
  instance.
- **`prev-tab` / `next-tab` / `move-tab-left` / `move-tab-right`** — **Linux
  only**. WebKitGTK swallows some Ctrl+Tab combos before JS sees them, so
  `lib.rs` intercepts them at the GTK window level and re-emits them as events.

## Rust module map (`src-tauri/src/`)

- **`main.rs`** — thin entry point; calls `oxidemd_lib::run()`.
- **`lib.rs`** — Tauri builder: plugin registration (dialog, shell, updater,
  single-instance), the `generate_handler!` command list, `setup` (restore
  window geometry, seed the renderer, attach the native menu, the Linux GTK
  key interceptor).
- **`commands.rs`** — every `#[tauri::command]` plus their helper types and
  pure helpers (path canonicalization, the folder walk, the search scanner).
- **`config.rs`** — the `Config` struct, its `Default`, TOML load/save, the
  per-platform config path, and recent-files maintenance.
- **`markdown.rs`** — pulldown-cmark source → HTML string; heading slugs/ids,
  footnotes, local-image resolution, raw-HTML escaping, the soft-break atomic.
- **`highlight.rs`** — syntect-based fenced-code-block syntax highlighting.
- **`watcher.rs`** — single recursive `notify` watcher behind a mutex; per-path
  leading-edge coalesce; emits `fs-changed`.
- **`menu.rs`** — builds the native File/Edit/View/Tabs/Help menu; menu item
  ids mirror frontend action ids; emits `menu-action`.
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
- **`settings.js`** — the tabbed settings dialog (Reading / Editor / Colors /
  Shortcuts / About), config apply, custom-font loading, update check.
- **`shortcuts-display.js`** — renders shortcut chips in the popover, welcome
  screen, and tooltips from `state.bindings`.
- **`contextmenu.js`** — context-aware right-click menus for the sidebar tree
  and tab bar (the default webview menu is suppressed).
- **`print.js`** — print the active document to PDF via the webview's native
  print dialog, using a `@media print` stylesheet and the `#print-root` element.
- **`window-size.js`** — measures and sets the real minimum window size once,
  after layout settles.

## Key lifecycles

### Config

`Config` (`config.rs`) is serialized as TOML at the platform config dir
(`%APPDATA%\OxideMD` on Windows, `~/.config/oxidemd` on Linux,
`~/Library/Application Support/com.oxidemd.OxideMD` on macOS), resolved via the
`directories` crate. `load_config` falls back to `Config::default()` on any
read/parse error. The struct is `#[serde(default)]`, so a config file written
by an older version simply backfills any newly-added field from its default —
no migration code. The frontend fetches the whole struct once at init
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
the handler; `runAction(id)` invokes one directly. The toolbar buttons and the
native menu both funnel through the same handlers — toolbar clicks call
`runAction`, and a `menu-action` event (whose payload is an action id) is routed
to `runAction` in `app.js`.

### Rendering

`markdown.rs::render` turns markdown source into an HTML **string** on the Rust
side using pulldown-cmark, with fenced code blocks syntax-highlighted by
`highlight.rs` (syntect). Raw HTML in the source is escaped, not executed. Local
image paths are emitted as `data-oxide-src` attributes; the frontend rewrites
them to `asset://` URLs via `convertFileSrc` when it mounts the HTML into the
content area. In read mode the HTML comes from `open_file` / `save_file`; in
edit mode the live preview pane re-renders on a debounce by calling
`render_preview` with the current editor buffer.
