# OxideMD

A lightweight, cross-platform Markdown viewer and editor written in Rust using [Tauri v2](https://tauri.app/). Runs on Windows, Linux, and macOS. Inspired by [ViewMD](https://github.com/rabfulton/ViewMD).

![OxideMD screenshot](media/oxidemd.png)

## Features

- **Full Markdown rendering** — headings, bold, italic, strikethrough, inline code, code blocks, blockquotes, ordered and unordered lists, tables, horizontal rules, links, and local images
- **Syntax highlighting** — powered by [syntect](https://github.com/trishume/syntect) with support for hundreds of languages
- **Edit mode** — [CodeMirror 6](https://codemirror.net/) editor with syntax-aware Markdown highlighting; toggle per tab between read and edit mode
- **Split view** — side-by-side editor and live HTML preview with a draggable divider; layout state saved per tab
- **Formatting toolbar** — bold, italic, strikethrough, inline code, H1–H3, ordered list, unordered list, task list, link, image, indent, and outdent
- **Smart Enter** — continues list and blockquote markers on Enter; double-Enter exits the block
- **Find / replace** — themed find/replace panel inside the editor; separate in-document search in read mode
- **Draft autosave** — unsaved edits are persisted to `localStorage` per file; recovery prompt on reopen
- **Document outline** — popover listing all headings; click to jump in editor or preview
- **Tabs** — open multiple files in parallel; each tab has independent scroll, zoom, and editor/preview layout; reorder tabs with keyboard shortcuts
- **Search** — `Ctrl+F` toggles search with match highlighting, next/previous navigation, match counter, and case-sensitive toggle
- **Theming** — dark, light, and system themes (Atom One Dark / Atom One Light) with configurable accent colors for H1/H2/H3 headings and list bullets
- **Custom fonts** — install `.ttf`/`.otf`/`.woff`/`.woff2` font files from the settings font dropdown; fonts are stored in the OxideMD config folder and persist across sessions
- **Rebindable shortcuts** — all actions are configurable from Settings → Shortcuts with conflict detection and a per-action key-capture flow
- **Settings** — tabbed dialog (Reading / Colors / Shortcuts / About) with persistent configuration saved per-platform (`%APPDATA%\OxideMD` on Windows, `~/.config/oxidemd` on Linux, `~/Library/Application Support/com.oxidemd.OxideMD` on macOS)
- **Reading layout** — configurable line height (1.0–2.4) and reading width (480–1400 px) that scales with zoom
- **Folder browser** — open a directory to view its contents in a sidebar tree; click files to open them in tabs; expand-all / collapse-all toolbar buttons; case-insensitive filename filter that auto-expands matching folders and highlights matched characters
- **Right-click context menus** — contextual menus for the sidebar tree and tab bar
- **Live file watching** — opened files and folders are monitored for changes; tabs automatically reload when modified externally
- **Tab overflow scrolling** — left/right chevron buttons appear in the toolbar when the tab strip overflows
- **Drag and drop** — drag one or more `.md` files onto the window to open them
- **Multi-file open** — select multiple files at once from the open dialog
- **CLI support** — pass a file path as an argument: `oxidemd path/to/file.md`
- **Custom title bar** — frameless window with integrated minimize/maximize/close controls
- **Window geometry** — size, position, and maximized state are restored between sessions
- **Update checker** — check for new releases from the settings panel; prompts to download when an update is available
- **Tiny footprint** — no Electron, no bundled browser; uses the native webview on each platform (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS)

## Keyboard Shortcuts

> On macOS, use `Cmd` instead of `Ctrl`. All shortcuts are rebindable from Settings → Shortcuts.

| Shortcut              | Action                            |
| --------------------- | --------------------------------- |
| `Ctrl+O`              | Open file(s)                      |
| `Ctrl+W`              | Close current tab                 |
| `Ctrl+Tab`            | Switch to next tab                |
| `Ctrl+Shift+Tab`      | Switch to previous tab            |
| `Ctrl+R`              | Reload current file               |
| `Ctrl+Shift+Left`     | Move tab left                     |
| `Ctrl+Shift+Right`    | Move tab right                    |
| `Ctrl+E`              | Toggle edit mode                  |
| `Ctrl+S`              | Save file                         |
| `Ctrl+F`              | Toggle search (read) / find (edit)|
| `Enter`               | Next search match                 |
| `Shift+Enter`         | Previous search match             |
| `Esc`                 | Close search / close settings     |
| `Ctrl++`              | Zoom in                           |
| `Ctrl+-`              | Zoom out                          |
| `Ctrl+0`              | Reset zoom                        |
| `Home`                | Scroll to top                     |
| **Edit mode**         |                                   |
| `Ctrl+B`              | Bold                              |
| `Ctrl+I`              | Italic                            |
| `Ctrl+K`              | Insert link                       |

## Building from Source

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (for bundling the frontend with esbuild)

**Windows:**
- MSVC toolchain
- Microsoft C++ Build Tools
- Edge WebView2 (included with Windows 10 1803+ / Windows 11)

**Linux (Debian/Ubuntu):**
```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**macOS:**
- Xcode Command Line Tools: `xcode-select --install`

### Install Tauri CLI

```bash
cargo install tauri-cli --version "^2" --locked
```

### Install Node dependencies

```bash
npm install
```

### Run in development mode

```bash
cargo tauri dev
```

### Build installer

```bash
cargo tauri build
```

Installers are output to `src-tauri/target/release/bundle/`:

| Platform | Formats                      |
| -------- | ---------------------------- |
| Windows  | `.msi`, `.exe` (NSIS)        |
| Linux    | `.deb`, `.rpm`, `.AppImage`  |
| macOS    | `.dmg`                       |

## Project Structure

```
OxideMD/
├── .github/workflows/        # CI/CD (GitHub Actions release workflow)
├── frontend/                 # WebView frontend (HTML/CSS/JS)
│   ├── index.html            # App shell: toolbar, search bar, sidebar, content area, settings modal
│   ├── style.css             # Dark/light/system themes, markdown element styles, editor styles
│   ├── app.js                # Entry point: initialization and global keyboard shortcuts
│   ├── state.js              # Shared state and DOM references
│   ├── keybindings.js        # Sparse-override action registry; rebindable shortcut dispatch
│   ├── tabs.js               # Tab bar, tab switching, zoom, overflow scrolling
│   ├── editor.js             # CodeMirror 6 editor surface, split-view layout, scroll sync
│   ├── editor-format.js      # Formatting commands (bold, italic, lists, etc.) shared by toolbar and shortcuts
│   ├── draft-store.js        # Per-file localStorage draft autosave and recovery
│   ├── folder.js             # Sidebar folder tree, filter, file watching
│   ├── search.js             # In-document search (match highlighting, navigation)
│   ├── outline.js            # Document outline popover (heading list, jump-to)
│   ├── settings.js           # Settings dialog (fonts, colors, shortcuts, update check)
│   ├── shortcuts-display.js  # Shortcuts tab UI: list actions, capture new bindings
│   ├── contextmenu.js        # Right-click context menus for sidebar and tabs
│   └── window-size.js        # Persistent window size and position
├── src-tauri/                # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs           # Entry point
│   │   ├── lib.rs            # Tauri app setup, plugin registration, CLI arg handling
│   │   ├── commands.rs       # Tauri IPC commands (open, save, render, config, fonts, watch…)
│   │   ├── markdown.rs       # pulldown-cmark → HTML conversion, local image embedding
│   │   ├── highlight.rs      # Syntax highlighting via syntect
│   │   ├── config.rs         # Settings struct, TOML load/save, keybinding overrides
│   │   ├── watcher.rs        # File system watcher (notify)
│   │   └── util.rs           # HTML escaping helpers
│   ├── icons/                # App icons (all sizes)
│   ├── oxidemd.desktop       # Desktop template for Linux deb/rpm (MIME types, categories)
│   └── tauri.conf.json       # Tauri configuration (window, bundle, file associations)
├── media/                    # Screenshots and assets for documentation
├── CHANGELOG.md              # Version history
└── package.json              # Node dependencies (CodeMirror 6, esbuild)
```

## Technology Stack

| Component           | Library                                                            |
| ------------------- | ------------------------------------------------------------------ |
| App framework       | [Tauri v2](https://tauri.app/)                                     |
| Editor              | [CodeMirror 6](https://codemirror.net/)                            |
| Markdown parser     | [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark)      |
| Syntax highlighting | [syntect](https://github.com/trishume/syntect)                     |
| Configuration       | [serde](https://serde.rs/) + [toml](https://crates.io/crates/toml) |
| Config paths        | [directories](https://crates.io/crates/directories)                |
| JS bundler          | [esbuild](https://esbuild.github.io/)                              |

## License

MIT
