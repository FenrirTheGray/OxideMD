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
3. Commit the bump (see the [Commit Style Guide](COMMIT_STYLE.md)).
4. Tag the release and push the tag:

   ```bash
   git tag v4.4.0
   git push origin v4.4.0
   ```

5. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds the
   cross-platform artifacts (`.msi`/`.exe`, `.dmg`, `.AppImage`/`.deb`/`.rpm`,
   and the Arch `.pkg.tar.zst` packages) and creates a **draft** GitHub release
   with them attached.
6. Review the draft release, then publish it.

## Arch packaging follow-up

The same workflow builds the two Arch packages and, after uploading them, opens
a pull request that syncs the committed PKGBUILDs (version and checksums) to the
new release. Merge that PR so the in-repo PKGBUILDs match the release. The full
mechanism is documented in [`packaging/aur/README.md`](../packaging/aur/README.md).

For how changes should be shaped before a release, see the
[Code Style](CODE_STYLE.md) guide.
