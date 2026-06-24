# Changelog

All notable changes to OxideMD will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [4.8.1] - 2026-06-24

### Changed

- The Settings, unsaved-changes, and error dialogs now use the platform's native modal dialog, for more reliable focus trapping, background inerting, and Escape handling across the supported webviews
- Internal cleanup with no behavior change: shared helpers (HTML escaping, custom-select keyboard handling, path and timing utilities) are now deduplicated into single copies, dead code was removed, and the syntax highlighter holds just the one theme it renders with

## [4.8.0] - 2026-06-12

### Fixed

- The window title updates again when opening or switching documents: the `set_title` call has been failing silently because the capability was never granted

### Changed

- Large-file editing is much lighter on weak machines: the status-bar counts and the outline refresh are debounced off the keystroke path and no longer materialize/scan the whole document on every keypress and cursor move
- The live preview patches only the blocks that actually changed instead of rebuilding the whole pane on every render, so images no longer re-decode (or flicker) while typing and large documents stop paying a full relayout per render
- The editor (CodeMirror) is loaded on first use instead of at startup, cutting the JavaScript parsed at launch by roughly 80% — opening a file just to read it never loads the editor at all
- Startup issues its three config/font/CLI reads concurrently, and the syntax-highlighter definitions are pre-warmed on a background thread so the first code block renders without a stall
- Overlay backdrops use a plain dim instead of a backdrop blur, which WebKitGTK composites in software on weak GPUs and made dialogs stutter

## [4.7.1] - 2026-06-11

### Fixed

- Synchronized scrolling between the editor and the preview no longer stalls the editor pane: the mirror write is coalesced into a single animation frame instead of forcing a reflow on every scroll event, which made scrolling crawl on WebKitGTK

### Changed

- Updated the CodeMirror dependencies to their latest patch releases (`@codemirror/lint` 6.9.7, `@codemirror/view` 6.43.1)

## [4.7.0] - 2026-06-08

### Added

- A unified search bar shared by reading and editing modes: the same bar drives both the rendered preview and the editor, the up/down arrows highlight and reveal the current match in whichever view is active, and in edit mode a second row adds Replace and Replace All
- A scoped editing toolbar in edit mode with one-click formatting actions (bold, italic, underline, inline code and fenced code blocks, ordered and unordered lists, headings, quotes, and a horizontal rule). Underline is also bound to `Mod+U`
- File management from the folder tree: create new untitled files, and a right-click menu to create or delete files
- A blocking error modal for unrecoverable errors, backed by a daily rotating error-log file so problems can be diagnosed after the fact
- Closing Settings with unsaved changes now prompts to save, discard, or cancel instead of silently dropping the edits

### Changed

- The Markdown formatting actions were reworked for CommonMark correctness and extracted into pure, dependency-free functions covered by unit tests. Horizontal rules now insert a blank separator line so a preceding paragraph isn't turned into a setext heading, and inline/fenced code grows its backtick fence past any run inside the selection (padding the edges) so content can't be broken
- The active file is highlighted in the folder sidebar and the active tab is framed with a border, so the current document is obvious at a glance
- The editor toolbar buttons were aligned with the rest of the UI: the Save button matches the other top-bar buttons (surface, border, and hover), the editing-toolbar and outline buttons gained consistent borders, and Discard and both Settings close buttons use the shared danger styling

### Fixed

- Opening a file from the folder tree no longer scrolls the tree away from the clicked entry
- The editor font size now follows the zoom level instead of staying fixed

## [4.6.0] - 2026-06-07

### Added

- apt and dnf package repositories: signed APT (Debian/Ubuntu) and DNF (Fedora/RHEL) repositories are published to GitHub Pages, so OxideMD can be installed and kept up to date through the system package manager (`apt install oxide-md` / `dnf install oxide-md`) rather than one-off downloads. Setup commands are on the install page linked from the README

### Changed

- Linux release builds now target the glibc from Ubuntu 24.04 (the build runner is pinned to `ubuntu-24.04`): OxideMD runs on Ubuntu 24.04, Debian 13, Fedora 40, and newer. Older distributions are no longer supported

## [4.5.0] - 2026-06-07

### Added

- Drag-and-drop image import: drop an image onto the editor to insert a Markdown image reference at the drop point. Dropped and pasted images are copied into an `assets/` folder beside the document and linked with a relative path
- Opt-in remote images: a new setting gates loading of remote (`http`/`https`) images in rendered Markdown, off by default, so a document can't silently fetch from external hosts until you allow it
- Dedicated "Associations" settings tab: the Markdown file-extension associations moved out of General into their own tab, with inline info icons in place of the previous help text

### Changed

- The frontend was migrated wholesale from JavaScript to TypeScript and reorganized from flat files into role-based module folders (`core`, `editor`, `features`, `lib`, `settings`, `ui`). A `typecheck` / `test` / `build` script set and a new CI workflow now guard the bundle on every pull request, and the release workflow installs with `npm ci` plus npm caching
- The single large `style.css` was split into focused stylesheets (`base`, `layout`, `components`, `toolbar`, `editor`, `markdown`, `theme`, `settings`)
- Update notifications now use the shared status-ok / danger palette tokens
- Project documentation was rewritten and restructured under `docs/`

### Fixed

- File-watcher memory is now bounded on large folders — the set of tracked paths is capped so opening a huge project tree can't balloon memory
- Code blocks fall back to plain text instead of failing to render when a syntax-highlighting theme can't be loaded
- Saves are written atomically with a backup of the previous file, so an interrupted save can't truncate or corrupt the document
- Associations tab layout polish: the horizontal scrollbar and tooltip overflow are gone, and the reset button and footer are restored

### Security

- Font and theme filenames are validated to reject path-traversal sequences before they're written into the config directory
- `open_url` only hands `http`, `https`, and `mailto` URLs to the OS; other, potentially unsafe schemes are refused

## [4.4.0] - 2026-06-02

### Added

- Fully responsive layout for narrow and small windows (the minimum size goes down to 480×270). The file-tree and outline sidebars become overlay drawers below 720px — they float over the document behind a dimmed backdrop instead of squeezing the reading column, slide away when a file is opened, and reopen via the folder button; the editor/preview split collapses to a single pane below 640px; and `#content` / preview padding is fluid (`clamp`) so the gutters shrink smoothly rather than eating scarce width
- Toolbar overflow menu: when the window is too narrow to show every action, the lowest-priority buttons relocate into a "⋯" popover (the real elements move, so handlers and toggle state are preserved) while the window controls stay pinned — so the minimize/maximize/close buttons can never be pushed off-screen on the borderless window. This is a second degradation stage beyond the existing label-hiding, with its own hysteresis so dragging the edge across the threshold doesn't flicker

### Changed

- The Settings dialog now fits short windows: its height is capped to the viewport and the body scrolls within it (instead of overflowing off-screen), and the category tabs scroll horizontally rather than wrapping
- The active tab now stays visible at minimum width — reserving room for the tab strip means a single open file no longer collapses behind a pair of (pointless) tab-scroll arrows

## [4.3.1] - 2026-06-02

### Fixed

- Window failed to open on wlroots-based Wayland compositors (Hyprland, Sway). WebKitGTK's DMABUF renderer committed the window's surface buffer without an explicit-sync acquire timeline point, so the compositor rejected the commit with a `wp_linux_drm_syncobj_surface_v1` "Missing acquire timeline" protocol error and the app exited at startup with `Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display`. OxideMD now sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` on Linux Wayland sessions — only when it isn't already set, leaving X11/XWayland sessions and any user override untouched

## [4.3.0] - 2026-06-02

### Added

- Native Arch Linux packaging under `packaging/aur/`: two PKGBUILDs let OxideMD install on Arch-based systems (Arch, Omarchy, EndeavourOS, Manjaro). `oxidemd` builds from the tagged source release, and `oxidemd-bin` repackages the official release `.deb` for a near-instant install with no Rust/Node toolchain. Both install the binary, desktop entry, icons, and license, `provides=oxidemd`, and conflict with each other; a generated `.SRCINFO` accompanies each so they can be pushed straight to the AUR. The source PKGBUILD deliberately uses plain `cargo build --release` rather than `cargo tauri build`, sidestepping the AppImage/linuxdeploy step that fails on current Arch with `strip: unknown type [0x13] section '.relr.dyn'`
- Release workflow now builds and publishes the Arch packages: a new `arch-package` job (in an `archlinux:latest` container) builds both `.pkg.tar.zst` files and attaches them to the release, reusing the Linux job's `.deb` as a workflow artifact so no extra binary artifact is needed. After upload it syncs the committed PKGBUILDs back to `main` — bumping `pkgver`, regenerating real `sha256sums` via `updpkgsums`, and refreshing `.SRCINFO` — so repo and AUR users always track the latest release without manual checksum work

## [4.2.1] - 2026-05-17

### Fixed

- Right-click "Copy" in reading mode (preview pane) and the rendered-content area now actually copies the selected text. The menu item was calling `document.execCommand('copy')` lazily, but clicking the menu button collapses the window text selection (focus shifts out of the article), so by the time the action ran the selection was gone and the clipboard got an empty string. The Markdown-context menu now snapshots `window.getSelection().toString()` at menu-build time and writes that snapshot through `navigator.clipboard.writeText`. The CM6 editor menu and the `<input>`/`<textarea>` menu were already snapshotting their selections internally and were not affected
- Window minimum size scales with the display instead of being pinned at 720×480. `window-size.js` now sets `minSize = max(1/4 of screen.{width,height}, 480×270)` capped at `screen.avail{Width,Height} − 80px`, and `tauri.conf.json` minimums lowered to 480×270 so the OS, the JS cap, and the config agree. On a 1080p panel the floor is 480×270; on 4K it's 960×540. The welcome-screen `scrollHeight` measurement that used to drive minHeight was removed — it occasionally bumped the floor above 1000px and trapped users at sizes far larger than they wanted

## [4.2.0] - 2026-05-16

### Added

- In-app updater: clicking "Install" on an available update downloads the new binary with a live progress bar, replaces it in place, and restarts OxideMD on the new version — no more bouncing out to the GitHub releases page for Windows NSIS/MSI, macOS `.app`, or Linux AppImage builds. RPM/DEB installs (which need root to replace `/usr/bin/oxidemd`) gracefully fall back to "open the releases page" via a sentinel error returned from the Rust `download_and_install_update` command
- Diagnostic logging via `tauri-plugin-log`: one date-stamped file per launch (`OxideMD-YYYY-MM-DD.log`) in the OS app log dir, capturing both Rust-side log calls and a new frontend `logger.js` whose `logError` / `logWarn` helpers route through the same file. Window-level `error` and `unhandledrejection` listeners catch otherwise-silent crashes; every existing `console.error/warn` site now flows through the helpers with a named scope
- Window-edge resize cursors: 8 invisible overlay handles (4 full-span edges + 4 corner squares) wired to `appWindow.startResizeDragging()`, so hovering near the border shows the correct OS resize cursor and click-and-drag delegates to the WM. Required because `decorations: false` means the OS doesn't paint draggable chrome. Corners overlap the edges with a higher z-index so the diagonal cursor wins at the corner — no dead strip where the cursor would otherwise flicker back to default. Handles auto-hide while maximized
- Config schema versioning: new `config_version` field plus a `migrate_config` step that runs on load and re-saves. v0→v1 is a no-op placeholder — future schema changes can drop renamed/removed keys and fill new defaults without losing user data
- `oxidemd --reset-all` CLI flag for clean-state recovery: prints a deletion preview, requires `--yes` to actually run, then wipes the OxideMD config dir (settings, custom themes, fonts), data dir (drafts in webview storage, `.running_version`), and cache dir
- RPM/DEB post-install kill script (`scripts/post-install.sh`): `pkill -x oxidemd` runs after `dpkg`/`dnf` writes the new binary, so the user can't end up refocusing a stale in-memory process via `tauri-plugin-single-instance` after upgrading. Wired through `bundle.linux.{deb,rpm}.postInstallScript`
- Version-mismatch detection for upgrades that bypass the post-install script (AppImage swap, Windows portable, macOS .app drag-replace): each launch stamps its version into `<data_dir>/.running_version`, and the surviving instance's single-instance callback emits a `version-mismatch` event whose payload reaches a 15-second toast saying "OxideMD vX.Y.Z is installed. Restart to apply the update."
- `showToast` accepts an optional `{ lifetimeMs }` override so messages the user must read and act on (like the update notice) don't auto-dismiss in the default 4 seconds

### Changed

- Settings → About: the update flow's CTA renamed from "Download" to "Install" and now triggers the in-app install pipeline instead of opening the releases page. Errors and unsupported-package fallbacks still surface an "Open releases" button so the manual download path stays reachable

### Fixed

- Window opens at a usable size and stays resizable on small displays. `window-size.js` was setting the window minimum height to the welcome screen's natural `scrollHeight` + toolbar + status bar — a value that easily exceeded 1000px and overshot the usable area on Windows 10 with a taskbar or any Linux WM with top bar + dock, locking the window above screen height. Both the min-size and the current window geometry are now capped against `screen.avail{Width,Height} - 80px`, on both axes, with a runtime clamp that pulls the window back if a stale state opened it past the cap
- `body.maximized` and the maximize toolbar icon no longer thrash on drag-resize. `appWindow.onResized` was running `isMaximized()` over IPC on every pixel of a manual resize, queuing dozens of async round-trips per second. The handler is now debounced 120ms to the trailing edge so a long drag fires one IPC call when the user lets go
- Tab overflow no longer double-updates on resize. `tabs.js` already wires a direct `resize` listener that runs the (cheap, idempotent) overflow check; a 600ms debounced duplicate in `app.js` was running the same work again after every drag, making the overflow indicators feel sluggish without adding any correctness. The duplicate is gone — the direct handler keeps the gutters and scroll buttons live with no lag
- Resize handles also hide in fullscreen (macOS Cmd+Ctrl+F, WM-triggered fullscreen on Linux/Windows), not just when maximized. `syncMaximizeIcon` now toggles a parallel `body.fullscreen` class via `appWindow.isFullscreen()`, and the resize-handle CSS + mousedown guard treat both states the same — resizing isn't possible in either, so showing the cursor was misleading

## [4.1.0] - 2026-05-16

### Added

- Responsive toolbar: action labels auto-hide when the window narrows so the toolbar stays usable without forcing the user to flip the toolbar-compact preference. Composes with the manual toggle (either flag hides labels), uses a 24px hysteresis buffer so dragging the window edge across the threshold doesn't flicker, and measures the natural label-on width once at launch so the threshold is content-driven rather than a hardcoded breakpoint
- Settings → Reading: "Import" button next to the Font dropdown, mirroring the Themes row. Clicking it runs the same install-font flow that used to live as an "Add font…" entry inside the dropdown
- Themes and Fonts dropdowns now group entries under "Included" and "Imported" section headers, each bracketed above and below by a divider so the sections read as separators rather than loose labels
- Save button on the Settings dialog is now dirty-state-driven: disabled while the form mirrors the persisted config, enabled only after a real change. Listens for `input`/`change`/`click`/`keyup` at the dialog root and rAF-defers the diff so custom widgets (segmented pills, custom-select dropdowns, shortcut editor) that mutate `dataset` attributes are caught via bubbling

### Changed

- Settings dialog widened to 660px so the Themes and Font rows fit the dropdown plus action buttons without crowding
- Settings footer: "Cancel" renamed to "Close" (it always discarded unsaved tweaks; the new label reflects that). "Save" now persists changes without closing the modal, so the user can iterate against the live preview behind the dialog. The X button, Close button, and Escape are the only ways out
- Clicking the backdrop outside the Settings dialog no longer closes it — accidental dismissal mid-edit is gone
- Themes Import / Export and Font Import buttons now sit inline with their dropdown rather than below it, in dedicated rows
- App-wide button family aligned around three tiers: primary CTA (flat `var(--accent)` fill with `filter: brightness()` hover), outlined secondary (`var(--bg)` fill + `var(--border)` outline), and ghost icon (transparent fill + transparent border). The previous "marketing CTA" gradient + drop-shadow look was removed from `#settings-save` and `.update-status .update-download`; `--save-btn-bg` and `--save-btn-shadow` tokens deleted
- Segmented controls (On/Off pills) no longer stretch across the row — they sit at intrinsic width, right-aligned, with `min-width: 56px` per option for visual balance and `white-space: nowrap` so longer labels like "Icons + labels" don't wrap to two lines
- `.custom-select-trigger` truncates with an ellipsis instead of wrapping when the row tightens (e.g. when a long theme label sits in the squeezed Themes dropdown next to Import/Export)
- Settings label column widened from 148px to 180px so two-word labels like "Display recent files" and "Printer Friendly PDFs" stay on a single line beside the info icon

### Fixed

- Window opens centered at the configured default size every launch. The 4.0.1 monitor-clamp still relied on a persisted geometry that mixed physical and logical pixels — on HiDPI Windows each maximize/close/relaunch cycle inflated the window by the scale factor, and even with clamping the restored size could outgrow the screen on a new display. The `save_window_geometry` command, the matching config fields, and the frontend listener were removed entirely; `tauri.conf.json` (`center: true`, `width: 1280`, `height: 700`) drives every launch

## [4.0.1] - 2026-05-15

### Changed

- Toolbar labels auto-hide on narrow windows (below 1220px) via a CSS media query that mirrors the existing compact-density rule; the manual "Compact toolbar" setting still forces icon-only at any width. Removes the need for the toolbar's natural width to dictate the window's minimum width
- Minimum window width lowered from 1220 to 720, default launch width from 1220 to 1280 — the app now fits on 1280×720 laptops and shrinks comfortably for half-screen snapping. `tauri.conf.json` updated accordingly
- Window size is now clamped to the current monitor at startup (with 80px of slack for taskbar/decorations and floors mirroring `minWidth`/`minHeight`), so a persisted geometry from a larger display can't open larger than the current screen
- `frontend/window-size.js` no longer measures the toolbar to derive a minimum width — `tauri.conf` carries the authoritative 720px floor and CSS handles the narrow-width layout. The module now only computes a height floor that fits the welcome screen at the current font/zoom

### Removed

- Native application menu bar (File / Edit / View / Help) introduced in 4.0.0. On Fedora/GTK it rendered as an unwanted system menu and crowded the titlebar — pulled in full pending a redesign

### Fixed

- Print to PDF no longer leaves the UI stuck after pressing Escape to dismiss the dialog. WebKitGTK and Chromium-on-Linux skip-fire the `afterprint` event on cancel, which left `.printing`/`.print-friendly` on `<body>` and the loader overlay visible indefinitely. Teardown now listens for three signals — `matchMedia('print')` change, `afterprint`, and a 60-second safety timer — and runs exactly once, whichever fires first
- Settings → Compact toolbar setting and the auto-collapse media query share the same icon-only rule so toggling Compact at any window width behaves consistently

## [4.0.0] - 2026-05-15

### Added

- Themeable base UI palette: every surface, text token, border, link, scrollbar, and highlight color is now editable from Settings → Colors, with sparse overrides stored in `config.toml` so untouched tokens still track the active theme defaults
- Bundled themes shipped with the app: Atom One Dark, Atom One Light, Catppuccin Mocha, Dracula, Gruvbox Dark, Nord, Rosé Pine, Solarized Light, Tokyo Night, and Tokyo Night Storm — embedded at compile time, available on first run with no install step
- Themes dropdown split into "Included" and "Imported" sections, each sorted alphabetically (case-insensitive). The trigger reflects the currently-applied theme and survives restarts via a new `custom_theme` config field
- Theme JSON template now carries a `name` field; imports prefer it over the file stem so a renamed file still surfaces its intended label, and exports stamp the filename stem when the frontend hasn't already
- Custom theme import/export as JSON: any theme can be saved through the platform's native dialog and re-imported on another machine. Imports are validated, persisted to a per-user themes directory, and listed in the Themes dropdown across restarts
- Native application menu bar (File / Edit / View / Help) bound to the same action registry as the toolbar and shortcuts
- Project-wide content search: a second sidebar tab searches every Markdown file in the open folder, streams results as ripgrep finds them, and clicking a hit jumps to the line in a new or existing tab
- Document outline panel docked as a right-side sidebar with persisted open/closed state; only opens when a file is active so the welcome screen stays uncluttered
- Independent Preview and Outline toolbar toggles, each with its own pressed state. Preview controls the split editor's preview pane (edit mode only); Outline controls the right-side sidebar (read or edit mode)
- Editor settings tab carrying word wrap, spell check, line-number gutter (now on by default), and a new "Format on save" toggle
- "Format on save" (Editor tab, off by default): aligns Markdown table columns VS Code-style with grapheme-width emoji/CJK accounting, normalizes line endings to LF, trims trailing whitespace (preserving the two-space hard-break), and collapses to a single trailing newline. All edits go through the CodeMirror history so Ctrl+Z reverts them
- General settings tab carrying toolbar density, Markdown file extensions, Printer Friendly PDFs, and a new "Display recent files" toggle that hides the welcome-screen recent list without clearing the entries
- Configurable Markdown file extensions (General tab): the folder browser, project search, and CLI handling all share a single normalized list — defaults to `md, markdown, mdown, mkd`
- Markdown rendering extensions: footnotes with reference links, heading attribute lists (`{#id .class key=value}`), and angle-bracket autolinks (`<https://…>`)
- PDF export now surfaces a loader and toast feedback so long exports stay visible
- Editor syntax highlighting tracks the bullet and note accent palette tokens so themed colors flow into the source view
- Markdown files declare an Editor role on the OS file association so "Open with…" lists OxideMD as an editor
- Themed scrollbar inside the Settings dialog — tracks the active palette like the other panes
- Settings dialog is now responsive (`min(570px, calc(100vw - 32px))`) so it never overflows on narrow windows
- "ARCHITECTURE.md" describing the frontend modules and backend command surface

### Changed

- Welcome screen returned to the v3.2.0 layout: three equal hero cards (Create new file / Open Markdown file / Open folder) with Recent files and Keyboard shortcuts beneath
- Dark / Light / System dropdown removed from Settings → Colors. The applied theme JSON now drives the mode (`theme: "dark" | "light"`), with the Themes dropdown as the single source of truth
- Toolbar Preview and Outline buttons reflect their toggle state via `aria-pressed` + an accent-tinted background, distinct from plain hover
- Outline is hidden on the welcome screen without dropping the persisted open preference; opening a file again restores it
- Custom theme dropdown trigger no longer pins "Default" to the top; "Atom One Dark" and "Atom One Light" are alphabetized into the Included list with the rest of the bundled themes
- Theme import is now a button next to Export theme rather than a row inside the Themes dropdown
- Refactored Editor settings out of Reading: word wrap, spell check, and line-number controls live in their own tab so Reading focuses on typography and reading-mode behavior

### Fixed

- Editor syntax highlighting no longer reads as raw CodeMirror defaults — heading, code, and quote tokens now resolve through the same palette as the rendered preview
- Watcher debounce, reset-defaults confirm, and Escape scoping cleaned up so destructive operations always confirm and stray Escape presses don't drop edit mode
- Tab dirty dot contrast and welcome-screen status counts adjusted for the new themeable palette

## [3.2.0] - 2026-05-14

### Added

- Create new files from within OxideMD: a New File toolbar button, `Ctrl/Cmd+N`, a welcome-screen action, and a "New File…" entry in the folder tree's right-click menu. The location is chosen through the platform's native save dialog; an empty `.md` file is created (the extension is appended if omitted) and opened straight into edit mode
- Print to PDF: a Print toolbar button, `Ctrl/Cmd+P`, and a "Print…" context-menu entry render the active document through the webview's native print dialog (Save as PDF on Windows/macOS, Print to File on Linux). The rendered Markdown is isolated into its own print container so no app chrome reaches the page, with `print-color-adjust` keeping fonts, colors, and syntax highlighting intact
- New "Printer Friendly PDFs" setting (Reading tab, on by default): prints with a light background and dark text regardless of the active theme; turning it off prints in the app's exact current style
- New "Preserve line breaks" setting (Reading tab, off by default): renders every single newline in the source as a line break; with it off, OxideMD follows standard CommonMark and joins single newlines into one paragraph. Open documents re-render immediately when the setting changes

### Fixed

- Dark-theme PDFs no longer print as a dark card floating in a white margin band — the page margin is now zero with the inset moved onto the print container, so the theme background reaches every edge of the sheet
- Settings panel keyboard-focus and layout polish: the info-icon explanation now appears on keyboard focus (not just mouse hover), the number-stepper buttons and segmented toggles render a clean inset focus ring instead of a clipped sliver, and the wider setting labels no longer wrap mid-phrase

## [3.1.3] - 2026-04-25

### Fixed

- Titlebar logo and Settings → About icon now use the refreshed app artwork; `cargo tauri icon` regenerates only `src-tauri/icons/`, so the frontend's own copy at `frontend/icon.png` had stayed on the previous design

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
