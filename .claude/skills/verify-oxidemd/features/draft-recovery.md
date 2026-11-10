# Draft recovery

While the user types, OxideMD keeps a draft of the unsaved buffer outside the document. If the app dies before a save, the next time that file is opened it offers to restore the draft.

## Sub-features

- `draft-write` stores the unsaved buffer shortly after the user stops typing.
- `draft-offer` offers the draft when the file is opened again.
- `draft-restore` puts the draft back in the editor as unsaved changes.
- `draft-discard` drops the draft and shows the saved file.
- `draft-clear` removes the draft once the edits are saved or discarded.

## How to get to it (user POV)

- Type in edit mode and pause for a second.
- Lose the app without saving: a crash, a killed process, or a closed window.
- Open the same file again.

## Driving it with oxv

Preconditions:

- A fresh launch of `/tmp/oxidemd-verify/main/docs/note.md` containing `# Draft test` and a paragraph. Call the file `$D` and the run directory `$R` (`/tmp/oxidemd-verify/main`).
- `ls $R/xdg/cache/oxidemd/drafts` prints nothing or fails.

- **Write a draft.** Run `$OXV key ctrl+e`, `$OXV wait "Edit note.md" --role entry`, `$OXV key ctrl+End`, `$OXV type "unsaved words"`, `sleep 1.2`. `ls $R/xdg/cache/oxidemd/drafts` lists one `.json` file whose `content` field ends with `unsaved words`.
- **Lose the app.** Run `$OXV crash`. `cat $D` does not contain `unsaved words`.
- **Offer on reopen.** Run `$OXV launch $D`, then `$OXV wait "Recover unsaved draft" --role dialog`. The dialog has buttons `Discard draft` and `Restore`.
- **Restore.** Run `$OXV press "Restore"`, then `$OXV wait "Edit note.md" --role entry`. `$OXV text "Edit note.md"` ends with `unsaved words`, `$OXV wait "Unsaved changes" --text` succeeds, and `cat $D` still lacks the words.
- **Clear on save.** Run `$OXV key ctrl+s`, `$OXV wait "Saved" --text`. `cat $D` ends with `unsaved words` and `ls $R/xdg/cache/oxidemd/drafts` lists no `.json` file.
- **Discard instead.** Repeat the first three steps, then run `$OXV press "Discard draft"`. The file opens in reading mode with the saved content and the drafts folder is empty.
- **Proof.** Run `$OXV keep <the draft .json> draft.json` before the crash, `$OXV snap draft-offer` and `$OXV shot draft-offer` while the dialog is open, and `$OXV keep $D draft-restored.note.md` after the save.

## Gotchas

- The draft is written about 0.8 seconds after the last keystroke. Crashing sooner loses that burst, by design; wait at least 1.2 seconds before `crash`.
- Use `$OXV crash`, not `$OXV stop`. `stop` deletes the sandboxed state, including the draft.
- After `crash`, relaunch without `stop` in between so the same state directory is reused.
- If the file on disk changed after the draft was written, the dialog is titled `Recover draft (file changed on disk)` and gains a `Cancel` button. That is a different, correct outcome, not this recipe.
- Closing the window from its close button was not driven here. There is no unsaved-changes prompt on that path at commit `f9d4379`; the draft is the only protection.
