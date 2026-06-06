# OxideMD Documentation

These docs cover how OxideMD is built and how to work on it. OxideMD is a [Tauri v2](https://tauri.app/) desktop app: a Rust backend handles the OS-facing work, and a TypeScript frontend (bundled with esbuild, running in the native webview) owns the UI. For a feature tour and install instructions, start with the [project README](../README.md).

## Contents

- **[Architecture](ARCHITECTURE.md)** — how the Rust backend and TypeScript frontend divide responsibilities, the IPC command and event surface, the module map, and the runtime lifecycles (config, drafts, file watching, updates, rendering).
- **[Contributing](CONTRIBUTING.md)** — getting a dev environment running and the pull-request workflow.
- **[Code Style](CODE_STYLE.md)** — the Rust and TypeScript conventions we follow, and what CI checks.
- **[Commit Style](COMMIT_STYLE.md)** — the commit-message format used in this repository.
- **[GitHub Tags & Releases](GITHUB_TAGS.md)** — semantic versioning, tag format, and the release process.
