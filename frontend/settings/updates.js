// Update check + in-app install pipeline for the About tab.
//
// Split out of settings.js: this is the most self-contained region — it
// only needs `invoke`/`listen` and its own DOM nodes (#update-status,
// #btn-check-updates). settings.js imports `checkForUpdates` (button wiring)
// and `hideUpdateStatus` (called when opening the dialog).

import { invoke, listen } from "../state.js";

const UPDATE_ICON_AVAILABLE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>';
const UPDATE_ICON_CURRENT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const UPDATE_ICON_ERROR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

function showUpdateStatus(kind, html) {
  const el = document.getElementById("update-status");
  el.className = `update-status ${kind}`;
  el.innerHTML = html;
  void el.offsetWidth; // restart animation
  el.classList.remove("hidden");
}

export function hideUpdateStatus() {
  const el = document.getElementById("update-status");
  el.classList.add("hidden");
  el.innerHTML = "";
}

// Sentinel string the Rust side returns when in-app install can't
// proceed (currently RPM/DEB on Linux — see commands.rs
// `UPDATE_UNSUPPORTED_PACKAGE`). Keep in sync with the constant there.
const UPDATE_UNSUPPORTED_PACKAGE = "UNSUPPORTED_PACKAGE";
const RELEASES_URL = "https://github.com/FenrirTheGray/OxideMD/releases/latest";

function openReleasesPage() {
  invoke("open_url", { url: RELEASES_URL });
}

function wireFallbackButton() {
  const btn = document.querySelector("#update-status .update-download");
  if (btn) btn.addEventListener("click", openReleasesPage);
}

// Drives the install phase after the user clicks Install on an
// available update. Swaps the static status row for a progress bar,
// streams `update-progress` events into it, and either lets the OS
// restart the app on success or falls back to "open the releases
// page" on the two failure shapes we want to handle distinctly:
// unsupported package (no in-app path for RPM/DEB) vs. anything else
// (network, signature, disk, …).
async function installUpdate(version) {
  const el = document.getElementById("update-status");
  el.className = "update-status available";
  el.innerHTML = `
    ${UPDATE_ICON_AVAILABLE}
    <span class="update-message">Installing <span class="update-version">v${version}</span>… <span class="update-progress-text">starting</span></span>
    <div class="update-progress-bar" aria-hidden="true"><div class="update-progress-fill"></div></div>
  `;
  const progressText = el.querySelector(".update-progress-text");
  const progressFill = el.querySelector(".update-progress-fill");

  // Listener returns an unlisten fn; tear it down on either outcome
  // so a later check/install doesn't accumulate stale handlers.
  const unlisten = await listen("update-progress", (event) => {
    const payload = event.payload || {};
    const downloaded = Number(payload.downloaded) || 0;
    const total = Number(payload.total) || 0;
    if (total > 0) {
      const pct = Math.min(100, Math.round((downloaded / total) * 100));
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `${pct}%`;
    } else {
      // No content-length header — show downloaded bytes as a rough
      // signal that something is happening.
      progressText.textContent = `${(downloaded / 1024 / 1024).toFixed(1)} MB`;
      progressFill.style.width = "100%";
      progressFill.classList.add("indeterminate");
    }
  });

  try {
    await invoke("download_and_install_update");
    // Success path diverges in Rust (`app.restart()`), so we never
    // resume here in practice. If we do, leave the UI as-is.
  } catch (e) {
    const errStr = String(e);
    if (errStr === UPDATE_UNSUPPORTED_PACKAGE) {
      showUpdateStatus(
        "available",
        `
        ${UPDATE_ICON_AVAILABLE}
        <span class="update-message">In-app update isn't available for this install. Download <span class="update-version">v${version}</span> from the releases page and reinstall.</span>
        <button type="button" class="update-download">Open releases</button>
      `,
      );
    } else {
      showUpdateStatus(
        "error",
        `
        ${UPDATE_ICON_ERROR}
        <span class="update-message">Update failed: ${errStr.replace(/</g, "&lt;")}</span>
        <button type="button" class="update-download">Open releases</button>
      `,
      );
    }
    wireFallbackButton();
  } finally {
    unlisten();
  }
}

export async function checkForUpdates() {
  const btn = document.getElementById("btn-check-updates");
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56"/><polyline points="21 3 21 9 15 9"/></svg>Checking…';
  hideUpdateStatus();
  try {
    const result = await invoke("check_for_updates");
    if (result.available) {
      showUpdateStatus(
        "available",
        `
        ${UPDATE_ICON_AVAILABLE}
        <span class="update-message">Update available: <span class="update-version">v${result.version}</span></span>
        <button type="button" class="update-download">Install</button>
      `,
      );
      document
        .querySelector("#update-status .update-download")
        .addEventListener("click", () => installUpdate(result.version));
    } else {
      showUpdateStatus(
        "current",
        `${UPDATE_ICON_CURRENT}<span class="update-message">You are running the latest version.</span>`,
      );
    }
  } catch (e) {
    showUpdateStatus(
      "error",
      `${UPDATE_ICON_ERROR}<span class="update-message">Failed to check for updates: ${String(e).replace(/</g, "&lt;")}</span>`,
    );
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}
