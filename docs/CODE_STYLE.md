# Code Style

OxideMD keeps a consistent style across the Rust backend and the TypeScript
frontend. The goal is code that reads like the code already around it.

## Rust

The backend follows standard Rust idioms and the default toolchain settings
(there is no custom `rustfmt.toml` or clippy config).

- **Formatting** — run `cargo fmt` before committing. We use rustfmt's defaults.
- **Linting** — run `cargo clippy` and clear its warnings. Prefer clear,
  idiomatic code over clever tricks.
- **Docs** — use `///` doc comments on public functions and modules. The
  [Architecture](ARCHITECTURE.md) doc describes where each kind of logic lives.

## TypeScript

The frontend is TypeScript, bundled by esbuild. There is no Prettier or ESLint
config in the repo today, so style is maintained by matching the existing code
rather than by an auto-formatter. Conventions in use:

- **Types** — run `npm run typecheck` before committing. Because esbuild only
  strips types, `tsc` (`--noEmit`) is the real type-safety gate. `tsconfig.json`
  currently sets `"strict": false`, but still prefer precise types and avoid
  introducing new implicit `any`s.
- **Imports** — within `frontend/`, import sibling modules with their explicit
  `.ts` extension (e.g. `from "../core/state.ts"`), as the rest of the code
  does.
- **Quotes** — single quotes for strings, except where double quotes avoid
  escaping.
- **Semicolons** — terminate statements with semicolons.
- **Indentation** — two spaces.

## What CI enforces

`.github/workflows/ci.yml` runs `npm run typecheck`, `npm test`, and
`npm run build:frontend` on every pull request. The Rust `cargo fmt` / `cargo
clippy` conventions above are not yet gated in CI, so run them locally before
pushing.

See [Contributing](CONTRIBUTING.md) for the full pull-request workflow.
