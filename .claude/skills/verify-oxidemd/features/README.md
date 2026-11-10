# OxideMD verification map

This directory is the maintained source for verifying what a user can do in OxideMD. Read this index before driving the app, then follow the matching feature file as the recipe.

## Baseline preconditions

- The debug build is current: `$OXV build`, where `OXV=.claude/skills/verify-oxidemd/scripts/oxv`.
- Test documents live in `/tmp/oxidemd-verify/main/docs/`. Each recipe creates the files it needs.
- The instance was started by this run with `$OXV launch <file>` and `$OXV doctor` prints only `ok` lines.
- Never drive an OxideMD window this run did not start.

## Driving conventions

- Start every recipe from a fresh launch unless its preconditions say otherwise: `$OXV stop`, write the document, `$OXV launch <file>`.
- Treat every command as literal. Keep quoted names unchanged.
- Find elements by accessible name and role, never by position.
- After `type`, read the editor back with `$OXV text "Edit <file name>"` before relying on what was typed.
- External changes are made by writing the file from the shell, which is what another program would do.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is a tree snapshot (`$OXV snap <label>`) and a screenshot (`$OXV shot <label>`).
- Disk proof is a copy of the file (`$OXV keep <file> <label>`), taken after the UI reports the result.
- Record the feature ID and the entry point with every artifact.
- Report an entry point that cannot be driven with the command you tried and the reason.
- Do not report a skipped entry point as verified through a different one.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behaviour. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behaviour.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with oxv` starts with `Preconditions:` and uses labelled bullets that pair each user action with an exact command and an observable result.
4. `Gotchas` lists traps that can waste or invalidate a run, and known defects that make a step fail today.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands and observable proof. A step that fails because of a defect stays in the recipe as written; the defect goes in `Gotchas`.

## Features

- [Open and render](./open-and-render.md) covers opening files from the command line and into a running instance, tabs, and the rendered view.
- [Edit and save](./edit-and-save.md) covers edit mode, typing, saving, the saved/unsaved indicators, and closing with unsaved changes.
- [External changes](./external-changes.md) covers live reload when another program changes the file, and the warning before overwriting such a change.
- [Draft recovery](./draft-recovery.md) covers the crash-safe draft and the recovery prompt on the next launch.
- [Search in document](./search.md) covers the search bar, match counting and closing it.

Not mapped yet: folder sidebar and project search, outline, settings and themes, print and HTML export, image paste and drop, formatting toolbar actions, zoom, keyboard shortcut rebinding, updates.
