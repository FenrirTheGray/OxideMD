# OxideMD — Snap Store Publishing

## Status: Files created, needs build & publish from Linux

## What was done

Two files were added to enable building a Snap package for the Ubuntu Snap Store:

### `snap/snapcraft.yaml`
- Snap name: `oxidemd`
- Base: `core22` (matches the existing CI's ubuntu-22.04)
- Confinement: `strict` (required for Snap Store)
- Uses the `gnome` extension for GTK/GLib desktop integration
- Builds via `cargo build --release` in `src-tauri/` — the `tauri-build` crate in `build.rs` handles frontend embedding, so the full Tauri CLI is not needed
- Runtime WebKitGTK (`libwebkit2gtk-4.1-0`) is bundled via `stage-packages`
- `browser-support` plug with `allow-sandbox: true` is set — WebKitGTK runs its own internal sandbox which conflicts with Snap's sandbox without this
- `home` and `removable-media` plugs allow opening files from disk

### `snap/gui/oxidemd.desktop`
- Desktop launcher entry with Markdown file associations (`text/markdown`, `text/x-markdown`)
- Icon references the 256x256 PNG installed during build from `src-tauri/icons/128x128@2x.png`

## What needs to be done next

### 1. Build the snap (must be on Linux)
```bash
# Install snapcraft if not already present
sudo snap install snapcraft --classic

# From the project root
snapcraft
```
This produces a file like `oxidemd_1.3.2_amd64.snap`.

### 2. Test locally
```bash
sudo snap install oxidemd_1.3.2_amd64.snap --dangerous
oxidemd
```

### 3. If the app shows a blank window
The build uses `cargo build --release` directly instead of the Tauri CLI. If the frontend doesn't load, switch the build step in `snap/snapcraft.yaml` to:
```yaml
    override-build: |
      set -eu
      rustup default stable
      cargo install tauri-cli --version "^2" --locked
      cargo tauri build --no-bundle
      install -Dm755 src-tauri/target/release/oxidemd "$CRAFT_PART_INSTALL/usr/bin/oxidemd"
      install -Dm644 src-tauri/icons/128x128@2x.png "$CRAFT_PART_INSTALL/usr/share/icons/hicolor/256x256/apps/oxidemd.png"
```

### 4. Publish to the Snap Store
```bash
# Create account at https://snapcraft.io/account if needed
snapcraft login
snapcraft register oxidemd
snapcraft upload oxidemd_1.3.2_amd64.snap --release=stable
```

### 5. Optional: Add CI automation
The current GitHub Actions release workflow (`.github/workflows/release.yml`) does not build the snap. A new job could be added to automate snap builds on tag pushes using the `snapcraft` GitHub Action.

## Version sync reminder

The version `1.3.2` now lives in three places — keep them in sync:
- `src-tauri/Cargo.toml` (line 3)
- `src-tauri/tauri.conf.json` (line 4)
- `snap/snapcraft.yaml` (line 3)
