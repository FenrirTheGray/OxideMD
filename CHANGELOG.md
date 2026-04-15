# Changelog

All notable changes to OxideMD will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.4.0] - 2026-04-16

### Added

- Custom font management: install `.ttf`, `.otf`, `.woff`, and `.woff2` font files via the settings font dropdown
- Fonts are stored in the OxideMD config folder (`fonts/` subdirectory) and persist across sessions
- Multiple custom fonts can be added and individually removed from the dropdown
- Confirmation dialog before removing a custom font (destructive action deletes the file from disk)
- Empty state hint ("No custom fonts installed") in the font dropdown for first-time discoverability
- Error feedback in the status bar when a custom font fails to load

### Changed

- Font dropdown is now fully dynamic: rebuilt on each settings open to reflect installed custom fonts
- Font select is excluded from the generic custom-select initializer and managed independently with event delegation
- Config struct uses `#[serde(default)]` for backward-compatible deserialization of existing config files
- Remove button for custom fonts sized to 22×22px minimum click target
- `base64` crate added as a dependency for encoding font data

## [1.3.2] - 2026-04-14

### Fixed

- `.deb` package now registers MIME type (`text/markdown`) so Ubuntu shows OxideMD in "Open with..." for Markdown files
- Added custom desktop template with proper `MimeType`, `Exec %F`, and `Categories` fields for deb builds

### Changed

- Renamed binary from generic `app` to `oxidemd` to avoid package conflicts and improve process identification
- Icons in deb/rpm packages now install as `oxidemd.png` instead of `app.png`

## [1.3.1] - 2026-04-10

### Fixed

- Ctrl+Tab (next tab) now works on Linux via GTK key interception
- Ctrl+Shift+Left/Right (tab reordering) now works on Windows and macOS via frontend key handlers

## [1.3.0] - 2026-04-10

### Added

- Ctrl+Tab / Ctrl+Shift+Tab keyboard shortcuts for switching between tabs
- Ctrl+Shift+Left/Right keyboard shortcuts for reordering tabs (Linux: intercepted at GTK layer to bypass WebKitGTK)
- Backdrop blur overlay when native file picker is open (matches settings overlay style)
- Overlay exclusivity: only one overlay (file picker, search, settings) can be open at a time
- Search button now toggles (click or Ctrl+F again to close), with active state styling

### Changed

- File dialog is now modal (attached to parent window via `set_parent`)
- Added `gtk` and `gdk` as Linux-specific dependencies for native key event interception

## [1.2.0] - 2026-04-10

### Added

- Custom select dropdown and number stepper controls in settings (replaces native form elements)
- Dedicated toolbar drag region spacer for reliable window dragging
- Window border for better visual definition

### Changed

- Tauri commands (`open_file`, `pick_file`, `open_url`) are now async with `spawn_blocking` to avoid blocking the main thread
- Minimum window size increased to 600×400
- GitHub Actions bumped to v6 (`actions/checkout`, `actions/setup-node`)
- Added `color-scheme` CSS property to dark/light themes for native scrollbar styling

## [1.1.0] - 2026-04-10

### Added

- Linux support: `.deb`, `.rpm`, and `.AppImage` bundle targets
- macOS support: `.dmg` bundle target
- Keyboard shortcuts now work with `Cmd` on macOS
- Platform-aware tooltip labels (show `Cmd` on macOS, `Ctrl` elsewhere)
- GitHub Actions workflow for automated multi-platform releases

### Changed

- Default font changed from Segoe UI to system default for cross-platform compatibility
- Font dropdown now uses cross-platform fonts (System Default, Georgia, Consolas, Arial, Verdana, Times New Roman)

## [1.0.0] - 2026-04-09

### Added

- Full Markdown rendering: headings, bold, italic, strikethrough, inline code, code blocks, blockquotes, lists, tables, horizontal rules, links, and local images
- Syntax highlighting powered by syntect
- Tabbed interface with independent scroll and zoom per tab
- In-document search with match highlighting, navigation, match counter, and case-sensitive toggle
- Dark, light, and system themes (Atom One Dark / Atom One Light)
- Configurable accent colors for H1/H2/H3 headings and list bullets
- Persistent settings (font family, font size, colors, theme) saved to config file
- Drag-and-drop support for `.md` files
- Multi-file open from file dialog
- CLI support: pass a file path as an argument
- Custom frameless title bar with integrated window controls
- Window size and maximized state restored between sessions
- Zoom controls (50%--200%)
