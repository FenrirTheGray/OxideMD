// Context-aware right-click menu.
//
// The default webview context menu is suppressed globally (it exposes
// "Reload", which reloads the app and wipes all tab state). This module
// replaces it with an in-app menu whose items depend on what was clicked.
//
// Builders inspect the event target and return a flat item list of
// `{ label, action, disabled?, shortcut? }` entries, with
// `{ separator: true }` as a divider. An empty list means "don't show a
// menu" — but the default is still suppressed.

import {
  modKey,
  tabs,
  sidebarTreeEl, tabBarEl,
  previewPane, contentEl,
} from './state.js';
import {
  loadFile, closeTab, closeOtherTabs, closeAllTabs, handleAnchorClick,
} from './tabs.js';
import { applyFormat } from './editor-format.js';
import { getEditorView } from './editor.js';
import { EditorSelection } from '@codemirror/state';

// ── Menu renderer ────────────────────────────────────────────────────────
// One menu element exists at a time, lazily attached to <body>. Click-out,
// Escape, window blur, and resize all close it. Items receive focus via
// arrow keys; Enter activates.

let menuEl = null;
let menuCleanup = null;

function closeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  if (menuCleanup) { menuCleanup(); menuCleanup = null; }
}

function showMenu(items, clientX, clientY) {
  if (!items || items.length === 0) return;
  closeMenu();

  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.setAttribute('role', 'menu');

  items.forEach((item, i) => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      sep.setAttribute('role', 'separator');
      el.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-item';
    btn.setAttribute('role', 'menuitem');
    btn.dataset.idx = String(i);
    if (item.disabled) btn.disabled = true;

    const label = document.createElement('span');
    label.className = 'ctx-label';
    label.textContent = item.label;
    btn.appendChild(label);

    if (item.shortcut) {
      const kbd = document.createElement('span');
      kbd.className = 'ctx-shortcut';
      kbd.textContent = item.shortcut;
      btn.appendChild(kbd);
    }

    btn.addEventListener('click', () => {
      if (item.disabled) return;
      closeMenu();
      try { item.action(); } catch (e) { console.error('[oxidemd] ctx action', e); }
    });
    el.appendChild(btn);
  });

  // Position offscreen first so we can measure, then clamp into viewport.
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.visibility = 'hidden';
  document.body.appendChild(el);
  const { offsetWidth: w, offsetHeight: h } = el;
  const margin = 4;
  const maxX = window.innerWidth - w - margin;
  const maxY = window.innerHeight - h - margin;
  const x = Math.max(margin, Math.min(clientX, maxX));
  const y = Math.max(margin, Math.min(clientY, maxY));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.visibility = '';

  menuEl = el;

  // Focus the first enabled item so keyboard users can drive the menu
  // immediately; the pointer user will just ignore the outline.
  const firstEnabled = el.querySelector('.ctx-item:not([disabled])');
  if (firstEnabled) firstEnabled.focus();

  // Dismissal listeners. Use `capture` for pointerdown so we see it
  // before the underlying element's own click handlers steal it.
  const onDown = (e) => {
    if (!menuEl) return;
    if (menuEl.contains(e.target)) return;
    closeMenu();
  };
  const onKey = (e) => {
    if (!menuEl) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const enabled = Array.from(menuEl.querySelectorAll('.ctx-item:not([disabled])'));
      if (!enabled.length) return;
      const cur = enabled.indexOf(document.activeElement);
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next = (cur + delta + enabled.length) % enabled.length;
      enabled[next].focus();
    }
  };
  const onBlur = () => closeMenu();

  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  window.addEventListener('scroll', onBlur, true);

  menuCleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
    window.removeEventListener('scroll', onBlur, true);
  };
}

// ── Clipboard helpers ────────────────────────────────────────────────────

async function copyText(text) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch {}
}

// Cut/Copy/Paste for plain inputs (search bar, sidebar filter). These
// still drive textarea/input via execCommand because that path preserves
// the native undo stack — we only fall through to it when the target
// isn't the CM6 markdown editor.
function inputCut(ta, sel) {
  ta.focus();
  if (sel) ta.setSelectionRange(sel.start, sel.end);
  document.execCommand('cut');
}
function inputCopy(ta, sel) {
  ta.focus();
  if (sel) ta.setSelectionRange(sel.start, sel.end);
  document.execCommand('copy');
}
async function inputPaste(ta, sel) {
  ta.focus();
  if (sel) ta.setSelectionRange(sel.start, sel.end);
  try {
    const text = await navigator.clipboard.readText();
    if (text) document.execCommand('insertText', false, text);
  } catch {}
}

// Editor (CM6) cut/copy/paste/select-all. Each goes through a single
// transaction so undo/redo gets one history entry per action; cut and
// copy use the async clipboard API since CM6 owns the contenteditable
// and execCommand('cut'/'copy') from outside doesn't fire its handlers.
async function cmCopy(view, sel) {
  const text = view.state.sliceDoc(sel.start, sel.end);
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch {}
}
async function cmCut(view, sel) {
  const text = view.state.sliceDoc(sel.start, sel.end);
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch {}
  view.dispatch({
    changes: { from: sel.start, to: sel.end, insert: '' },
    selection: EditorSelection.cursor(sel.start),
  });
  view.focus();
}
async function cmPaste(view, sel) {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {}
  if (!text) return;
  view.dispatch({
    changes: { from: sel.start, to: sel.end, insert: text },
    selection: EditorSelection.cursor(sel.start + text.length),
  });
  view.focus();
}
function cmSelectAll(view) {
  view.dispatch({
    selection: EditorSelection.range(0, view.state.doc.length),
  });
  view.focus();
}

// Markdown/preview "Select All" selects the visible rendered content
// rather than the whole document — matches what the user would expect
// from a right-click on the article.
function selectAllIn(root) {
  const range = document.createRange();
  range.selectNodeContents(root);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// ── Per-context builders ─────────────────────────────────────────────────

function buildTreeMenu(nodeEl) {
  const path = nodeEl.dataset.path;
  if (!path) return [];
  const isDir = nodeEl.classList.contains('tree-dir');
  const items = [];
  if (!isDir) {
    items.push({ label: 'Open in New Tab', action: () => loadFile(path) });
    items.push({ separator: true });
  }
  items.push({ label: 'Copy Path', action: () => copyText(path) });
  return items;
}

function buildTabMenu(tabEl) {
  const id = Number(tabEl.dataset.tabId);
  if (Number.isNaN(id)) return [];
  const tab = tabs.find(t => t.id === id);
  const multi = tabs.length > 1;
  const items = [
    { label: 'Close', action: () => closeTab(id), shortcut: `${modKey}+W` },
  ];
  if (multi) {
    items.push({ label: 'Close Others', action: () => closeOtherTabs(id) });
    items.push({ label: 'Close All', action: () => closeAllTabs() });
  }
  if (tab?.path) {
    items.push({ separator: true });
    items.push({ label: 'Copy Path', action: () => copyText(tab.path) });
  }
  return items;
}

// Generic fallback for plain <input type="text"> and small <textarea>s
// outside the markdown editor (search bar, sidebar filter, settings
// inputs). Just the standard edit commands.
function buildInputMenu(input) {
  const sel = { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 };
  const hasSelection = sel.start !== sel.end;
  const readOnly = input.readOnly || input.disabled;
  return [
    { label: 'Cut',        action: () => inputCut(input, sel),   disabled: !hasSelection || readOnly, shortcut: `${modKey}+X` },
    { label: 'Copy',       action: () => inputCopy(input, sel),  disabled: !hasSelection,             shortcut: `${modKey}+C` },
    { label: 'Paste',      action: () => inputPaste(input, sel), disabled: readOnly,                  shortcut: `${modKey}+V` },
    { label: 'Select All', action: () => { input.focus(); input.select(); }, shortcut: `${modKey}+A` },
  ];
}

function buildEditorMenu() {
  const view = getEditorView();
  if (!view) return [];
  // Snapshot selection; the menu click momentarily blurs the editor and
  // we want Cut/Copy/Paste to act on what the user was looking at.
  const r = view.state.selection.main;
  const sel = { start: r.from, end: r.to };
  const hasSelection = sel.start !== sel.end;
  return [
    { label: 'Cut',    action: () => cmCut(view, sel),   disabled: !hasSelection, shortcut: `${modKey}+X` },
    { label: 'Copy',   action: () => cmCopy(view, sel),  disabled: !hasSelection, shortcut: `${modKey}+C` },
    { label: 'Paste',  action: () => cmPaste(view, sel), shortcut: `${modKey}+V` },
    { label: 'Select All', action: () => cmSelectAll(view), shortcut: `${modKey}+A` },
    { separator: true },
    { label: 'Bold',   action: () => applyFormat(view, 'bold'),   shortcut: `${modKey}+B` },
    { label: 'Italic', action: () => applyFormat(view, 'italic'), shortcut: `${modKey}+I` },
    { label: 'Code',   action: () => applyFormat(view, 'code') },
    { label: 'Link',   action: () => applyFormat(view, 'link'),   shortcut: `${modKey}+K` },
  ];
}

function buildMarkdownMenu(root, target) {
  const link = target.closest('a[href]');
  const img  = !link ? target.closest('img') : null;
  const hasSelection = !window.getSelection().isCollapsed;
  const items = [];

  if (link) {
    items.push({ label: 'Open Link', action: () => handleAnchorClick(link) });
    const href = link.getAttribute('href');
    if (href) items.push({ label: 'Copy Link Address', action: () => copyText(href) });
    return items;
  }

  if (img) {
    // Prefer the original filesystem path (set by the Rust renderer for
    // local images) over the asset:// URL, which isn't useful outside
    // the webview.
    const srcPath = img.dataset.oxideSrc || img.getAttribute('src') || '';
    if (srcPath) items.push({ label: 'Copy Image Path', action: () => copyText(srcPath) });
    return items;
  }

  if (hasSelection) items.push({ label: 'Copy', action: () => document.execCommand('copy') });
  items.push({ label: 'Select All', action: () => selectAllIn(root) });
  return items;
}

// ── Global dispatch ──────────────────────────────────────────────────────
// One listener at the document level: always preventDefault() (otherwise
// the webview's own menu pops up, and its "Reload" entry nukes the app
// state), then find the most specific matching context.

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();

  // Our own menu: nothing to do (preventDefault already stops the webview
  // default). Other overlays are fine — the input/builder dispatch below
  // picks the right menu for form fields inside them.
  if (e.target.closest('.ctx-menu')) return;

  let items = [];

  const treeNode = sidebarTreeEl?.contains(e.target) ? e.target.closest('.tree-node') : null;
  const tabEl    = tabBarEl?.contains(e.target)      ? e.target.closest('.tab')       : null;
  const mdEditor = e.target.closest('.cm-editor');
  const otherInput = !mdEditor
    ? e.target.closest('input[type="text"], input[type="search"], input:not([type]), textarea')
    : null;
  const inPreview = previewPane?.contains(e.target);
  const inContent = contentEl?.contains(e.target);

  if (treeNode) {
    items = buildTreeMenu(treeNode);
  } else if (tabEl) {
    items = buildTabMenu(tabEl);
  } else if (mdEditor) {
    items = buildEditorMenu();
  } else if (otherInput) {
    items = buildInputMenu(otherInput);
  } else if (inPreview) {
    items = buildMarkdownMenu(previewPane, e.target);
  } else if (inContent) {
    items = buildMarkdownMenu(contentEl, e.target);
  }

  if (items.length) showMenu(items, e.clientX, e.clientY);
});
