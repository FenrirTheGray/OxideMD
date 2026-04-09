# OxideMD

A lightweight, read-only Markdown viewer for Windows, written in Rust using [Tauri v2](https://tauri.app/). Inspired by [ViewMD](https://github.com/rabfulton/ViewMD).

![OxideMD screenshot](media/oxidemd.png)

## Features

- **Full Markdown rendering** — headings, bold, italic, strikethrough, inline code, code blocks, blockquotes, ordered and unordered lists, tables, horizontal rules, links, and local images
- **Syntax highlighting** — powered by [syntect](https://github.com/trishume/syntect) with support for hundreds of languages
- **Tabs** — open multiple files in parallel; each tab has independent scroll and zoom state
- **Search** — `Ctrl+F` with match highlighting, next/previous navigation, match counter, and case-sensitive toggle
- **Theming** — dark, light, and system themes (Atom One Dark / Atom One Light) with configurable accent colors for H1/H2/H3 headings and list bullets
- **Settings** — persistent configuration (font family, font size, colors, theme) saved to `%APPDATA%\OxideMD\config.toml`
- **Drag and drop** — drag one or more `.md` files onto the window to open them
- **Multi-file open** — select multiple files at once from the open dialog
- **CLI support** — pass a file path as an argument: `oxidemd.exe path\to\file.md`
- **Custom title bar** — frameless window with integrated minimize/maximize/close controls
- **Window geometry** — size and maximized state are restored between sessions
- **Tiny footprint** — no Electron, no bundled browser; uses the Edge WebView2 runtime already present on Windows 10/11

## Keyboard Shortcuts

| Shortcut         | Action                        |
| ---------------- | ----------------------------- |
| `Ctrl+O`         | Open file(s)                  |
| `Ctrl+W`         | Close current tab             |
| `Ctrl+Tab`       | Switch to next tab            |
| `Ctrl+Shift+Tab` | Switch to previous tab        |
| `Ctrl+R`         | Reload current file           |
| `Ctrl+F`         | Open search                   |
| `Enter`          | Next search match             |
| `Shift+Enter`    | Previous search match         |
| `Esc`            | Close search / close settings |
| `Ctrl++`         | Zoom in                       |
| `Ctrl+-`         | Zoom out                      |
| `Ctrl+0`         | Reset zoom                    |
| `Home`           | Scroll to top                 |

## Building from Source

### Prerequisites

- [Rust](https://rustup.rs/) (stable, MSVC toolchain)
- Microsoft C++ Build Tools
- Edge WebView2 (included with Windows 10 1803+ / Windows 11)

### Install Tauri CLI

```powershell
cargo install tauri-cli --version "^2" --locked
```

### Run in development mode

```powershell
cd src-tauri
cargo tauri dev
```

### Build installer

```powershell
cd src-tauri
cargo tauri build
```

Installers are output to:

```
src-tauri\target\release\bundle\msi\OxideMD_x.x.x_x64_en-US.msi
src-tauri\target\release\bundle\nsis\OxideMD_x.x.x_x64-setup.exe
```

## Project Structure

```
OxideMD/
├── frontend/               # WebView frontend (HTML/CSS/JS)
│   ├── index.html          # App shell: toolbar, search bar, content area, settings modal
│   ├── style.css           # Dark/light/system themes, markdown element styles
│   └── app.js              # All UI logic: rendering, search, settings, shortcuts
├── src-tauri/              # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs         # Entry point
│   │   ├── lib.rs          # Tauri app setup, plugin registration, CLI arg handling
│   │   ├── commands.rs     # Tauri IPC commands exposed to the frontend
│   │   ├── markdown.rs     # pulldown-cmark → HTML conversion, local image embedding
│   │   ├── highlight.rs    # Syntax highlighting via syntect
│   │   ├── config.rs       # Settings struct, TOML load/save
│   │   └── util.rs         # HTML escaping helpers
│   ├── icons/              # App icons (all sizes)
│   └── tauri.conf.json     # Tauri configuration (window, bundle, file associations)
├── media/                  # Screenshots and assets for documentation
└── package.json            # Node dependencies for icon generation (@resvg/resvg-js)
```

## Technology Stack

| Component           | Library                                                            |
| ------------------- | ------------------------------------------------------------------ |
| App framework       | [Tauri v2](https://tauri.app/)                                     |
| Markdown parser     | [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark)      |
| Syntax highlighting | [syntect](https://github.com/trishume/syntect)                     |
| Configuration       | [serde](https://serde.rs/) + [toml](https://crates.io/crates/toml) |
| Config paths        | [directories](https://crates.io/crates/directories)                |

## Updating the Icon

To regenerate all icon sizes from a new source image:

```powershell
# Install the SVG renderer (first time only)
npm install

# Convert your icon.svg → icon.png using a tool of your choice, then:
cd src-tauri
cargo tauri icon ..\icon.png
```

## License

MIT
