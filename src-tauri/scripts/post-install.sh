#!/bin/sh
# Wired into RPM/DEB packaging via tauri.conf.json (bundle.linux.{deb,rpm}
# .postInstallScript). Runs after the new binary is written to disk.
#
# Why: dpkg/rpm don't kill running processes. With
# `tauri-plugin-single-instance` enabled, a user who clicks the launcher
# after upgrading just refocuses their *old* in-memory process — so they
# keep seeing pre-upgrade behavior until they manually quit. Killing the
# old process here makes the next launch guaranteed to be the new binary.
#
# Safe to run when nothing matches (pkill returns 1, masked to 0).
# Use -x for an exact match against the binary name to avoid hitting
# unrelated processes whose argv happens to contain "oxidemd".
pkill -x oxidemd 2>/dev/null || true
exit 0
