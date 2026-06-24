// Print the active tab's rendered Markdown to PDF via the webview's
// native print dialog (which offers "Save as PDF" on Windows, macOS,
// and Linux). We render the current editor/file buffer fresh so
// unsaved edits are reflected, drop it into the isolated #print-root
// element, and let the @media print stylesheet hide all app chrome
// and print only that element. The "Printer Friendly PDFs" setting
// (state.config.printer_friendly) toggles a light-theme override
// scoped to the print subtree; when off, the PDF matches the app's
// current theme exactly.
//
// Progress / completion feedback: a loader overlay stays up for the
// whole export and a toast fires when it ends. Platform reality — the
// webview gives us NO signal that distinguishes "user saved the PDF"
// from "user cancelled the print dialog", and the OS spooler's actual
// file write (e.g. Windows "Microsoft Print to PDF") happens after the
// webview is already done. So "printing finished" is the best signal
// we can hope for, and on WebKitGTK even that is fragile: the
// `afterprint` event is documented to skip-fire on dialog cancel
// (Esc), which would leave the loader up and `.printing` on <body>
// indefinitely — the app appears frozen.
//
// We layer three teardown signals, idempotent so only the first wins:
//   1. matchMedia('print') change listener — primary. When the print
//      media stops matching the dialog has closed (save OR cancel).
//      More reliable than `afterprint` on WebKitGTK/Chromium-Linux.
//   2. `afterprint` event — fallback for browsers where matchMedia
//      misfires (some older WebKit builds).
//   3. 60-second safety timer — last resort if both above silently
//      fail. Better to flash the user back to a working app a minute
//      late than strand them forever.
//
// The only failures we can genuinely detect are a `render_preview`
// throw or a `window.print()` throw; those get an error toast instead.

import { invoke, state } from "../core/state.ts";
import { activeTab } from "../ui/tabs.ts";
import { hydrateImages } from "../core/tab-state.ts";
import { showToast } from "../ui/toast.ts";

const printRoot = document.getElementById('print-root');
const loaderOverlay = document.getElementById('print-loader-overlay');

export async function printActiveTab() {
  const tab = activeTab();
  if (!tab) return;

  // Show the loader immediately — the export is about to do async work
  // (render_preview) and then block the main thread on window.print().
  loaderOverlay.classList.remove('hidden');

  // Render the live buffer so unsaved edits make it into the PDF. If the
  // render command fails fall back to the tab's last-rendered HTML; if
  // there's no usable fallback either, there's nothing to print — hide
  // the loader, surface an error toast, and bail (don't pop an empty
  // PDF dialog).
  let html;
  try {
    html = await invoke('render_preview', { content: tab.raw ?? '', path: tab.path ?? '' });
  } catch {
    if (tab.html) {
      html = tab.html;
    } else {
      loaderOverlay.classList.add('hidden');
      showToast('Failed to render Markdown for export.', 'error');
      return;
    }
  }
  printRoot.innerHTML = html;

  // Resolve local images to asset:// URLs; remote images print only if the
  // user has enabled them (consistent with on-screen rendering) — see
  // hydrateImages.
  hydrateImages(printRoot);

  // Printer-friendly = light background / dark text. Default is on, so
  // only an explicit `false` opts into "match the app's current theme".
  // The class goes on <body> (see the afterprint handler below) rather
  // than #print-root so the @media print rules can flip the page-canvas
  // background too — otherwise a dark-theme PDF prints as a dark block
  // sitting in a white margin band.
  const printerFriendly = state.config?.printer_friendly !== false;

  // Wait for any not-yet-loaded images to settle before printing so they
  // aren't missing from the PDF, but cap the wait at ~2s so a slow or
  // broken image can't hang the print dialog forever.
  const imgs = [...printRoot.querySelectorAll('img')];
  const pending = imgs.filter(i => !i.complete).map(i => new Promise(res => { i.onload = i.onerror = res; }));
  if (pending.length) {
    await Promise.race([Promise.all(pending), new Promise(res => setTimeout(res, 2000))]);
  }

  // `body.printing` lets the stylesheet flip into print-isolation and
  // `body.print-friendly` selects the light print theme; the teardown
  // below tears it all back down (whether the user saved the PDF or
  // cancelled the dialog) so #print-root doesn't hold a stale render
  // or leave the print classes on <body>.
  document.body.classList.add('printing');
  document.body.classList.toggle('print-friendly', printerFriendly);

  // Three teardown signals (see file header) all funnel into one
  // idempotent runner; whichever fires first wins. Detaches the rest
  // so they can't double-fire toasts or trip over a clean DOM.
  const printMql = window.matchMedia('print');
  let safetyTimer = 0;
  let didTeardown = false;
  const teardown = () => {
    if (didTeardown) return;
    didTeardown = true;
    document.body.classList.remove('printing', 'print-friendly');
    printRoot.innerHTML = '';
    loaderOverlay.classList.add('hidden');
    window.removeEventListener('afterprint', onAfterPrint);
    printMql.removeEventListener('change', onMqlChange);
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = 0; }
  };

  const finish = () => {
    teardown();
    // Best-available "finished" signal — see the file header for why
    // this fires even when the user cancelled the dialog.
    showToast('Exported to PDF.', 'success');
  };

  // Primary signal. The first change fires `matches: true` as the
  // dialog mounts and applies print media; the second fires
  // `matches: false` when it dismounts (save OR cancel/Esc). We only
  // teardown on the false transition.
  const onMqlChange = (e) => {
    if (e.matches) return;
    finish();
  };
  printMql.addEventListener('change', onMqlChange);

  // Fallback signal.
  const onAfterPrint = () => finish();
  window.addEventListener('afterprint', onAfterPrint);

  // Last-resort signal: if neither of the above ever fires, force
  // teardown after 60s so the user can interact with the app again.
  // No toast here — this path means we don't know what happened.
  safetyTimer = window.setTimeout(() => {
    if (didTeardown) return;
    teardown();
    showToast('Print dialog did not report completion — the app has been restored.', 'error');
  }, 60_000);

  // The loader must actually paint before window.print(), which can
  // block the main thread while the native dialog spins up. Yield two
  // frames so the browser commits the just-shown overlay first.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    window.print();
  } catch {
    // window.print() itself threw — the dialog never opened, so
    // neither signal will fire. Run the same teardown by hand and
    // surface the failure.
    teardown();
    showToast('Could not open the print dialog.', 'error');
  }
}
