#!/usr/bin/env bash
# Builds signed APT + DNF + pacman repositories from a directory of release
# .deb/.rpm packages, laid out ready to publish to GitHub Pages.
#
# The build is intentionally rebuilt-from-scratch every run: the caller
# downloads *all* published releases' packages into <incoming-dir>, and this
# script regenerates the full repository metadata from them. That keeps every
# released version installable (a package repo is cumulative state) without
# carrying forward any drift or half-written metadata from a previous run.
#
# Usage: build-repo.sh <incoming-dir> <output-dir>
#
# Required environment (set up by the calling workflow, which owns the secrets):
#   GNUPGHOME            - gnupg home with the signing key imported and a
#                          gpg-agent that has the passphrase preset
#   GPG_KEY_ID           - fingerprint / long id of the signing key
#   REPO_PASSPHRASE_FILE - file containing the key passphrase (for rpm signing,
#                          which signs via gpg loopback rather than the agent)
set -euo pipefail

INCOMING="${1:?incoming dir required}"
OUTPUT="${2:?output dir required}"
: "${GNUPGHOME:?GNUPGHOME must be set}"
: "${GPG_KEY_ID:?GPG_KEY_ID must be set}"
: "${REPO_PASSPHRASE_FILE:?REPO_PASSPHRASE_FILE must be set}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rm -rf "$OUTPUT"
mkdir -p "$OUTPUT"

# Public key in both encodings: binary keyring for apt's Signed-By, and
# ASCII-armored for dnf/rpm --import (which only accepts armored input).
gpg --export "$GPG_KEY_ID"         > "$OUTPUT/oxidemd.gpg"
gpg --export --armor "$GPG_KEY_ID" > "$OUTPUT/oxidemd.asc"

shopt -s nullglob
debs=("$INCOMING"/*.deb)
rpms=("$INCOMING"/*.rpm)

# Package names used in the install snippets. Detected from the artifacts so
# the copy-paste commands always match what's actually published; fall back to
# the known name if one half is missing.
apt_pkg="oxidemd"
dnf_pkg="oxidemd"

# ---- APT repository (reprepro: pool/ + signed dists/) ----
if (( ${#debs[@]} )); then
  apt_pkg="$(dpkg-deb -f "${debs[0]}" Package)"
  apt_build="$(mktemp -d)"
  mkdir -p "$apt_build/conf"
  cat > "$apt_build/conf/distributions" <<EOF
Origin: OxideMD
Label: OxideMD
Codename: stable
Suite: stable
Architectures: amd64
Components: main
Description: OxideMD APT repository (amd64)
SignWith: $GPG_KEY_ID
EOF
  # Tauri's .deb omits the Section/Priority control fields, and reprepro refuses
  # packages that lack them ("No section given ... skipping"). Supply defaults.
  reprepro -b "$apt_build" -S editors -P optional includedeb stable "${debs[@]}"
  mkdir -p "$OUTPUT/apt"
  cp -r "$apt_build/dists" "$apt_build/pool" "$OUTPUT/apt/"
  echo "APT repo built with package name: $apt_pkg"
else
  echo "No .deb packages found; skipping APT repo."
fi

# ---- DNF repository (rpmsign + createrepo_c) ----
if (( ${#rpms[@]} )); then
  dnf_pkg="$(rpm -qp --qf '%{NAME}' "${rpms[0]}")"
  mkdir -p "$OUTPUT/rpm"
  cp "${rpms[@]}" "$OUTPUT/rpm/"

  # Non-interactive detached signing: gpg in loopback mode reading the
  # passphrase from a file, so rpmsign never blocks on a pinentry prompt.
  # rpm execve()s the sign command without a PATH search, so the first token
  # must be the absolute path to gpg, not the bare name.
  gpg_bin="$(command -v gpg)"
  cat > "$HOME/.rpmmacros" <<EOF
%_signature gpg
%_gpg_name $GPG_KEY_ID
%__gpg_sign_cmd $gpg_bin --batch --no-verbose --no-armor --pinentry-mode loopback --passphrase-file $REPO_PASSPHRASE_FILE --no-secmem-warning --digest-algo sha256 -u "%{_gpg_name}" -sbo %{__signature_filename} %{__plaintext_filename}
EOF
  rpmsign --addsign "$OUTPUT"/rpm/*.rpm

  createrepo_c "$OUTPUT/rpm"
  # Sign repo metadata too, so security-conscious users can add
  # repo_gpgcheck=1 on top of the per-package gpgcheck=1.
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$REPO_PASSPHRASE_FILE" \
      -u "$GPG_KEY_ID" --detach-sign --armor "$OUTPUT/rpm/repodata/repomd.xml"
  echo "DNF repo built with package name: $dnf_pkg"
else
  echo "No .rpm packages found; skipping DNF repo."
fi

# ---- Pacman repository (makepkg + repo-add) ----
# Every .deb is repackaged through packaging/arch/PKGBUILD. Ubuntu's makepkg
# and pacman-package-manager packages provide makepkg/repo-add, so this runs on
# the same runner as the apt/dnf halves. --nodeps because the build host has no
# pacman database to check the (runtime-only) depends against; CARCH/PKGEXT are
# forced because Ubuntu's makepkg.conf defaults to .pkg.tar.gz, which the
# repo-add glob below would miss.
if (( ${#debs[@]} )); then
  mkdir -p "$OUTPUT/arch"
  for deb in "${debs[@]}"; do
    ver="$(dpkg-deb -f "$deb" Version)"
    sum="$(sha256sum "$deb" | cut -d' ' -f1)"
    pkg_build="$(mktemp -d)"
    cp "$SCRIPT_DIR/../arch/PKGBUILD" "$SCRIPT_DIR/../arch/oxidemd-bin.install" "$deb" "$pkg_build/"
    sed -i -e "s/^pkgver=.*/pkgver=$ver/" -e "s/^sha256sums=.*/sha256sums=('$sum')/" "$pkg_build/PKGBUILD"
    grep -q "^pkgver=$ver\$" "$pkg_build/PKGBUILD" && grep -q "^sha256sums=('$sum')\$" "$pkg_build/PKGBUILD"
    ( cd "$pkg_build" && CARCH=x86_64 PKGEXT=.pkg.tar.zst PKGDEST="$OUTPUT/arch" PACKAGER="Aleksandar Colovic <aleksandar.c.dev@gmail.com>" \
        makepkg --nodeps --ignorearch --sign --key "$GPG_KEY_ID" )
  done
  # The glob is in name order, not version order, and repo-add keeps the last
  # entry it sees per pkgname; --prevent-downgrade keeps the newest instead.
  repo-add --prevent-downgrade --sign --key "$GPG_KEY_ID" \
    "$OUTPUT/arch/oxidemd.db.tar.gz" "$OUTPUT"/arch/*.pkg.tar.zst
  # repo-add only warns when signing fails, and pacman's default SigLevel
  # accepts an unsigned database, so a missing .sig would go unnoticed.
  test -f "$OUTPUT/arch/oxidemd.db.tar.gz.sig"
  # Replace repo-add's symlinks (oxidemd.db -> oxidemd.db.tar.gz) with real
  # files so the tree works from any static host.
  for link in "$OUTPUT"/arch/*; do
    [[ -L $link ]] && cp --remove-destination "$(readlink -f "$link")" "$link"
  done
  echo "Pacman repo built."
else
  echo "No .deb packages found; skipping pacman repo."
fi

# ---- Landing page with copy-paste install instructions ----
cp "$SCRIPT_DIR/../../src-tauri/icons/128x128.png" "$OUTPUT/icon.png"
sed -e "s/__APT_PKG__/$apt_pkg/g" -e "s/__DNF_PKG__/$dnf_pkg/g" -e "s/__GPG_KEY_ID__/$GPG_KEY_ID/g" \
  "$SCRIPT_DIR/index.html" > "$OUTPUT/index.html"

echo "Repository tree built at: $OUTPUT"
find "$OUTPUT" -maxdepth 2 -mindepth 1 | sort
