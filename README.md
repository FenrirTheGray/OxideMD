# OxideMD

A fast, native Markdown viewer and editor for Windows, Linux, and macOS — built in Rust on [Tauri v2](https://tauri.app/).

![OxideMD](media/oxidemd.png)

OxideMD opens, renders, and edits Markdown files without shipping a browser. It uses your platform's native webview (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS), starts in under a second, and leaves a small footprint on disk and in memory. Drop a `.md` file on the window, hit `Ctrl+E` to edit, `Ctrl+S` to save.

## Highlights

### Reading
- Full CommonMark rendering — headings, tables, task lists, blockquotes, code fences, and local images
- Syntax-highlighted code blocks across hundreds of languages via [syntect](https://github.com/trishume/syntect)
- Configurable reading width (480–1400 px) and line height; optional "Preserve line breaks" mode
- In-document search with match highlighting, navigation, and a case-sensitive toggle
- Print to PDF through the platform's native print dialog — light-on-white for readability, or theme-matched

### Editing
- [CodeMirror 6](https://codemirror.net/) editor with Markdown-aware highlighting; toggle per tab
- Split view with draggable divider and synchronized scrolling
- Formatting toolbar and rebindable shortcuts: bold, italic, strikethrough, inline code, headings, lists, links, images, indent
- Smart Enter continues lists and blockquotes; double-Enter exits the block
- Themed find/replace inside the editor
- Per-file draft autosave with a recovery prompt on reopen

### Workspace
- Tabs with independent scroll, zoom, and split-view state; keyboard-reorderable
- Folder sidebar with filename filter, expand/collapse-all, and live file watching that reloads externally modified tabs
- Project-wide content search
- Document outline popover for quick navigation
- Right-click context menus on the tab strip and folder tree
- Drag and drop `.md` files onto the window to open them

### Appearance
- Atom One Dark, Atom One Light, and system themes
- Configurable accent colors for headings and list bullets
- Custom fonts — drop in `.ttf`, `.otf`, `.woff`, or `.woff2` from settings; persists across sessions
- Frameless window with integrated controls and full edge/corner resizing

### Under the hood
- Rebindable shortcuts with conflict detection
- In-app updater for Windows NSIS/MSI, macOS `.app`, and Linux AppImage; RPM/DEB get a one-click link to the release
- Date-stamped log file per launch in the OS log directory, capturing Rust and frontend errors
- `oxidemd path/to/file.md` to open files at launch; `oxidemd --reset-all --yes` to wipe all state for clean recovery
- Config stored per-platform: `%APPDATA%\oxidemd\OxideMD\config` (Windows), `~/.config/oxidemd` (Linux), `~/Library/Application Support/com.oxidemd.OxideMD` (macOS)

## Install

Prebuilt installers ship with every release on the [Releases page](https://github.com/FenrirTheGray/OxideMD/releases).

| Platform | Formats |
| -------- | ------- |
| Windows  | `.msi`, `.exe` (NSIS) |
| macOS    | `.dmg` (Apple Silicon and Intel) |
| Linux    | `.AppImage`, `.deb`, `.rpm` |
| Arch     | `.pkg.tar.zst` (Arch / Omarchy / EndeavourOS / Manjaro) |

For Arch-based systems, download `oxidemd-bin-<version>-1-x86_64.pkg.tar.zst` from the [latest release](https://github.com/FenrirTheGray/OxideMD/releases/latest) and install it:

```bash
sudo pacman -U ./oxidemd-bin-<version>-1-x86_64.pkg.tar.zst
```

Or build from the PKGBUILDs in [`packaging/aur/`](packaging/aur/README.md): `oxidemd` builds from source, `oxidemd-bin` repackages the prebuilt binary.

## Keyboard shortcuts

> Use `Cmd` on macOS. Everything below is rebindable from **Settings → Shortcuts**.

| Shortcut                | Action                                |
| ----------------------- | ------------------------------------- |
| `Ctrl+N`                | New file                              |
| `Ctrl+O`                | Open file(s)                          |
| `Ctrl+S`                | Save                                  |
| `Ctrl+W`                | Close tab                             |
| `Ctrl+E`                | Toggle edit mode                      |
| `Ctrl+F`                | Search / find                         |
| `Ctrl+P`                | Print to PDF                          |
| `Ctrl+R`                | Reload file                           |
| `Ctrl+Tab` / `Shift+Tab` | Next / previous tab                  |
| `Ctrl+Shift+←` / `→`    | Move tab                              |
| `Ctrl++` / `-` / `0`    | Zoom in / out / reset                 |
| `Ctrl+B` / `I` / `K`    | Bold / italic / link (edit mode)      |
| `Enter` / `Shift+Enter` | Next / previous search match          |
| `Esc`                   | Close search or settings              |

## Build from source

You'll need [Rust](https://rustup.rs/) (stable) and [Node.js](https://nodejs.org/) for the frontend bundler.

**Linux (Debian/Ubuntu):**
```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
    libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**Linux (Arch):**
```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl librsvg
```

**Windows:** MSVC toolchain and Microsoft C++ Build Tools. WebView2 ships with Windows 10 1803+ and Windows 11.

**macOS:** `xcode-select --install`.

Then:

```bash
cargo install tauri-cli --version "^2" --locked
npm install
cargo tauri dev          # development run
cargo tauri build        # produce installers in src-tauri/target/release/bundle/
```

> On Arch-based systems, building the AppImage needs `NO_STRIP=true cargo tauri build` — the bundled `linuxdeploy` cannot strip Arch's modern `.relr.dyn` ELF sections. `.deb` and `.rpm` targets are unaffected. For a native Arch package, see [`packaging/aur/`](packaging/aur/README.md).

## Architecture

The codebase splits into a Rust backend (`src-tauri/`) and a vanilla-JS frontend (`frontend/`) communicating over Tauri's IPC bridge. For the module map, lifecycles, and IPC surface, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

[Tauri v2](https://tauri.app/) · [CodeMirror 6](https://codemirror.net/) · [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark) · [syntect](https://github.com/trishume/syntect) · [esbuild](https://esbuild.github.io/)

## License

MIT
