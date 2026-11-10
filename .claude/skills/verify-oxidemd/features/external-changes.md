# External changes

When another program changes an open file, OxideMD reloads it in reading mode. It never reloads over unsaved edits, and it warns before a save would overwrite a change it has not shown the user.

## Sub-features

- `ext-reload` reloads a clean reading-mode tab when the file changes on disk.
- `ext-keep-edits` leaves a tab with unsaved edits alone when the file changes on disk.
- `ext-warn` shows `File changed on disk` before a save overwrites an outside change.
- `ext-manual-reload` reloads on `Reload` or `Ctrl+R`.
- `ext-no-false-warning` saves without a warning when the tab already shows the latest disk content.

## How to get to it (user POV)

- Edit the open file in another program, or let a sync tool, formatter or `git checkout` rewrite it.
- Choose `Reload` in the toolbar or press `Ctrl+R`.
- Save in OxideMD after the file changed outside.

## Driving it with oxv

Preconditions:

- A fresh launch of `/tmp/oxidemd-verify/main/docs/note.md` containing `# V1` and a paragraph `body`. Call the file `$D`.
- `$OXV wait "V1" --role heading` succeeds.
- No other tab and no folder is open.

- **Reload on an outside change.** Run `printf '# V2\n\nbody\n' > $D`, then `$OXV wait "V2" --role heading --timeout 5`. The heading appears within a second.
- **Keep unsaved edits.** Run `$OXV key ctrl+e`, `$OXV wait "Edit note.md" --role entry`, `$OXV key ctrl+End`, `$OXV type "mine"`, then `printf '# THEIRS\n' > $D` and `sleep 1`. `$OXV text "Edit note.md"` still ends with `mine` and does not contain `THEIRS`.
- **Warn before overwriting.** Run `$OXV key ctrl+s`, then `$OXV wait "File changed on disk" --role dialog --timeout 3`. The dialog has buttons `Cancel` and `Overwrite`. `cat $D` still prints `# THEIRS`.
- **Cancel keeps the outside change.** Run `$OXV press "Cancel"`. `cat $D` prints `# THEIRS` and `$OXV wait "Unsaved changes" --text` succeeds.
- **Overwrite replaces it.** Run `$OXV key ctrl+s`, `$OXV wait "File changed on disk" --role dialog`, `$OXV press "Overwrite"`, `$OXV wait "Saved" --text`. `cat $D` ends with `mine`.
- **Manual reload.** Run `$OXV key ctrl+e`, `$OXV wait "Edit note.md" --role entry --gone`, `printf '# V3\n' > $D`, `$OXV press "Reload current file"`, `$OXV wait "V3" --role heading`.
- **No false warning.** From a fresh launch: `printf '# V2\n\nbody\n' > $D`, `$OXV wait "V2" --role heading`, `$OXV key ctrl+e`, `$OXV wait "Edit note.md" --role entry`, `$OXV key ctrl+End`, `$OXV type "x"`, `$OXV key ctrl+s`. `$OXV wait "Saved" --text --timeout 3` succeeds with no dialog.
- **Reload after a save.** From a fresh launch: enter edit mode, type `x`, save, leave edit mode, `sleep 2`, then `printf '# V4\n' > $D`. `$OXV wait "V4" --role heading --timeout 5` succeeds.
- **Proof.** Run `$OXV snap ext-warning` and `$OXV shot ext-warning` while the dialog is open, and `$OXV keep $D ext-warning.note.md` to show the outside content was still on disk.

## Gotchas

- Wait at least 1.5 seconds after an in-app save before making an outside change. The app ignores change events for that long after its own save, by design.
- Known defect at commit `f9d4379`: **No false warning fails.** After an automatic reload, the next save shows `File changed on disk` although the tab already has the latest content.
- Known defect at commit `f9d4379`: **Reload after a save fails.** Once OxideMD has saved a file, later outside changes to it are not reloaded until another tab or folder is opened or closed. The same happens after another program replaces the file by renaming a new one over it: the first such change reloads, the second does not. `Reload` still works.
- Known defect at commit `f9d4379`: re-opening the file that is already open (`$OXV open $D`) between **Keep unsaved edits** and **Warn before overwriting** makes the save go through with no warning, and the outside change is lost. Do not add that step to this recipe except to test that defect.
- `printf > file` rewrites the file in place. A program that saves by renaming a new file over the old one behaves differently; test both when working on the watcher.
- With a folder open in the sidebar, the folder is watched too and the reload defects above may not reproduce. This recipe is for a single file with no folder.
