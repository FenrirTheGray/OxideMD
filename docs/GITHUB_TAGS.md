# GitHub Tags & Releases

This is the procedure for versioning and cutting a release of OxideMD.

## Versioning

We follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **MAJOR** — incompatible or structural changes.
- **MINOR** — backwards-compatible new features.
- **PATCH** — backwards-compatible bug fixes.

## Tag format

Release tags are the version prefixed with `v`:

- **Format:** `v<MAJOR>.<MINOR>.<PATCH>`
- **Examples:** `v4.4.0`, `v4.4.1`, `v5.0.0`

## Release process

1. Update `CHANGELOG.md` with the new version and its notes.
2. Bump the version so the manifests agree:
   - `src-tauri/tauri.conf.json` (the source of truth the release build reads)
   - `src-tauri/Cargo.toml`
   - `src-tauri/Cargo.lock` (the `oxidemd` package entry — runs automatically on the
     next `cargo` build, or edit it to match)
   - `packaging/arch/PKGBUILD` (`pkgver`, so a local `makepkg` fetches the
     matching `.deb`; the publish workflow overrides it per release anyway)
3. Commit the bump (see the [Commit Style Guide](COMMIT_STYLE.md)).
4. Tag the release and push the tag:

   ```bash
   git tag v4.4.0
   git push origin v4.4.0
   ```

5. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds the
   cross-platform artifacts (`.msi`/`.exe`, `.dmg`, `.AppImage`/`.deb`/`.rpm`)
   and creates a **draft** GitHub release with them attached. The release notes
   are composed automatically from the version's `CHANGELOG.md` section (with a
   tagline and install footer), so the changelog entry from step 1 is what
   ships on the release page.
6. Review the draft release, then publish it. Publishing triggers
   `.github/workflows/repo-publish.yml`, which rebuilds the signed apt/dnf/pacman
   repositories from every published release and deploys them to GitHub Pages.

For how changes should be shaped before a release, see the
[Code Style](CODE_STYLE.md) guide.
