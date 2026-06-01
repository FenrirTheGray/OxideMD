# OxideMD

A lightweight, cross-platform Markdown viewer and editor written in Rust using [Tauri v2](https://tauri.app/). Runs on Windows, Linux, and macOS. Inspired by [ViewMD](https://github.com/rabfulton/ViewMD).

![OxideMD screenshot](media/oxidemd.png)

## Features

- **Full Markdown rendering** — headings, bold, italic, strikethrough, inline code, code blocks, blockquotes, ordered and unordered lists, tables, horizontal rules, links, and local images
- **Syntax highlighting** — powered by [syntect](https://github.com/trishume/syntect) with support for hundreds of languages
- **Edit mode** — [CodeMirror 6](https://codemirror.net/) editor with syntax-aware Markdown highlighting; toggle per tab between read and edit mode
- **Create new files** — make a new Markdown file from the toolbar, `Ctrl+N`, the welcome screen, or the folder tree's right-click menu; the location is picked with the native save dialog and the file opens straight into edit mode
- **Print to PDF** — print the rendered document through the platform's native print dialog (Save as PDF); a "Printer Friendly PDFs" setting prints light-on-white for readability, or turn it off to match the app's current theme exactly
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
- **Settings** — tabbed dialog (General / Reading / Editor / Colors / Shortcuts / About) with persistent configuration saved per-platform (`%APPDATA%\oxidemd\OxideMD\config` on Windows, `~/.config/oxidemd` on Linux, `~/Library/Application Support/com.oxidemd.OxideMD` on macOS)
- **Reading layout** — configurable line height (1.0–2.4) and reading width (480–1400 px) that scales with zoom; an optional "Preserve line breaks" mode renders every single newline as a line break instead of CommonMark soft-wrapping
- **Folder browser** — open a directory to view its contents in a sidebar tree; click files to open them in tabs; expand-all / collapse-all toolbar buttons; case-insensitive filename filter that auto-expands matching folders and highlights matched characters; drag the divider to resize, or double-click it to fit the widest row (capped at 50% of the window)
- **Right-click context menus** — contextual menus for the sidebar tree and tab bar
- **Live file watching** — opened files and folders are monitored for changes; tabs automatically reload when modified externally
- **Tab overflow scrolling** — left/right chevron buttons appear in the toolbar when the tab strip overflows
- **Drag and drop** — drag one or more `.md` files onto the window to open them
- **Multi-file open** — select multiple files at once from the open dialog
- **Custom title bar** — frameless window with integrated minimize/maximize/close controls; thin edge and corner overlays give native resize cursors and click-and-drag resizing
- **In-app updates** — check from the settings panel; downloads, installs, and restarts on the new version for Windows NSIS/MSI, macOS `.app`, and Linux AppImage builds. RPM/DEB users (root-only install paths) get a one-click link to the GitHub release. A toast prompts you to restart if a new version was installed on disk but the running process is still the old one (common after `dnf upgrade` / `apt upgrade`)
- **Diagnostic logging** — one date-stamped log file per launch (`OxideMD-YYYY-MM-DD.log`) in the OS app log dir, capturing both Rust- and frontend-side errors plus uncaught exceptions. Useful when reporting issues
- **CLI flags** — `oxidemd path/to/file.md` to open files at launch; `oxidemd --reset-all --yes` to wipe all OxideMD state (settings, custom themes/fonts, drafts, recents, logs) for clean-state recovery
- **Tiny footprint** — no Electron, no bundled browser; uses the native webview on each platform (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS)

## Keyboard Shortcuts

> On macOS, use `Cmd` instead of `Ctrl`. All shortcuts are rebindable from Settings → Shortcuts.

| Shortcut              | Action                            |
| --------------------- | --------------------------------- |
| `Ctrl+N`              | New file                          |
| `Ctrl+O`              | Open file(s)                      |
| `Ctrl+W`              | Close current tab                 |
| `Ctrl+Tab`            | Switch to next tab                |
| `Ctrl+Shift+Tab`      | Switch to previous tab            |
| `Ctrl+R`              | Reload current file               |
| `Ctrl+Shift+Left`     | Move tab left                     |
| `Ctrl+Shift+Right`    | Move tab right                    |
| `Ctrl+E`              | Toggle edit mode                  |
| `Ctrl+S`              | Save file                         |
| `Ctrl+P`              | Print to PDF                      |
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

## Installing

Prebuilt installers for each tagged release are on the [Releases page](https://github.com/FenrirTheGray/OxideMD/releases):

| Platform | Download                          |
| -------- | --------------------------------- |
| Windows  | `.msi` or `.exe` (NSIS)           |
| macOS    | `.dmg` (Apple Silicon and Intel)  |
| Linux    | `.AppImage`, `.deb`, or `.rpm`    |

**Arch-based systems** (Arch, Omarchy, EndeavourOS, Manjaro): every release also attaches prebuilt `.pkg.tar.zst` packages. Download `oxidemd-bin-<version>-1-x86_64.pkg.tar.zst` from the [latest release](https://github.com/FenrirTheGray/OxideMD/releases/latest) and install it:

```bash
sudo pacman -U ./oxidemd-bin-<version>-1-x86_64.pkg.tar.zst
```

Or build from the PKGBUILDs in [`packaging/aur/`](packaging/aur/README.md) with `makepkg -si` — `oxidemd` builds from source, `oxidemd-bin` repackages the prebuilt binary.

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

**Linux (Arch / Omarchy / EndeavourOS / Manjaro):**
```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl librsvg
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

> On Arch-based systems, building the `.AppImage` needs `NO_STRIP=true cargo tauri build` — the bundled `linuxdeploy` can't strip Arch's modern `.relr.dyn` ELF sections. The `.deb`/`.rpm` targets are unaffected. To produce a native Arch package instead, see [`packaging/aur/`](packaging/aur/README.md).

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
│   ├── search-project.js     # Project-wide content search panel in the sidebar
│   ├── outline.js            # Document outline sidebar (heading list, jump-to)
│   ├── settings.js           # Settings dialog (fonts, colors, shortcuts, update check)
│   ├── shortcuts-display.js  # Shortcuts tab UI: list actions, capture new bindings
│   ├── contextmenu.js        # Right-click context menus for sidebar and tabs
│   ├── print.js              # Print the active document to PDF via the native print dialog
│   ├── window-size.js        # Min-size cap, screen-clamp, and window-edge resize handles
│   ├── toast.js              # Bottom-right toast notifications (success / error)
│   └── logger.js             # Frontend logger that pipes into the date-stamped log file
├── src-tauri/                # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs           # Entry point
│   │   ├── lib.rs            # Tauri builder, plugin registration, --reset-all + version-stamp
│   │   ├── commands.rs       # Tauri IPC commands (open, save, render, config, fonts, updater…)
│   │   ├── markdown.rs       # pulldown-cmark → HTML conversion, local image embedding
│   │   ├── highlight.rs      # Syntax highlighting via syntect
│   │   ├── config.rs         # Config struct, TOML load/save, schema migrations, path triple
│   │   ├── watcher.rs        # File system watcher (notify)
│   │   └── util.rs           # HTML escaping helpers
│   ├── scripts/
│   │   └── post-install.sh   # RPM/DEB postinstall: kills any running oxidemd before relaunch
│   ├── icons/                # App icons (all sizes)
│   ├── oxidemd.desktop       # Desktop template for Linux deb/rpm (MIME types, categories)
│   └── tauri.conf.json       # Tauri configuration (window, bundle, file associations)
├── packaging/aur/            # Arch Linux PKGBUILDs (oxidemd, oxidemd-bin) + release build scripts
├── media/                    # Screenshots and assets for documentation
├── CHANGELOG.md              # Version history
└── package.json              # Node dependencies (CodeMirror 6, esbuild)
```

For how these pieces fit together — the IPC boundary, module responsibilities, and key lifecycles — see [ARCHITECTURE.md](ARCHITECTURE.md).

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
