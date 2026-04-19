## What's New

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

--------

See [CHANGELOG.md](https://github.com/FenrirTheGray/OxideMD/blob/main/CHANGELOG.md) for the full history.