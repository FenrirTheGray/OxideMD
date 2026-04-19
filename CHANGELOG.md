# Changelog

All notable changes to OxideMD will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-04-19

### Added

- Folder browser with sidebar tree UI to navigate and open files in a directory
- Live file watching to automatically reload Markdown files when they are modified on disk
- Local images are now served securely via the Tauri asset protocol
- Link delegation and markdown link hover effects

### Changed

- Complete frontend architecture rewrite: migrated from a monolithic `app.js` to modular ES components (`state.js`, `folder.js`, `tabs.js`, `search.js`, `settings.js`)
- Rewritten search functionality for improved modularity
- Hardened Markdown renderer and CLI path handling

### Fixed

- Resolved module-load syntax errors caused by duplicate declarations during refactoring

## [1.6.2] - 2026-04-19

### Fixed

- macOS clients can now receive updates: the `app` bundle target is now enabled so release builds produce `OxideMD.app.tar.gz` and its signature, populating `darwin-aarch64` and `darwin-x86_64` entries in `latest.json`
- "Reset defaults" button in the settings footer now renders with a border, matching the visual style of the Cancel and Save buttons

## [1.6.1] - 2026-04-18

### Fixed

- Welcome screen "Browse" button became unresponsive after opening and closing a file (the button node was destroyed when the welcome view re-rendered, orphaning its click listener); now handled via event delegation
- About tab icon failed to display in release bundles because `frontend/icon.png` was matched by a root-level `.gitignore` rule and excluded from version control
- "Check for updates" never returned a result because release bundles did not include the updater manifest; enabled `createUpdaterArtifacts` so future releases publish `latest.json` and `.sig` files

## [1.6.0] - 2026-04-18

### Added

- Line height setting: adjustable from 1.0 to 2.4 in 0.1 increments (default 1.8)
- Reading width setting: adjustable content column width from 480 to 1400 pixels in 20 pixel steps (default 800), scales with zoom
- Tabbed settings dialog with three categories: Reading (font, size, line height, reading width), Colors (theme, heading colors, bullets), and About (version, update check, repository link)
- Arrow key navigation between settings tabs
- Color picker cards with live hex value display and a preview card that reflects heading and bullet color choices in real time
- Redesigned welcome screen with OxideMD wordmark, hero "Open a Markdown file" button, and a full keyboard shortcut reference
- Inline update status panel in the About tab with distinct states for "update available" (with Download button), "up to date", and "error", replacing the previous browser confirm/alert dialogs

### Changed

- Minimum window size increased from 600x400 to 640x480 to accommodate the new settings layout
- Zoom controls are now disabled when no tab is open, matching the other toolbar buttons
- Custom number inputs now support configurable min/max/step, decimal precision, and unit suffix via `data-*` attributes
- "Reset to defaults" in settings now only resets fields on the currently active tab, leaving other tabs untouched

## [1.5.0] - 2026-04-16

### Added

- In-app update checker: "Check for updates" button in settings queries the GitHub releases endpoint and prompts to download when a new version is available
- Current version label displayed in the settings panel
- Tauri updater plugin (`tauri-plugin-updater`) integrated with a public signing key for verified update payloads

### Changed

- GitHub Actions release workflow now passes `APPLE_SIGNING_IDENTITY`, `TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to the Tauri build step for update artifact signing
- `updater:default` capability added to the default permissions set

### Fixed

- macOS aarch64 (Apple Silicon) builds now use ad-hoc code signing, fixing the "app is damaged and can't be opened" error that prevented native ARM builds from launching
- `StartupWMClass` in desktop entry corrected from `OxideMD` to `oxidemd` to match the binary name, fixing taskbar icon grouping on Linux

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
