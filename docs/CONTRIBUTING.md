# Contributing to OxideMD

Thanks for taking the time to contribute! This guide covers getting set up and
the workflow for landing a change.

## Get oriented

Before diving in, skim the [Architecture](ARCHITECTURE.md) overview — knowing
how the Rust backend and TypeScript frontend split work, and how they talk over
IPC, makes it much faster to find where a change belongs.

## Set up a dev environment

You'll need [Rust](https://rustup.rs/) (stable) and [Node.js](https://nodejs.org/).
Install the platform build dependencies listed under
[Build from source](../README.md#build-from-source) in the README, then:

```bash
cargo install tauri-cli --version "^2" --locked
npm install
cargo tauri dev          # hot-reloads the frontend via esbuild
```

## Before you open a pull request

Run the frontend checks locally — `esbuild` strips TypeScript types without
checking them, so `tsc` is what actually catches type errors:

```bash
npm run typecheck        # type-check the frontend
npm test                 # run the frontend unit tests
npm run build:frontend   # confirm the bundle builds
```

If you touched Rust, also run the standard tooling (see
[Code Style](CODE_STYLE.md)):

```bash
cargo fmt
cargo clippy
```

Continuous integration (`.github/workflows/ci.yml`) runs the frontend checks —
`typecheck`, `test`, and `build:frontend` — on every pull request, so anything
that fails locally will fail CI too.

## Workflow

1. **Fork** the repository and create a feature branch off `main`.
2. **Make your change**, matching the surrounding code — see
   [Code Style](CODE_STYLE.md).
3. **Commit** using the format in the [Commit Style Guide](COMMIT_STYLE.md).
4. **Verify** with the checks above.
5. **Open a pull request** against `main` with a clear description of what
   changed and why.

If you're a maintainer cutting a release, follow the
[GitHub Tags & Releases](GITHUB_TAGS.md) process instead.
