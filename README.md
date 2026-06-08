# OxideMD

A fast, native Markdown viewer and editor for Windows, Linux, and macOS — written in Rust on [Tauri v2](https://tauri.app/).

![OxideMD](media/oxidemd.png)

OxideMD reads, renders, and edits Markdown without bundling a browser. It draws into your platform's own webview — WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS — so it launches in well under a second and stays light on disk and memory. Drop a `.md` file on the window, press `Ctrl+E` to edit, `Ctrl+S` to save.

## Features

**Reading**

- CommonMark rendering: headings, tables, task lists, blockquotes, footnotes, fenced code, and local images
- Syntax highlighting for hundreds of languages via [syntect](https://github.com/trishume/syntect)
- Adjustable reading width (480–1400 px) and line height, plus an optional "preserve line breaks" mode
- In-document search with highlighting, match navigation, and a case-sensitivity toggle
- Print to PDF through the OS print dialog — light-on-white for legibility, or matched to your theme

**Editing**

- A [CodeMirror 6](https://codemirror.net/) editor with Markdown-aware highlighting, toggled per tab
- Split view with a draggable divider and synchronized scrolling
- A formatting toolbar and rebindable shortcuts for bold, italic, strikethrough, inline code, headings, lists, links, images, and indentation
- Smart Enter that continues lists and blockquotes, and exits the block on a second press
- Themed find-and-replace inside the editor
- Per-file draft autosave with a recovery prompt — and a conflict warning if the file changed on disk

**Workspace**

- Tabs with independent scroll, zoom, and split-view state, reorderable by keyboard
- A folder sidebar with name filtering, expand/collapse-all, and live file watching that reloads externally edited tabs
- Project-wide content search across every Markdown file under the open folder
- A document outline popover for jumping between headings
- Right-click context menus on the tab strip and the folder tree
- Drag and drop `.md` files onto the window to open them; drop an image into the editor to insert it
- A responsive layout: on narrow windows the sidebars become overlay drawers and the toolbar folds its overflow into a "⋯" menu, so the app stays usable down to its minimum size

**Appearance**

- Atom One Dark, Atom One Light, and system themes
- Configurable accent colors for headings and list bullets
- Custom fonts — add a `.ttf`, `.otf`, `.woff`, or `.woff2` from settings, and it persists across sessions
- A frameless window with integrated controls and full edge and corner resizing

**Under the hood**

- Rebindable shortcuts with conflict detection
- An in-app updater for Windows (NSIS/MSI), macOS (`.app`), and Linux AppImage; RPM and DEB users get a one-click link to the release page
- A date-stamped log file per launch in the OS log directory, capturing both Rust and frontend errors
- `oxidemd path/to/file.md` opens files at launch; `oxidemd --reset-all --yes` wipes all state for a clean recovery
- Config stored per platform: `%APPDATA%\oxidemd\OxideMD\config` (Windows), `~/.config/oxidemd` (Linux), `~/Library/Application Support/com.oxidemd.OxideMD` (macOS)

## Install

Prebuilt installers are attached to every [release](https://github.com/FenrirTheGray/OxideMD/releases).

| Platform | Formats                                                           |
| -------- | ----------------------------------------------------------------- |
| Windows  | `.msi`, `.exe` (NSIS)                                             |
| macOS    | `.dmg` (Apple Silicon and Intel)                                  |
| Linux    | apt / dnf repository (auto-updating), `.AppImage`, `.deb`, `.rpm` |
| Arch     | `.pkg.tar.zst` (Arch / Omarchy / EndeavourOS / Manjaro)           |

### Linux (apt / dnf) — recommended

Install from the OxideMD package repository (x86-64) to get updates through your
package manager. One-time setup commands are on the
[install page](https://fenrirthegray.github.io/OxideMD/):

- **Debian / Ubuntu** — add the apt repo, then `sudo apt install oxide-md`
- **Fedora / RHEL** — add the dnf repo, then `sudo dnf install oxide-md`

Afterward OxideMD updates with the rest of the system (`sudo apt upgrade` /
`sudo dnf upgrade`). The loose installers above remain available for a one-off
manual install (those don't auto-update).

### Arch-based

On Arch-based systems, grab `oxidemd-bin-<version>-1-x86_64.pkg.tar.zst` from the [latest release](https://github.com/FenrirTheGray/OxideMD/releases/latest) and install it:

```bash
sudo pacman -U ./oxidemd-bin-<version>-1-x86_64.pkg.tar.zst
```

You can also build from the PKGBUILDs in [`packaging/aur/`](packaging/aur/README.md): `oxidemd` builds from source, `oxidemd-bin` repackages the prebuilt binary.

## Keyboard shortcuts

> On macOS, read `Ctrl` as `Cmd`. Every shortcut below is rebindable from **Settings → Shortcuts**.

| Shortcut                 | Action                           |
| ------------------------ | -------------------------------- |
| `Ctrl+N`                 | New file                         |
| `Ctrl+O`                 | Open file(s)                     |
| `Ctrl+S`                 | Save                             |
| `Ctrl+W`                 | Close tab                        |
| `Ctrl+E`                 | Toggle edit mode                 |
| `Ctrl+F`                 | Search / find                    |
| `Ctrl+P`                 | Print to PDF                     |
| `Ctrl+R`                 | Reload file                      |
| `Ctrl+Tab` / `Shift+Tab` | Next / previous tab              |
| `Ctrl+Shift+←` / `→`     | Move tab                         |
| `Ctrl++` / `-` / `0`     | Zoom in / out / reset            |
| `Ctrl+B` / `I` / `K`     | Bold / italic / link (edit mode) |
| `Enter` / `Shift+Enter`  | Next / previous search match     |
| `Esc`                    | Close search or settings         |

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

**Windows:** the MSVC toolchain and Microsoft C++ Build Tools. WebView2 ships with Windows 10 1803+ and Windows 11.

**macOS:** `xcode-select --install`.

Then install dependencies and start the dev server:

```bash
cargo install tauri-cli --version "^2" --locked
npm install
cargo tauri dev          # dev run; auto-builds the frontend via esbuild
```

Before committing, run the frontend checks — `esbuild` strips TypeScript types but never checks them, so `tsc` is the safety net:

```bash
npm run typecheck        # type-check the frontend
npm test                 # run the frontend unit tests
```

Produce installers with:

```bash
cargo tauri build        # outputs to src-tauri/target/release/bundle/
```

> On Arch-based systems, building the AppImage needs `NO_STRIP=true cargo tauri build` — the bundled `linuxdeploy` can't strip Arch's modern `.relr.dyn` ELF sections. The `.deb` and `.rpm` targets are unaffected. For a native Arch package, see [`packaging/aur/`](packaging/aur/README.md).

## Documentation

Deeper documentation lives in [`docs/`](docs/README.md):

- [Architecture](docs/ARCHITECTURE.md) — how the Rust backend and TypeScript frontend split work and talk over IPC
- [Contributing](docs/CONTRIBUTING.md) — dev setup and the pull-request workflow
- [Code Style](docs/CODE_STYLE.md) — Rust and TypeScript conventions
- [Commit Style](docs/COMMIT_STYLE.md) — how to write commit messages
- [GitHub Tags & Releases](docs/GITHUB_TAGS.md) — versioning and the release process

## Stack

[Tauri v2](https://tauri.app/) · [CodeMirror 6](https://codemirror.net/) · [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark) · [syntect](https://github.com/trishume/syntect) · [esbuild](https://esbuild.github.io/)

## License

MIT
