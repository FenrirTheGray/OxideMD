// Insert prompts for the edit toolbar: table, link, image, code block.
//
// Each renders its form into the shared confirm overlay (ui/confirm.ts), so
// showModal()'s focus trap, the app-wide Tab wrap, Escape and the shortcut
// guard come for free. Insert resolves the entered values, Cancel / Escape
// resolve null, and the backdrop doesn't dismiss any of them. Kept in the
// main bundle, not the lazy editor chunk, because app.ts routes OS file
// drops into the image prompt.
//
// Field values are set through `.value`, never interpolated into the body
// HTML, so selected text or a clipboard URL can't inject markup.

import { invoke, confirmSaveBtn, IMAGE_EXTS, pathExtension } from '../core/state.ts';
import { setConfirmContents, openConfirmDialog } from './confirm.ts';
import { wireCustomNumber } from '../settings/controls.ts';

const insertBtn = confirmSaveBtn as HTMLButtonElement;

function openInsertPrompt(title: string, bodyHtml: string) {
  setConfirmContents({
    title,
    bodyHtml,
    saveLabel: 'Insert',
    cancelHidden: false,
    discardHidden: true,
    primary: 'save',
    backdropCloses: false,
  });
  return openConfirmDialog();
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement;

// ── Table ─────────────────────────────────────────────────────────────
// Size plus one header text field per column. Rows count the body only; the
// header row is always there. A blank header means "use the placeholder".
const TABLE_MAX = 50;
// A −/value/+ stepper in the settings dialog's style (settings.css
// .custom-number, wired by wireCustomNumber), in place of a native number
// input whose spin arrows don't match the app. Captioned by a plain span,
// not a <label>: a label's click would land on its first control, the −
// button, so the value input carries the aria-label instead.
const stepper = (id: string, label: string) => `<span class="custom-number" id="${id}" data-min="1" data-max="${TABLE_MAX}" data-step="1">
    <button type="button" class="custom-number-btn decrement" aria-label="Fewer ${label.toLowerCase()}">&#x2212;</button>
    <input class="custom-number-value" id="${id}-value" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" aria-label="${label}">
    <button type="button" class="custom-number-btn increment" aria-label="More ${label.toLowerCase()}">&#x2B;</button>
  </span>`;
export function promptTable(): Promise<{ rows: number, headers: string[] } | null> {
  const promise = openInsertPrompt('Insert table', `<span class="confirm-table-size">
      <span>Rows (below header)${stepper('table-rows', 'Rows')}</span>
      <span>Columns${stepper('table-cols', 'Columns')}</span>
    </span>
    <span id="table-headers" class="confirm-table-headers"></span>`);
  for (const [id, start] of [['table-rows', 2], ['table-cols', 3]] as const) {
    const box = document.getElementById(id);
    wireCustomNumber(box);
    (box as any).value = start;
  }
  // Read the visible text, not the stepper's committed value: it tracks
  // typing live (the stepper only commits on blur / Enter).
  const rows = field('table-rows-value');
  const cols = field('table-cols-value');
  // Typed values bypass min/max, so clamp; blank or junk counts as 1.
  const size = (input) => Math.min(TABLE_MAX, Math.max(1, Math.floor(Number(input.value)) || 1));
  // One header field per column, following the Columns value as it's typed.
  // Fields past the count are hidden rather than removed, so shrinking and
  // growing the count back doesn't lose what was typed in them.
  const headerBox = document.getElementById('table-headers');
  const headers = headerBox.children as HTMLCollectionOf<HTMLInputElement>;
  const syncHeaders = () => {
    const n = size(cols);
    while (headers.length < n) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'confirm-text-input';
      input.spellcheck = false;
      input.placeholder = `Header ${headers.length + 1}`;
      input.setAttribute('aria-label', input.placeholder);
      headerBox.append(input);
    }
    for (let i = 0; i < headers.length; i++) headers[i].hidden = i >= n;
  };
  syncHeaders();
  cols.addEventListener('input', syncHeaders);
  // The −/+ buttons rewrite the text without an input event.
  document.getElementById('table-cols').addEventListener('click', syncHeaders);
  return promise.then((decision) => decision === 'save'
    ? { rows: size(rows), headers: Array.from(headers).slice(0, size(cols)).map((h) => h.value) }
    : null);
}

// ── Link ──────────────────────────────────────────────────────────────
// Text and URL, prefilled by the caller (selection, clipboard URL). Insert
// stays disabled until there is a URL.
export function promptLink({ text, url }: { text: string, url: string }): Promise<{ text: string, url: string } | null> {
  const promise = openInsertPrompt('Insert link', `<span class="confirm-fields">
      <label>Text<input type="text" id="link-text" class="confirm-text-input" spellcheck="false" autocomplete="off"></label>
      <label>URL<input type="text" id="link-url" class="confirm-text-input" spellcheck="false" autocomplete="off" placeholder="https://"></label>
    </span>`);
  const textIn = field('link-text');
  const urlIn = field('link-url');
  textIn.value = text;
  urlIn.value = url;
  const sync = () => { insertBtn.disabled = !urlIn.value.trim(); };
  urlIn.addEventListener('input', sync);
  sync();
  return promise.then((decision) => decision === 'save'
    ? { text: textIn.value.trim(), url: urlIn.value.trim() }
    : null);
}

// ── Code block ────────────────────────────────────────────────────────
// Language for the fence's info string, from a searchable dropdown. Each
// entry is [label, fence token]; the tokens are the ones the preview's
// syntect highlighter resolves (checked with find_syntax_by_token). Text
// that matches no entry (e.g. `typescript`, which ADO highlights but the
// preview can't) is used as typed; blank means no language.
const CODE_LANGS = [
  ['Bash', 'bash'], ['C', 'c'], ['C++', 'cpp'], ['C#', 'cs'], ['CSS', 'css'],
  ['Diff', 'diff'], ['Go', 'go'], ['HTML', 'html'], ['Java', 'java'],
  ['JavaScript', 'javascript'], ['JSON', 'json'], ['Markdown', 'markdown'],
  ['PHP', 'php'], ['Python', 'python'], ['Ruby', 'ruby'], ['Rust', 'rust'],
  ['SQL', 'sql'], ['XML', 'xml'], ['YAML', 'yaml'],
];
export function promptCodeBlock(): Promise<{ lang: string } | null> {
  const promise = openInsertPrompt('Insert code block', `<span class="confirm-fields">
      <label>Language
        <span class="custom-select searchable" id="code-lang-select">
          <input type="text" id="code-lang" class="custom-select-trigger" role="combobox" aria-expanded="false" aria-controls="code-lang-list" aria-autocomplete="list" spellcheck="false" autocomplete="off" placeholder="None">
          <span class="custom-select-options" id="code-lang-list" role="listbox">${CODE_LANGS.map(([label, token]) =>
            `<span class="custom-select-option" role="option" id="code-lang-${token}" data-value="${token}">${label}</span>`).join('')}</span>
        </span>
      </label>
    </span>`);
  const input = field('code-lang');
  wireSearchableSelect(input, document.getElementById('code-lang-select'));
  return promise.then((decision) => {
    if (decision !== 'save') return null;
    // A picked (or exactly typed) label maps to its fence token.
    const typed = input.value.trim().toLowerCase();
    const hit = CODE_LANGS.find(([label, token]) => label.toLowerCase() === typed || token === typed);
    return { lang: hit ? hit[1] : input.value };
  });
}

// A dropdown you can type into: the app's custom-select look (settings.css)
// with the trigger as a text input that filters the list. The other
// dropdowns don't search and their wireCustomSelect expects a div trigger,
// hence this small variant. Enter or a click on an entry puts its label in
// the input and closes the list; Enter with the list closed (or nothing
// highlighted) falls through to the dialog, which inserts. Escape closes an
// open list without closing the dialog.
function wireSearchableSelect(input: HTMLInputElement, box: HTMLElement) {
  const all = Array.from(box.querySelectorAll('.custom-select-option')) as HTMLElement[];
  const shown = () => all.filter((o) => !o.hidden);
  let focused = -1;
  const isOpen = () => box.classList.contains('open');
  const setFocus = (i: number) => {
    const list = shown();
    focused = list.length ? Math.max(0, Math.min(list.length - 1, i)) : -1;
    all.forEach((o) => o.classList.remove('focused'));
    if (focused < 0) { input.removeAttribute('aria-activedescendant'); return; }
    list[focused].classList.add('focused');
    list[focused].scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', list[focused].id);
  };
  const close = () => {
    box.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    setFocus(-1);
  };
  // Filter on label or token, so "c#" and "cs" both find C#. A query
  // highlights the first match, so typing then Enter picks it.
  const open = () => {
    const q = input.value.trim().toLowerCase();
    all.forEach((o) => { o.hidden = !`${o.textContent} ${o.dataset.value}`.toLowerCase().includes(q); });
    const any = shown().length > 0;
    box.classList.toggle('open', any);
    input.setAttribute('aria-expanded', String(any));
    setFocus(q && any ? 0 : -1);
  };
  const pick = (o: HTMLElement) => {
    input.value = o.textContent;
    all.forEach((x) => x.classList.toggle('selected', x === o));
    close();
  };

  input.addEventListener('input', open);
  input.addEventListener('click', () => (isOpen() ? close() : open()));
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) open();
      setFocus(focused + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && isOpen() && focused >= 0) {
      e.preventDefault();
      e.stopPropagation();  // pick only; the next Enter inserts
      pick(shown()[focused]);
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      e.stopPropagation();  // close the list, not the dialog
      close();
    } else if (e.key === 'Tab') {
      close();
    }
  });
  // mousedown would blur the input (closing the list) before the click.
  box.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.custom-select-option')) e.preventDefault();
  });
  box.addEventListener('click', (e) => {
    const o = (e.target as HTMLElement).closest('.custom-select-option') as HTMLElement;
    if (o) pick(o);
  });
}

// ── Image ─────────────────────────────────────────────────────────────
// Alt text plus one source: a local file (dropped on the zone or picked with
// the native dialog) or a pasted link. Setting a file clears and locks the
// link field until the file is removed. The file is only a path here; the
// caller copies it into assets/ after Insert, so Cancel leaves nothing
// behind. Local files need a saved document (assets/ lives beside it), so
// `canUpload` false leaves only the link.

// The open image prompt's drop handler, for imagePromptDrag.
let imagePrompt: { drop(paths: string[]): void } | null = null;

export function promptImage({ alt, url, canUpload }: { alt: string, url: string, canUpload: boolean }): Promise<{ alt: string, url?: string, file?: string } | null> {
  const promise = openInsertPrompt('Insert image', `<span class="confirm-fields">
      <label>Alt text<input type="text" id="image-alt" class="confirm-text-input" spellcheck="false" autocomplete="off"></label>
      <span class="confirm-island">
        <span id="image-drop-zone" class="confirm-drop-zone">
          <span id="image-drop-label" class="confirm-drop-label"></span>
          <span class="confirm-drop-actions">
            <button type="button" id="image-browse">Browse…</button>
            <button type="button" id="image-remove" hidden>Remove</button>
          </span>
        </span>
        <span class="confirm-or" aria-hidden="true">OR</span>
        <input type="text" id="image-url" class="confirm-text-input" aria-label="Image link" spellcheck="false" autocomplete="off" placeholder="https://">
      </span>
    </span>`);
  const altIn = field('image-alt');
  const urlIn = field('image-url');
  const zone = document.getElementById('image-drop-zone');
  const label = document.getElementById('image-drop-label');
  const browse = document.getElementById('image-browse') as HTMLButtonElement;
  const remove = document.getElementById('image-remove') as HTMLButtonElement;
  altIn.value = alt;
  urlIn.value = url;

  let file: string | null = null;
  const render = (message?: string) => {
    label.textContent = message
      ?? (file ? file.split(/[\\/]/).pop()
        : canUpload ? 'Drop an image here'
        : 'Save the document to add local images');
    zone.classList.toggle('has-file', !!file);
    zone.classList.toggle('disabled', !canUpload);
    browse.disabled = !canUpload;
    remove.hidden = !file;
    urlIn.disabled = !!file;
    insertBtn.disabled = !file && !urlIn.value.trim();
  };
  const setFile = (path: string) => {
    file = path;
    urlIn.value = '';
    render();
  };

  imagePrompt = {
    drop(paths) {
      if (!canUpload) return;
      const image = paths.find((p) => IMAGE_EXTS.has(pathExtension(p)));
      if (image) setFile(image);
      else render('Not an image. Drop a PNG, JPG, GIF, WebP or SVG file.');
    },
  };
  browse.addEventListener('click', async () => {
    const picked = await invoke('pick_image') as string | null;
    if (picked) setFile(picked);
    // The native dialog took focus; hand it back inside the modal.
    (picked ? insertBtn : browse).focus();
  });
  remove.addEventListener('click', () => {
    file = null;
    render();
    browse.focus();
  });
  urlIn.addEventListener('input', () => render());
  render();

  return promise.then((decision) => {
    imagePrompt = null;
    if (decision !== 'save') return null;
    return file ? { alt: altIn.value.trim(), file } : { alt: altIn.value.trim(), url: urlIn.value.trim() };
  });
}

// OS file drags reach the page only as Tauri window drag-drop events
// (app.ts), never as DOM drop events. While the image prompt is open, app.ts
// hands every one here: hovering the zone highlights it, a drop on it picks
// the file. Returns true when consumed, which is always while the prompt is
// open, so a stray drop can't open a file behind the modal.
export function imagePromptDrag(type: string, paths: string[], x?: number, y?: number): boolean {
  if (!imagePrompt) return false;
  const zone = document.getElementById('image-drop-zone');
  const over = x != null && !!document.elementFromPoint(x, y)?.closest('#image-drop-zone');
  zone?.classList.toggle('drag-over', over && (type === 'enter' || type === 'over'));
  if (type === 'drop' && over) imagePrompt.drop(paths);
  return true;
}
