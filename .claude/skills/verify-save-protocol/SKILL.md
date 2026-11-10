---
name: verify-save-protocol
description: Formally check OxideMD's save, reload and outside-change protocol with a TLA+ model - that a save never silently overwrites another program's change and that typed text is never dropped. Use when a change touches saveActiveFile, loadFile, reloadFile, flushFsChanges, tab.raw / tab.savedRaw / tab.diskHash, saveRecentlyFor, the confirm prompts, save_file, file_sha256, open_file or the file watcher, or when asked whether such a change can lose data.
---

# Verify the save protocol

A TLA+ model of one open file, checked by TLC over every ordering of the user's actions, the app's asynchronous steps and another program's writes, within stated bounds. It answers one question about a change: can OxideMD now lose the user's text, or another program's, without asking?

Run from the repo root:

```sh
.claude/skills/verify-save-protocol/scripts/check
```

About 15 seconds; `check --help` lists the options. The first run downloads the TLA+ tools (version pinned, checksum checked) into `~/.cache/oxidemd-verify/` and a pinned Java through `mise`; both need the network once.

## The rules

| Rule | What it promises | What a break costs the user |
|---|---|---|
| `NoSilentOverwrite` | A save never replaces disk content other than what the tab holds as saved (what it last loaded or wrote), unless the user chose Overwrite. | Another program's work is gone, with no warning and no copy. |
| `NoLostEdits` | Text the user typed stays in the buffer, the editor, or on its way to disk until they save or discard it. | The user's own writing is gone. |
| `TabNotStale` | With nothing in flight, a reading-mode tab with no unsaved edits shows what is on disk. | The user reads, and may act on, an old version. |
| `NoFalseWarning` | The "File changed on disk" warning appears only when the disk differs from what the tab holds as saved. | A scary warning for nothing; users learn to click through it. |
| `WatcherStaysArmed` | While a file is open, OxideMD keeps watching it. | Later outside changes are never noticed. |

## Does a change touch this?

It does if it edits any of these. The model's action for each is named in `model/SaveProtocol.tla` beside the same function name.

| Code | Model actions |
|---|---|
| `frontend/app.ts`: the `save` and `reload` handlers and the `fs-changed` listener | `SaveStart`, `UserReload`, `FsFlush` |
| `frontend/editor/editor.ts`: `saveActiveFile`, `enterEditMode`, `exitEditMode`, `discardActiveFile`, `onDocChanged` and the seed logic in `buildView` | `SaveStart`, `SaveCompare`, `SaveDone`, `EnterEdit`, `ExitEdit`, `Discard`, `Type` |
| `frontend/ui/tabs.ts`: `loadFile`, `reloadFile`, `openInNewTab`, `switchToTab`, `parkActiveEditorState` | `Init`, `ReopenSameFile`, `UserReload`, `ReloadApply` |
| `frontend/ui/folder.ts`: `flushFsChanges`, `handleFsChange`, `syncWatcher` | `FsFlush`, `ReloadApply`, `OtherTabChanges` |
| `frontend/ui/confirm.ts`: `promptOverwriteChanged` | `PromptOverwrite`, `PromptCancel` |
| `frontend/core/tab-state.ts`: `isDirty`, `saveRecentlyFor`, `SAVE_SUPPRESS_MS` | `Dirty`, `suppress`, `SuppressExpires` |
| `src-tauri/src/commands.rs`: `save_file`, `atomic_write`, `open_file`, `file_sha256` | `SaveWrite`, `ReloadRead`, `SaveHashRead`, `HashRead` |
| `src-tauri/src/watcher.rs`: `set_watch_paths`, `should_emit`, `COALESCE_WINDOW` | `watching`, `fsEvent`, `OutsideWrite`, `OutsideRename` |

`check` compares those eight files with the commit in `model/sync` and prints `STALE` first when any differs, including uncommitted edits. The rows under a `STALE` banner still say `ok`, because they check the model as it was. That is not a pass: it ends with `NOT A PASS` and exit status 3.

## Read the result

Each row of `model/rows.tsv` is one question with a recorded answer.

- **gate** rows are expected to hold. A gate that breaks is a regression or a modelling error.
- **finding** rows are known defects in today's code: the rule is expected to break. A finding that now holds means the defect is fixed, or the model lost it.
- **mutant** rows (`check --self-test`) switch one guard off in the model. Each must break; that is the evidence the rule can fail at all.

`ok` means the verdict matches the record. `DIFF` means it does not, and the shortest path is printed in plain words. `check --trace F1` prints the path for any row.

Read every TLA+ result with the pstack `/statechart` skill (`/pstack:statechart` in Claude Code). It lays each broken rule out as its shortest path in plain words, and when everything passes it draws how the system moves between states. Run it on `model/SaveProtocol.tla` with `model/SaveProtocol.cfg`, the baseline with all five rules; for another row, copy that file and change the constants the row's `overrides` column names. If that skill is not installed, `check --trace <row>` gives the path without the chart.

Exit status: `0` all verdicts match and the covered code is unchanged; `1` a verdict differs, or a `--with` run breaks a gate; `3` verdicts match but the covered code changed.

## When the covered code changed

1. Read the diff of the covered files since the sync commit: `git diff $(cat .claude/skills/verify-save-protocol/model/sync) -- <file>`.
2. If the change only removes a guard the model already has a switch for, ask the model directly, without editing it: `check --with GuardDirty=FALSE` (the switches are `GuardHash` for the hash comparison in `saveActiveFile`, `GuardDirty` for `isDirty` in `flushFsChanges`, `GuardReload` for `isDirty` in `reloadFile`). It reruns the gates with that guard off, prints the path to any broken rule, and exits 1 if a gate breaks. A broken gate is the answer: the change is unsafe. Stop here and report it.
3. Otherwise, for each changed function in the table above, open its action in `model/SaveProtocol.tla` and make the action say what the code now does. Keep the rule of the model: one action is one stretch of JavaScript between two awaits, or one Rust command doing a single read or a single rename. A new `await` splits an action in two; a removed one merges two.
4. Run `check --self-test`. A gate that now shows `DIFF` is a regression in the change under review. Report it with its path; do not record it.
5. When the change is committed and the model describes the code at that commit, write the commit's hash into `model/sync`, in the same commit or the next. Never move it to make `STALE` go away, and never point it at a commit the model was not checked against.

Reviewing someone's uncommitted change ends at step 2 or 4 with a verdict. Leave `model/sync` and `rows.tsv` alone, and discard any model edits made only to ask the question unless the change is going to be kept.

Do not edit a rule, a bound or `rows.tsv` to turn a `DIFF` into an `ok`. Change `rows.tsv` only when a verdict has changed for a reason you can state: a finding was fixed, or a new defect is being recorded as a finding with its path.

## A real bug or a modelling error?

Take the printed path and walk it against the code, step by step.

- It is a **real bug** if every step is something the code can do in that order: each "OxideMD ..." step is the code after one `await`, each "Another program ..." step is an ordinary file write, each "You ..." step is a key or a click. Reproduce it in the app with the project's `verify-oxidemd` skill (`.claude/skills/verify-oxidemd/SKILL.md`) when the steps are slow enough for a person (anything without a step "inside" a single save or reload).
- It is a **modelling error** if a step cannot happen: the model lets two things interleave that the code does in one go, forgets a guard the code has, or keeps an event the code drops. Fix the action, not the rule.

## Recorded findings at the sync commit

Product code was not changed. Each of these is a defect to fix or accept.

| Row | Rule | In plain words | Seen in the real app |
|---|---|---|---|
| F1 | `NoSilentOverwrite` | Edit a file; another program changes it; open the same file again from the sidebar, the recent list or a file manager; save. No warning, and the other program's change is gone. `loadFile` stores a fresh hash on the tab that is already open without loading the content. | Yes |
| F2 | `NoSilentOverwrite` | Another program writes in the milliseconds between the hash check and the write, between the write and the hash refresh, or before the first hash has arrived. The check and the write are separate calls. | No (too fast to drive) |
| F3 | `NoLostEdits` | A reload is in flight (an outside change or the Reload button); the user enters edit mode and types before it lands; the reload then replaces the buffer. Leaving edit mode drops the typed text, and Save does nothing because the tab looks clean. | No (too fast to drive) |
| F4 | `NoFalseWarning` | After any reload, the next save warns "File changed on disk". Reloads update the tab's content but not `tab.diskHash`. | Yes |
| F5 | `TabNotStale` | An outside change that arrives while the tab is in edit mode, or within 1.5 s of an in-app save, is dropped and never looked at again, so a reading-mode tab keeps showing the old content. | Yes (edit-mode case) |
| F7 | `NoSilentOverwrite` | A reload leaves `tab.diskHash` at the hash of the content the file was opened with (the cause of F4). If the file later goes back to that content while the tab has unsaved edits, for example `git checkout` of the earlier branch, the save sees a matching hash and overwrites it with no warning. | Yes |
| F6 | `WatcherStaysArmed` | After OxideMD saves a file (a rename over the old file), or another program saves it by rename, the watch on that file is dead until another tab or folder opens or closes. With the file's folder open in the sidebar the watch survives (gate G6). | Yes |

## Scope

Verified: one tab on one file, up to 3 edits by the user and 3 writes by another program, every interleaving of the steps listed above.

Assumptions in the baseline gates, each lifted by one finding row:

- The user does not open the already-open file again (`Reopen`, lifted in F1 and G4).
- Another program never puts back content the file had before (`ExtRestore`, lifted in F7 and G4). Outside writes otherwise always produce new content.
- Other programs write only when no hash request, reload or save is in flight (`RaceExternal`, lifted in F2 and G5).
- The user acts only when nothing is in flight (`RaceUser`, lifted in F3).

Assumed throughout:

- A hash identifies its content.
- The watcher's 150 ms coalescing (`COALESCE_WINDOW`) is shorter than the frontend's 200 ms debounce, so an outside write after a reload's read always raises a new event. Changing either number breaks this.
- At most one reload and two hash requests are in flight at once.
- The watch is armed by the time the tab is usable.

Not covered: several tabs or files at once, untitled files and Save As, format on save, drafts and draft recovery, closing the window (there is no unsaved-changes prompt on that path; the draft is the only protection), delete and rename from the sidebar, failed saves, and two saves started at the same time. A pass says nothing about these.

## Files

- `model/SaveProtocol.tla`: the model. Every action carries the name of the function it stands for.
- `model/SaveProtocol.cfg`: the baseline constants with all five rules, for running the model with other TLA+ tools. `check` builds its own config per row and does not read this file; keep it in step with the `BASELINE` table in `scripts/check`.
- `model/rows.tsv`: the questions and their recorded answers.
- `model/sync`: the commit at which the model was last confirmed against the code.
- `scripts/check`: the runner. `check --help` lists its options.

`/pstack:maintain-formal-verification-skill` brings the model back in line after changes that did not recheck it.
