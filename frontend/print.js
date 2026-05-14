// Print the active tab's rendered Markdown to PDF via the webview's
// native print dialog (which offers "Save as PDF" on Windows, macOS,
// and Linux). We render the current editor/file buffer fresh so
// unsaved edits are reflected, drop it into the isolated #print-root
// element, and let the @media print stylesheet hide all app chrome
// and print only that element. The "Printer Friendly PDFs" setting
// (state.config.printer_friendly) toggles a light-theme override
// scoped to the print subtree; when off, the PDF matches the app's
// current theme exactly.

import { invoke, convertFileSrc, state } from './state.js';
import { activeTab } from './tabs.js';

const printRoot = document.getElementById('print-root');

export async function printActiveTab() {
  const tab = activeTab();
  if (!tab) return;

  // Render the live buffer so unsaved edits make it into the PDF; if the
  // render command fails fall back to the tab's last-rendered HTML.
  let html;
  try {
    html = await invoke('render_preview', { content: tab.raw ?? '', path: tab.path ?? '' });
  } catch {
    html = tab.html || '';
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
  const onAfterPrint = () => {
    document.body.classList.remove('printing', 'print-friendly');
    printRoot.innerHTML = '';
    window.removeEventListener('afterprint', onAfterPrint);
  };
  window.addEventListener('afterprint', onAfterPrint);
  window.print();
}
