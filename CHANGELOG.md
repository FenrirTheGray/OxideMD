# Changelog

All notable changes to OxideMD will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [3.1.2] - 2026-04-25

### Added

- Settings now previews the chosen theme live: switching the theme dropdown flips the editor body class and re-resolves the code/note background swatches before Save, and reverts on Cancel

### Changed

- Toolbar mode toggle is now a single Edit button with a pressed state instead of swapping its label between Edit and View
- Code and note background defaults follow the active theme so switching to Light no longer leaves dark-on-dark text; values matching the other theme's default auto-adapt, while custom picks pass through unchanged
- Regenerated all platform app icons from updated source artwork

### Fixed

- Disabled webview devtools in release builds

## [3.1.1] - 2026-04-22

### Changed

- Rotated the Tauri updater signing key; the embedded public key in `tauri.conf.json` has been updated to match. Installs trusting the previous key cannot auto-update to this release and must be reinstalled manually once

## [3.1.0] - 2026-04-21

### Added

- Double-click the sidebar divider to fit its width to the longest tree row, capped at 50% of the current window width
- Tab scroll buttons now step exactly one tab at a time instead of a fixed viewport-relative chunk
- Tab scroll buttons stay mounted in a dimmed disabled state when at an edge rather than disappearing, and gained a bordered square frame for consistency with other toolbar controls

### Changed

- `#tab-area` now spans the entire empty toolbar width and doubles as a drag region so the titlebar can be grabbed from anywhere around the tabs

### Fixed

- Edit-view scroll sync no longer drifts upward on its own: the programmatic-scroll lock was released before the browser fired the mirrored event, so fractional-pixel rounding accumulated on each bounce; replaced with a per-event suppression set tied to the actual scroll event
- Custom titlebar drag on Linux restored — the `core:window:allow-start-dragging` capability was missing, so `data-tauri-drag-region` had no IPC path to start a window move on WebKitGTK

## [3.0.0] - 2026-04-20

### Added

- **Edit mode** — CodeMirror 6 editor surface replaces the previous textarea; toggle between read and edit mode per tab
- **Split view** — side-by-side editor and live HTML preview pane with a draggable divider; layout state (divider position, active pane) is saved per tab
- **Proportional scroll sync** — editor and preview scroll positions stay in sync as you type
- **Formatting toolbar** — bold, italic, strikethrough, inline code, H1–H3, ordered list, unordered list, task list, link, image, indent, and outdent; wired to a shared `editor-format` module so shortcuts and toolbar share one implementation
- **Smart Enter** — pressing Enter inside a list or blockquote continues the marker; double-Enter exits the block cleanly
- **Find/replace panel** — themed search-and-replace panel inside the editor matching the read-mode search bar
- **Document outline popover** — anchored to the toolbar; lists ATX and setext headings; click to jump to the heading in either the editor or the preview
- **Per-file draft autosave** — unsaved changes are written to `localStorage`; on reopen OxideMD prompts to recover the draft or discard it
- **Discard button** — reverts the editor buffer to the on-disk content with a confirmation prompt
- **Rebindable keyboard shortcuts** — all actions are registered in a sparse-override action registry; conflicts are detected; shortcuts can be rebound from Settings → Shortcuts with a per-action key-capture flow
- **Right-click context menu** — contextual menus for the sidebar tree (open, open in new tab) and tab bar (close, close others, close to the right)
- **Persistent window position** — window position is saved alongside window size and restored on next launch

### Changed

- Keybinding layer extracted from `app.js` into a dedicated `keybindings.js` module with a named action registry, making all shortcuts user-configurable
- Settings dialog gains a Shortcuts tab listing all actions and their current bindings
- `esbuild` wired into Tauri's `beforeDevCommand` and `beforeBuildCommand` so the JS bundle is always rebuilt before dev/release
- Backend gains `save_file` and `render_preview` commands; `OpenResult` now includes a `raw` field so the frontend can round-trip edits without re-reading disk
- Config extended with sparse keybinding overrides and additional theme color tokens

## [2.0.1] - 2026-04-19

### Added

- Sidebar filename filter: case-insensitive substring input above the tree; matching folders auto-expand and matched characters are highlighted in the label
- Sidebar "Expand all" and "Collapse all" buttons in the folder header
- Tab overflow scroll buttons (left/right chevrons) appear in the toolbar when the tab strip overflows

### Changed

- Folder scanner redesigned: flat discovery of every `.md` file first, then the tree is reconstructed from the collected paths. Removed the 12-level depth cap and the 5000 entries-per-folder cap; replaced with a single 500000 visited-entries safety cap so deep project trees are fully indexed

### Fixed

- Sidebar icons now render on Linux (`.deb` / WebKitGTK) builds: inline SVGs had no intrinsic size in WebKitGTK, so explicit `width`/`height` are now applied to the `.tree-twisty` and `.tree-icon` children

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
