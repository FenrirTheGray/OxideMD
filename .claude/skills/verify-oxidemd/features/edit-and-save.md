# Edit and save

Edit mode shows the Markdown source beside a live preview. Typing marks the tab as unsaved, saving writes the file and marks it saved, and closing a tab with unsaved changes asks first.

## Sub-features

- `edit-enter` switches a file between reading and editing.
- `edit-type` puts typed text in the buffer and marks the tab unsaved.
- `edit-save` writes the buffer to disk and marks the tab saved.
- `edit-discard` reverts the buffer to the saved content after a confirmation.
- `edit-close-dirty` asks to save, discard or cancel when a tab with unsaved changes is closed.

## How to get to it (user POV)

- Choose `Edit` in the toolbar or press `Ctrl+E`.
- Type in the editor.
- Choose `Save` in the edit toolbar or press `Ctrl+S`.
- Choose `Discard` in the edit toolbar.
- Press `Ctrl+W` or the tab's close button with unsaved changes.

## Driving it with oxv

Preconditions:

- A fresh launch of `/tmp/oxidemd-verify/main/docs/note.md` containing `# Verify doc`, a blank line, and `First paragraph.` followed by a newline.
- `$OXV wait "Saved" --text` succeeds.

- **Enter edit mode.** Run `$OXV press "Toggle edit mode"`, then `$OXV wait "Edit note.md" --role entry`. The entry has the `focused` state, `$OXV show "Toggle edit mode"` has `pressed`, and `$OXV show "Save file"` has no `enabled` state.
- **Type.** Run `$OXV key ctrl+End` and `$OXV type "Added by oxv"`. `$OXV text "Edit note.md"` ends with `Added by oxv`. `$OXV wait "Unsaved changes" --text` succeeds and `$OXV show "Save file"` has `enabled`.
- **Check disk is untouched.** Run `cat /tmp/oxidemd-verify/main/docs/note.md`. It does not contain `Added by oxv`.
- **Save with the button.** Run `$OXV press "Save file"`, then `$OXV wait "Saved" --text`. `cat` of the file now ends with `Added by oxv`, and `$OXV show "Save file"` has no `enabled` state.
- **Save with the shortcut.** Run `$OXV type " again"`, `$OXV key ctrl+s`, `$OXV wait "Saved" --text`. The file ends with `Added by oxv again`.
- **Leave edit mode.** Run `$OXV key ctrl+e`, then `$OXV wait "Edit note.md" --role entry --gone`. `$OXV tree` shows the added text in the rendered document.
- **Close with unsaved changes.** Run `$OXV key ctrl+e`, `$OXV wait "Edit note.md" --role entry`, `$OXV type "x"`, `$OXV key ctrl+w`, then `$OXV wait "Unsaved changes" --role dialog`. The dialog has buttons `Cancel`, `Discard` and `Save`. Run `$OXV press "Discard"`. The tab closes, `$OXV wait "OxideMD" --role heading` shows the welcome screen, and the file on disk is unchanged since the last save.
- **Proof.** Run `$OXV snap edit-unsaved` and `$OXV shot edit-unsaved` after the type step, then `$OXV snap edit-saved`, `$OXV shot edit-saved` and `$OXV keep /tmp/oxidemd-verify/main/docs/note.md edit-saved.note.md` after the save step.

## Gotchas

- `Ctrl+End` puts the caret after the file's final newline, so typed text starts a new last line. Assert on the file's tail, not on an exact byte count.
- The `Saved` label alone is not proof of a save. Read the file.
- Typing right after `press "Toggle edit mode"` can land before the editor has focus. Wait for the `entry` first.
- The edit-toolbar `Discard unsaved changes` button opens a `Discard changes` dialog; the tab-close dialog is titled `Unsaved changes`. They are different dialogs with a same-named `Discard` button.
- An untitled file (`Create new file`) saves through a native dialog, which cannot be driven. Report `edit-save` for untitled files as not verified.
