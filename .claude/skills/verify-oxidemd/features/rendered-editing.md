# Rendered editing

Edit mode draws the document the way it reads and lets the user type into it. Markdown markup is hidden until the caret reaches it. A Source toggle switches to the Markdown source with its preview pane, and a task checkbox toggles when it is clicked.

## Sub-features

- `rendered-default` enters edit mode in rendered editing, with the buffer unchanged.
- `rendered-toggle` switches between rendered and source editing without changing the buffer, and remembers the choice.
- `rendered-task` ticks and unticks a task checkbox, changing one character of the file.

## How to get to it (user POV)

- Choose `Edit` in the toolbar or press `Ctrl+E`.
- Choose `Source` in the edit toolbar or press `Ctrl+Shift+R`.
- Click a task checkbox in the rendered editor.

## Driving it with oxv

Preconditions:

- A fresh launch of `/tmp/oxidemd-verify/main/docs/tasks.md` containing `# Tasks`, a blank line, `Some **bold** text.`, a blank line, `Dash — here.` (an em dash, written into the file from the shell), a blank line, `- [ ] only task`, a blank line, and `Last line.` followed by a newline.
- A copy of the file as launched: `cp /tmp/oxidemd-verify/main/docs/tasks.md /tmp/oxidemd-verify/main/tasks.orig.md`.
- `$OXV wait "Saved" --text` succeeds.

- **Enter rendered editing.** Run `$OXV press "Toggle edit mode"`, then `$OXV wait "Edit tasks.md" --role entry`. `$OXV show "Source mode"` has no `pressed` state, `$OXV show "Show preview pane"` has no `enabled` state, and `$OXV wait "Saved" --text` still succeeds. `$OXV show "Task done"` prints a `check box`.
- **Move the caret to the end.** Run `$OXV key ctrl+End`. `$OXV show "Source mode"` still answers and `$OXV wait "Saved" --text` succeeds.
- **Switch to source.** Run `$OXV press "Source mode"`. `$OXV show "Source mode"` has `pressed`, `$OXV show "Hide preview pane"` has `enabled`, `$OXV show "Task done"` finds nothing, and `$OXV wait "Saved" --text` succeeds.
- **Switch back with the shortcut.** Run `$OXV key ctrl+shift+r`. `$OXV show "Source mode"` has no `pressed` state, `$OXV show "Task done"` prints a `check box` again, and `$OXV wait "Saved" --text` succeeds.
- **Tick the task.** Run `$OXV press "Task done"`. `$OXV show "Task done"` has `checked`, `$OXV wait "Unsaved changes" --text` succeeds, and `$OXV show "Edit tasks.md" --role entry` has `focused`.
- **Undo and redo.** Run `$OXV key ctrl+z`. `$OXV show "Task done"` has no `checked` state and `$OXV wait "Saved" --text` succeeds. Run `$OXV key ctrl+shift+z`. `$OXV show "Task done"` has `checked`.
- **Save.** Run `$OXV key ctrl+s`, then `$OXV wait "Saved" --text`. `cmp -l /tmp/oxidemd-verify/main/tasks.orig.md /tmp/oxidemd-verify/main/docs/tasks.md` prints exactly one line, ending in `40 170` (a space became `x`).
- **Proof.** Run `$OXV snap rendered` and `$OXV shot rendered` after entering rendered editing, `$OXV shot rendered-source` after switching to source, and `$OXV keep /tmp/oxidemd-verify/main/docs/tasks.md rendered-task.tasks.md` after the save.

## Gotchas

- `press "Task done"` needs exactly one task in the document; with several the name is ambiguous. It is an accessibility press, which sends the same click a pointer does, but it is not a pointer: report a pointer click as not verified.
- The press redraws the checkbox, so `press` prints `<element no longer in the tree>`. Read the new state with `show`.
- `text "Edit <file name>"` returns the Markdown source in both modes: rendered editing hides markup from view, not from the tree. Only a screenshot proves what is drawn; the `Task done` check box, which exists only in rendered editing, is the tree's sign of the mode.
- The editing mode is saved in the config. A fresh launch starts rendered; a relaunch with `stop --keep-state` starts in the mode it was left in.
- A web view that stops answering after a caret move is a crash, not slowness. `coredumpctl list` shows a `WebKitWebProcess` entry when that happens. The known trigger is a non-editable element inside the editor, a character outside Latin-1 in the document (an em dash) and the caret at the end, so add `Dash — here.` as a line of the test document when a change touches how the rendered editor draws.
