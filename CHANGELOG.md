# Changelog

All notable changes to OxideMD will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-04-10

### Added

- Linux support: `.deb`, `.rpm`, and `.AppImage` bundle targets
- macOS support: `.dmg` bundle target
- Keyboard shortcuts now work with `Cmd` on macOS
- Platform-aware tooltip labels (show `Cmd` on macOS, `Ctrl` elsewhere)

### Changed

- Default font changed from Segoe UI to system default for cross-platform compatibility
- Font dropdown now uses cross-platform fonts (System Default, Georgia, Consolas, Arial, Verdana, Times New Roman)
- README updated to reflect cross-platform support with per-platform build prerequisites
- App description updated to "cross-platform"

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
