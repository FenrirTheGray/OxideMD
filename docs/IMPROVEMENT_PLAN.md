# Frontend Improvement Plan

A staged plan for hardening the OxideMD frontend (`frontend/`). Derived from
a structural review of the ~7.5k-line, framework-free ES-module codebase.
Each phase is independently shippable and ordered by value-to-risk: the
early phases are additive (no runtime behavior change) and verifiable in
isolation; the later phases are larger refactors that need manual smoke
testing in the running app.

## Guiding constraints

- **No framework.** Keep the plain-ES-module, imperative-DOM style. The goal
  is to make the existing approach safer, not to rewrite it.
- **Build stays one esbuild bundle.** Any new module must bundle cleanly via
  `npm run build:frontend`.
- **Rendering stays in Rust.** No markdown parsing or sanitization moves to JS.
- **Behavior-preserving.** Phases 1–2 must not change what the app does;
  they only restructure and add coverage.

---

## Phase 1 — Test infrastructure (biggest gap) ✅ in progress

The codebase has zero automated tests, yet contains intricate pure logic:
the accelerator parser, the markdown table formatter (with grapheme-width
math), draft conflict detection, and scroll-sync mapping. These are cheap to
test and high-value to lock down.

**Approach:** extract dependency-free pure logic into `frontend/lib/`, leave
the original modules importing from there (so runtime is byte-for-byte the
same after bundling), and cover the extracted code with the Node built-in
test runner (`node --test`, zero new dependencies — Node 26 is present).

Steps:
1. `frontend/lib/accel.js` — platform-independent accelerator parse/format/
   canonicalize/normalize. `keybindings.js` re-imports them. *(this commit)*
2. `frontend/lib/accel.test.js` — round-trips, the `+`/`Plus` escape-hatch
   edge cases, malformed input, modifier alphabetization. *(this commit)*
3. `frontend/lib/md-table.js` — extract the table-alignment formatter and
   `visibleWidth`/grapheme logic from `editor.js`; cover emoji + CJK widths,
   alignment markers, fenced-code skipping.
4. `npm test` script wired to `node --test frontend/lib/`.

Exit criteria: `npm test` green, `npm run build:frontend` unchanged output
shape, no behavioral diff.

## Phase 2 — Shared timing utilities ✅

Debounce timers were re-implemented ad hoc across the modules. A single
tested `debounce()`/`throttle()` helper now lives in `frontend/lib/timing.js`
and is applied to the simple trailing-edge cases in `app.js` (window resize
sync, in-document search input, sidebar tree filter). The stateful timers
that need a dynamic delay or external cancellation (the live-preview render
and the draft autosave in `editor.js`) keep their bespoke implementations on
purpose — they're not a fit for the plain wrapper.

## Phase 3 — Decompose `settings.js` (was 2,141 lines) ✅ (partial)

The single largest module bundled the dialog shell, custom form controls,
the Colors data + handlers, font management, theme import/export, and the
updater pipeline. Extracted the cleanly-separable regions into
`frontend/settings/`:

- `settings/palette.js` — palette data (BG_DEFAULTS, DEFAULT_PALETTE, the 27
  tokens) + the pure helpers `effectiveBgColor` / `effectivePalette` and the
  `applyPaletteToBody` / `setBodyTheme` appliers. Dependency-free, so the
  pure helpers are unit-tested (`palette.test.js`, 7 tests).
- `settings/updates.js` — the About-tab update check + in-app install
  pipeline and its progress UI. Self-contained (only `invoke`/`listen`).
- `settings/controls.js` — the generic custom-select, segmented, and
  custom-number widget initializers + the dialog focus trap.
- `settings/fonts.js` — the dynamic font dropdown (build/select/remove).

`settings.js` keeps the genuinely entangled core: `applyConfig`,
`loadCustomFont`, the theme dropdown, the Colors-tab live preview/collect/
apply handlers, `openSettings`/`saveSettings`/`resetSettings`/
`buildCandidateConfig`, and the Shortcuts panel — these share mutable
module state (`pendingOverrides`, `populatingSettings`, the custom-theme
selection) and threading that across files would add more coupling than it
removes. Result: **2,142 → 1,393 lines (−35%)**, behavior-preserving (pure
code moves; bundle builds identically; all four files `node --check` clean).

Deferred (needs the running app to verify safely): peeling the Colors-tab
handlers and the Shortcuts panel out behind a small shared-state seam.

Behavior-preserving by construction, but the running Settings dialog was
not smoke-tested — verify each tab in the app before relying on it.

## Phase 4 — Decouple `tabs.js` ↔ `editor.js` ✅ (thinned)

The two modules imported from each other. Lifted the shared contract into a
new neutral seam, `frontend/tab-state.js` (imports only `state.js`): the
active-tab accessor (`activeTab`), the pure predicates (`isDirty`,
`isPreviewVisible`), content mount (`renderContent`), the status helpers
(`setLoading` / `clearStatus`), and `applyZoom`. `tabs.js` re-exports these
so the other importers (settings, folder, print, app) are unchanged.

Result: `editor.js`'s dependency on `tabs.js` drops from **7 imported
symbols to 3** — only the irreducible chrome calls (`syncToolbar`,
`renderTabBar`, `rerender`), which legitimately need the whole UI's state —
and the pure tab predicates now live in one neutral place.

The tabs↔editor cycle is **thinned, not eliminated**: `outline.js` and
`folder.js` each import *both* `tabs.js` and `editor.js`, so the UI layer is
a four-module mutually-recursive cluster. Fully breaking it needs a mediator
/ event-bus indirection across all four, which changes event-dispatch
semantics and must be verified in the running app — deferred rather than
done blind.

## Phase 5 — Centralize UI sync ✅

Added a single `rerender()` choke point in `tabs.js` —
`syncToolbar()` + `renderTabBar()` + `refreshOutline()` — and routed the
edit-mode transitions (`enterEditMode` / `exitEditMode`) through it, the two
spots where the full triple was duplicated and a missed call would most
visibly desync the chrome. The remaining call sites use partial combos
(e.g. `applyActiveTab()` already folds in `refreshOutline`), so they're left
as-is to stay byte-for-byte behavior-preserving rather than forced through
`rerender()`.

---

## Status log

- Phase 1: accel layer extracted + tested (10 tests). ✅
- Phase 1: md-table formatter extracted from editor.js + tested (13 tests). ✅
- Phase 2: shared debounce/throttle in frontend/lib/timing.js + tested (4 tests);
  applied to the 3 simple debounce sites in app.js. ✅
- Phase 3: extracted settings/{palette,updates,controls,fonts}.js from settings.js
  (2,142 → 1,393 lines, −35%); palette pure helpers tested (7 tests). ✅
- Phase 4: added neutral frontend/tab-state.js seam; editor.js→tabs.js coupling
  cut from 7 imported symbols to 3. Cycle thinned (not eliminated — outline/
  folder bridge the cluster; full break deferred for GUI verification). ✅
- Phase 5: added rerender() choke point in tabs.js; routed enter/exit edit mode
  through it. ✅
  `npm test` → 34 passing; build clean. All five frontend phases addressed.
