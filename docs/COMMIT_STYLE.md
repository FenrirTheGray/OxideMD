# Commit Style

OxideMD uses a simplified [Conventional Commits](https://www.conventionalcommits.org/)
format. Keeping commit messages uniform makes the history easy to scan and easy
to turn into changelog entries.

## Format

```
<type>: <description>
```

## Types

| Type       | Use for                                                              |
| ---------- | ------------------------------------------------------------------- |
| `feat`     | A new feature                                                        |
| `fix`      | A bug fix                                                            |
| `docs`     | Documentation-only changes                                           |
| `style`    | Changes that don't affect meaning (whitespace, formatting, …)        |
| `refactor` | A code change that neither fixes a bug nor adds a feature            |
| `perf`     | A change that improves performance                                   |
| `test`     | Adding or correcting tests                                           |
| `chore`    | Build process, tooling, or dependency changes                        |

## Rules

1. **No scopes.** Keep the type plain — write `feat:`, not `feat(settings):`.
2. **Lowercase description.** Start the description in lowercase.
3. **Imperative mood.** Write "add feature", not "adds" or "added".
4. **No trailing period.**

## Examples

- `feat: drag and drop image import`
- `fix: cap tracked paths to bound memory on large checkouts`
- `perf: debounce window-resize icon sync to the trailing edge`
- `docs: rewrite project documentation`
- `chore: format codebase and update dependencies`

See [Contributing](CONTRIBUTING.md) for the surrounding pull-request workflow.
