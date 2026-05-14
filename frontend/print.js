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
// webview is already done. So `afterprint` is the best available
// "printing finished" signal: the loader stays up until it fires and
// the success toast fires then (even on cancel — there's no way to
// tell). The only failures we can genuinely detect are a
// `render_preview` throw or a `window.print()` throw; those get an
// error toast instead.

import { invoke, convertFileSrc, state } from './state.js';
import { activeTab } from './tabs.js';
import { showToast } from './toast.js';

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

  // Local images arrive as `<img data-oxide-src="/abs/path">`; rewrite to
  // asset:// URLs so the webview can actually load them for the print.
  for (const img of printRoot.querySelectorAll('img[data-oxide-src]')) {
    img.src = convertFileSrc(img.dataset.oxideSrc);
  }

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
  // `body.print-friendly` selects the light print theme; the one-shot
  // afterprint listener tears it all back down (whether the user saved
  // the PDF or cancelled the dialog) so #print-root doesn't hold a
  // stale render or leave the print classes on <body>.
  document.body.classList.add('printing');
  document.body.classList.toggle('print-friendly', printerFriendly);

  // Shared teardown so the afterprint handler and the window.print()
  // throw path strip exactly the same state: print classes off <body>,
  // #print-root emptied, the one-shot listener detached, loader hidden.
  const teardown = () => {
    document.body.classList.remove('printing', 'print-friendly');
    printRoot.innerHTML = '';
    loaderOverlay.classList.add('hidden');
    window.removeEventListener('afterprint', onAfterPrint);
  };
  const onAfterPrint = () => {
    teardown();
    // Best-available "finished" signal — see the file header for why
    // this fires even when the user cancelled the dialog.
    showToast('Exported to PDF.', 'success');
  };
  window.addEventListener('afterprint', onAfterPrint);

  // The loader must actually paint before window.print(), which can
  // block the main thread while the native dialog spins up. Yield two
  // frames so the browser commits the just-shown overlay first.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    window.print();
  } catch {
    // window.print() itself threw — the dialog never opened, so
    // afterprint will never fire. Run the same teardown by hand and
    // surface the failure.
    teardown();
    showToast('Could not open the print dialog.', 'error');
  }
}
