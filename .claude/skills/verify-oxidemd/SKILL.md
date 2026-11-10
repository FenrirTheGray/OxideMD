---
name: verify-oxidemd
description: Drive the real OxideMD desktop app (Tauri, WebKitGTK) the way a user does and capture proof - launch an isolated debug build off screen, press toolbar buttons by their accessible names, send keys, read the editor and status bar, screenshot the window, and check files on disk. Use before claiming a UI, editor, save, reload or draft change works, or when asked to run, drive, screenshot or verify the app. Linux with Hyprland only.
---

# Verify OxideMD

`scripts/oxv` starts a debug build of this checkout in its own sandbox and drives it. The instance has its own config, cache, data and D-Bus session, lives on its own Hyprland workspace, and never takes keyboard focus. It cannot read or change the user's settings, and it cannot hand files to a copy of OxideMD the user has open.

All commands below are run from the repo root. `oxv` is `.claude/skills/verify-oxidemd/scripts/oxv`.

```sh
OXV=.claude/skills/verify-oxidemd/scripts/oxv
```

Read [`features/README.md`](features/README.md) before driving a feature. It indexes one recipe per feature, and those recipes are the maintained source for what "works" means.

## Requirements

Hyprland 0.56 or newer (Lua dispatchers), `grim` 1.5 or newer (`-T` window capture), `jq`, `python3` with PyGObject and the AT-SPI typelib, `dbus-run-session`, `busctl`. `oxv launch` names the first missing tool. There is no macOS, Windows or headless CI path; on those, say so and fall back to `npm test` and `cargo test`.

## Launch

```sh
$OXV build                       # npm run build:frontend, then cargo build in src-tauri
$OXV launch path/to/note.md      # zero or more files
```

- Build after every source change. The frontend is compiled into the binary, so a CSS or TypeScript edit needs `oxv build` too, then a relaunch.
- `oxv build` deletes and rewrites `frontend/dist` and builds into the same `src-tauri/target` that `cargo tauri dev` uses. If the user has `cargo tauri dev` running, their watcher and yours fight over both; ask them before building.
- This is a plain `cargo build` debug binary with the frontend embedded, not the README's `cargo tauri dev`, which serves the frontend from a dev server. The app code is the same; anything specific to the dev server is not exercised.
- `launch` returns once the web UI is readable, not merely once a process exists. It prints the pid, the workspace and the run directory.
- State starts empty: stock dark theme, default settings, no recent files. Nothing needs seeding.
- Put test documents under the run directory (`/tmp/oxidemd-verify/main/docs/`), never in the repo.
- The run directory is created private to you (mode 700). `oxv` refuses a run directory, or a parent of it, that another user owns or can write, because it executes a launch script from there. If `/tmp/oxidemd-verify` was created by someone else, set `OXV_RUN` to a directory of your own.
- One instance per run directory. For a second instance side by side, set `OXV_RUN=/tmp/oxidemd-verify/other` on every command for it.
- The window is 1280x800. Change it with `OXV_SIZE=1600x1000` at launch.

## Doctor

```sh
$OXV doctor
```

Read-only. It fails if the build is older than any source file, if the pid is not this checkout's debug build, if the instance is not sandboxed, if its workspace is showing on a monitor, if it holds keyboard focus, or if the UI is not readable. Run it first whenever a step behaves oddly. A stale build is the usual cause of "my change isn't there".

## Drive

Handles are accessible names: the ARIA label or visible text of an element. Find them with `tree`.

| Command | What it does |
|---|---|
| `$OXV tree` | Print every showing element as `role "name" [states] text="..."`. `--all` includes hidden ones. |
| `$OXV press "Save file"` | Press a button or toggle. Fails if it is missing, disabled or ambiguous. |
| `$OXV key ctrl+s` | Send one key or chord: `ctrl+e`, `ctrl+shift+o`, `ctrl+Tab`, `Escape`, `Return`, `ctrl+End`. |
| `$OXV type "some text"` | Type into whatever has focus in the app. |
| `$OXV text "Edit note.md"` | Print an element's full text. The editor is the `entry` named `Edit <file name>`. |
| `$OXV show "Save file"` | Print matching elements with their states (`enabled`, `pressed`, `selected`, `focused`). |
| `$OXV wait "Saved" --text` | Wait until an element shows. `--gone` waits for it to leave, `--enabled` for it to become pressable, `--timeout 5` sets seconds. |
| `$OXV open other.md` | Hand a file to the running instance, as a file manager's "Open with" does. |

Name options for `press`, `text`, `show`, `wait`: `--role "toggle button"` narrows by role, `--contains` matches part of the name, `--text` matches part of the name or of the text content, `--hidden` includes elements that are not showing.

Stable handles in this app:

- Toolbar: `Create new file`, `Open file`, `Open folder`, `Reload current file`, `Toggle edit mode`, `Search in document`, `Show preview pane` / `Hide preview pane`, `Show document outline`, `Print to PDF`, `Open settings`.
- Edit toolbar: `Bold`, `Italic`, `Heading 1`, `Bullet list`, `Save file`, `Discard unsaved changes`, and the rest as `tree` lists them.
- Tabs: `page tab "<file name>"` inside `page tab list "Open files"`. The selected one has the `selected` state.
- Status bar: an unnamed panel whose text is `Saved`, `Unsaved changes` or `Not saved yet`. Match it with `wait "Saved" --text`.
- Dialogs: `dialog "<title>"` with buttons by label, such as `Overwrite`, `Cancel`, `Restore`, `Discard draft`, `Save`, `Discard`.
- Shortcuts: the defaults are listed in `frontend/core/keybindings.ts` (`ACTIONS`).

Rules that keep a run honest:

- After every `type`, read the result back with `text`. `type` assumes a US layout and supports letters, digits, space, newline and `- . , / # ! * _`. For any other content, write it into the file on disk before launch and let the app load it.
- Switch tabs with `$OXV key ctrl+Tab`. `press` refuses tabs, because the accessible press lands on the tab's close button and closes it.
- A modal dialog hides everything behind it from `tree`. If a handle "vanished", look for a `dialog`.
- Native file dialogs (Open file, Open folder, Save for an untitled file, Export) cannot be driven. Open files with `launch` arguments or `oxv open`. A feature reachable only through a native dialog is reported as not verified, never as verified through another path.

### The window is off screen

The window sits on a workspace that is not showing, so it paints only when it is captured. `oxv` captures a few frames after every action and one before every read, which is enough for clicks, typing, dialogs and state changes. Two consequences:

- For animation, transition timing or anything measured per frame, run `$OXV reveal` first. It moves the window, still without focus, onto the monitor the user is not typing on, where it paints normally. `$OXV hide` moves it back. The user sees the window while it is revealed, so keep that short. `doctor` reports the showing workspace as a failure until you hide it again.
- If the user reports the window appearing by itself, run `$OXV doctor`. The launch rules tell Hyprland to ignore OxideMD's own focus requests; without them `oxv open` would switch the user's monitor to the test workspace.

## Evidence

Everything lands in `<run dir>/evidence/` (default `/tmp/oxidemd-verify/main/evidence/`).

```sh
$OXV shot after-save                 # evidence/after-save.png, the window only
$OXV snap after-save                 # evidence/after-save.a11y.txt, the full tree
$OXV keep /tmp/oxidemd-verify/main/docs/note.md after-save.note.md   # copy a side effect
```

What counts as proof:

- Drive the real user path: a key, a button, a file handed to the app. Never call a Tauri command or edit app state from outside.
- Capture the action and the result, not only the final screen: a `snap` or `shot` before and after.
- A UI claim needs the tree (`snap`) and a screenshot. A visual claim (colour, spacing, layout) needs the screenshot looked at, not just taken.
- A claim about saving needs the bytes on disk (`keep` the file), not the `Saved` label alone.
- A claim about drafts needs the draft file under `<run dir>/xdg/cache/oxidemd/drafts/`.
- Report the feature and the entry point with each artifact. An entry point you could not drive is reported as not verified.

`/tmp` does not survive a reboot. Copy the evidence folder wherever the task needs it before reporting.

## Cleanup

```sh
$OXV stop
```

Stops only the process group this run started, never by process name, and deletes the sandboxed state under `<run dir>/xdg`. The `evidence/` and `docs/` folders stay. Run it after every attempt, including failed ones.

- `$OXV stop --keep-state` keeps config, cache and drafts for a relaunch.
- `$OXV crash` kills the app with SIGKILL and keeps its state, for crash-recovery journeys.

## Helpers

- `scripts/oxv`: the only entry point. `$OXV help` lists every command.
- `scripts/a11y.py`: reads and presses the accessibility tree. `oxv` calls it; do not run it directly.

## Keeping this skill true

When the app's toolbar, dialogs, shortcuts or file handling change, update the matching file in `features/` in the same change. `/pstack:maintain-verification-skill` re-checks the whole map against the app.
