# Open and render

Opening a Markdown file shows it rendered in a tab named after the file. A second file opens in a second tab, and the user can move between tabs and close them.

## Sub-features

- `open-cli` opens the files named on the command line.
- `open-forward` opens a file handed to an already running instance.
- `open-render` renders headings, paragraphs and lists from the file.
- `tab-switch` moves between open tabs.
- `tab-close` closes a tab and returns to the welcome screen when it was the last one.

## How to get to it (user POV)

- Start OxideMD with a file path, or double-click a `.md` file in a file manager.
- Open a file from a file manager while OxideMD is already running.
- Choose `Open file` in the toolbar or press `Ctrl+O` and pick a file.
- Drop a `.md` file onto the window.
- Choose an entry in the welcome screen's recent list.
- Press `Ctrl+Tab` to switch tabs and `Ctrl+W` to close one.

## Driving it with oxv

Preconditions:

- No instance is running in the run directory (`$OXV stop`).
- `/tmp/oxidemd-verify/main/docs/note.md` contains `# Verify doc`, a paragraph `First paragraph.`, `## Second heading` and a two-item list.
- `/tmp/oxidemd-verify/main/docs/other.md` contains `# Other`.

- **Open from the command line.** Run `$OXV launch /tmp/oxidemd-verify/main/docs/note.md`. `$OXV show "note.md" --role "page tab"` prints one tab with the `selected` state.
- **Check the render.** Run `$OXV wait "Verify doc" --role heading` and `$OXV wait "Second heading" --role heading`. Both print a `heading`. `$OXV tree` shows `paragraph` with `text="First paragraph."` and two `list item` lines.
- **Check the status bar.** Run `$OXV show "Copy path to clipboard" --contains`. The name ends with the file's full path.
- **Open into the running instance.** Run `$OXV open /tmp/oxidemd-verify/main/docs/other.md`, then `$OXV wait "other.md" --role "page tab"`. The new tab is `selected` and `$OXV wait "Other" --role heading` succeeds.
- **Switch tabs.** Run `$OXV key ctrl+Tab`. `$OXV show "note.md" --role "page tab"` now has `selected`, and `$OXV wait "Verify doc" --role heading` succeeds.
- **Close tabs.** Run `$OXV key ctrl+w` twice. `$OXV wait "OxideMD" --role heading` shows the welcome screen and `$OXV show "note.md" --role "page tab"` finds nothing.
- **Proof.** After the switch step run `$OXV snap open-two-tabs` and `$OXV shot open-two-tabs`. The tree lists both tabs; the screenshot shows the tab strip and the rendered document.

## Gotchas

- `Open file`, `Ctrl+O`, drag and drop, and the recent list cannot be driven: they need a native file dialog, a pointer drag, or prior history. Report them as not verified.
- `press` on a tab is refused, because it would close the tab. Use `ctrl+Tab`.
- `oxv open` on a file that is already open only selects its tab. It also refreshes what the app believes is on disk for that file, which matters in [External changes](./external-changes.md).
- The window title follows the active tab, so do not use the title to tell two instances apart. Use the run directory.
