#!/usr/bin/env bash
# Builds signed APT + DNF repositories from a directory of release
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
  reprepro -b "$apt_build" includedeb stable "${debs[@]}"
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
  cat > "$HOME/.rpmmacros" <<EOF
%_signature gpg
%_gpg_name $GPG_KEY_ID
%__gpg_sign_cmd gpg --batch --no-verbose --no-armor --pinentry-mode loopback --passphrase-file $REPO_PASSPHRASE_FILE --no-secmem-warning --digest-algo sha256 -u "%{_gpg_name}" -sbo %{__signature_filename} %{__plaintext_filename}
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

# ---- Landing page with copy-paste install instructions ----
sed -e "s/__APT_PKG__/$apt_pkg/g" -e "s/__DNF_PKG__/$dnf_pkg/g" \
  "$SCRIPT_DIR/index.html" > "$OUTPUT/index.html"

echo "Repository tree built at: $OUTPUT"
find "$OUTPUT" -maxdepth 2 -mindepth 1 | sort
