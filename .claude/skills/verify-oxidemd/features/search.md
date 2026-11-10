# Search in document

The search bar finds text in the open document, shows which match is current out of how many, and steps between matches.

## Sub-features

- `search-open` opens the search bar with the query field focused.
- `search-count` shows the current match and the total, such as `1 / 2`.
- `search-step` moves to the next or previous match.
- `search-close` closes the bar and returns to the document.

## How to get to it (user POV)

- Choose `Search` in the toolbar.
- Press `Ctrl+F`.
- Press `Escape` or choose the bar's close button to leave.

## Driving it with oxv

Preconditions:

- A fresh launch of `/tmp/oxidemd-verify/main/docs/note.md` containing `# Draft test` and a paragraph `alpha beta alpha`.
- The file is in reading mode.

- **Open.** Run `$OXV key ctrl+f`, then `$OXV wait "Search query" --role entry`. The entry has the `focused` state.
- **Count matches.** Run `$OXV type "alpha"`. `$OXV text "Search query"` prints `alpha` and `$OXV wait "1 / 2" --text` succeeds.
- **Step.** Run `$OXV press "Next match"`. `$OXV wait "2 / 2" --text` succeeds. Run `$OXV press "Previous match"`. `$OXV wait "1 / 2" --text` succeeds.
- **Close.** Run `$OXV key Escape`, then `$OXV wait "Search query" --role entry --gone --timeout 3`.
- **Proof.** Run `$OXV snap search-matches` and `$OXV shot search-matches` after the count step. The screenshot shows both matches highlighted.

## Gotchas

- Entering edit mode closes the search bar and opens a different one with a `Replace with` field. Run this recipe in reading mode, and treat edit-mode search and replace as a separate, unmapped feature.
- While the search field has focus, `type` goes into the query, not the document.
- The match highlight is painted, not part of the tree. Only the screenshot proves it.
- The toolbar entry point is `$OXV press "Search in document" --role "toggle button"`. It is a toggle: pressing it again closes the bar. Keep the role, because once the bar is open it carries the same name.
