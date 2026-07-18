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
  invoke,
  modKey, state,
  tabs,
  sidebarTreeEl, tabBarEl,
  previewPane, contentEl,
  outlineSidebar, sidebarSearchResultsEl,
} from "../core/state.ts";
import {
  loadFile, closeTab, closeOtherTabs, closeAllTabs, closeTabsToRight,
  handleAnchorClick, createNewFile, dropTabsForDeletedPath,
  retargetTabsForRenamedPath, parentDir, activeTab, applyRecentFiles,
} from "./tabs.ts";
import { isDirty } from "../core/tab-state.ts";
import { runAction } from "../core/keybindings.ts";
import { editorModule } from "../editor/lazy.ts";
import { printActiveTab } from "../features/print.ts";
import { logError } from "../core/logger.ts";
import { showErrorModal } from "./error-modal.ts";
import { showToast } from "./toast.ts";
import { promptText } from "./confirm.ts";

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
      try { item.action(); } catch (e) { logError('contextmenu', 'menu action threw', e); }
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
  if (firstEnabled) (firstEnabled as HTMLElement).focus();

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
      (enabled[next] as HTMLElement).focus();
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

// ── Path helpers ─────────────────────────────────────────────────────────

function baseName(p) {
  return p.split(/[\\/]/).pop() || p;
}

// Path relative to the open folder root, or null when no folder is open
// or the path lives outside it (then the menu omits the entry).
function relativePath(p) {
  const root = state.currentFolder?.root;
  if (!root || !p) return null;
  if (p.startsWith(root + '/') || p.startsWith(root + '\\')) return p.slice(root.length + 1);
  return null;
}

// Shared "Copy Path / Copy Relative Path / Copy Name" tail used by every
// menu that targets a concrete file or folder on disk.
function copyPathItems(path) {
  const items = [{ label: 'Copy Path', action: () => copyText(path) }];
  const rel = relativePath(path);
  if (rel && rel !== baseName(path)) {
    items.push({ label: 'Copy Relative Path', action: () => copyText(rel) });
  }
  items.push({ label: 'Copy Name', action: () => copyText(baseName(path)) });
  return items;
}

function revealPath(path) {
  invoke('reveal_path', { path }).catch((e) =>
    showErrorModal('Reveal failed', 'Could not show the file in the file manager.', e));
}

// ── Per-context builders ─────────────────────────────────────────────────

// Permanently delete a tree entry after an explicit confirmation. The
// folder root is never offered here (it has no tree node), so this only
// ever targets a file or a subfolder. On success any open tabs backing
// the removed path(s) are dropped; the filesystem watcher refreshes the
// tree on its own.
async function deleteTreeEntry(path, isDir) {
  const name = path.split(/[\\/]/).pop() || path;
  const message = isDir
    ? `Delete the folder "${name}" and everything inside it?\n\nThis is permanent and cannot be undone.`
    : `Delete the file "${name}"?\n\nThis is permanent and cannot be undone.`;
  if (!confirm(message)) return;
  try {
    await invoke('delete_path', { path });
    dropTabsForDeletedPath(path);
  } catch (e) {
    showErrorModal('Delete failed', `Could not delete "${name}".`, e);
  }
}

// Rename a tree entry in place via the shared text prompt. On success the
// backend returns the new path; open tabs are retargeted and the watcher
// refreshes the tree.
async function renameTreeEntry(path, isDir) {
  const oldName = baseName(path);
  const newName = await promptText({
    title: isDir ? 'Rename folder' : 'Rename file',
    saveLabel: 'Rename',
    initial: oldName,
  });
  if (!newName || newName === oldName) return;
  try {
    const newPath = await invoke('rename_path', { path, newName });
    retargetTabsForRenamedPath(path, newPath);
  } catch (e) {
    showErrorModal('Rename failed', `Could not rename "${oldName}".`, e);
  }
}

// Duplicate a file next to itself ("name copy.md") and open the copy.
async function duplicateTreeEntry(path) {
  try {
    const newPath = await invoke('duplicate_path', { path });
    loadFile(newPath);
  } catch (e) {
    showErrorModal('Duplicate failed', `Could not duplicate "${baseName(path)}".`, e);
  }
}

// Create a subfolder inside `dir`; the watcher paints it into the tree.
async function createFolderIn(dir) {
  const name = await promptText({ title: 'New folder', saveLabel: 'Create', initial: '' });
  if (!name) return;
  try {
    await invoke('create_folder', { dir, name });
  } catch (e) {
    showErrorModal('New folder failed', `Could not create "${name}".`, e);
  }
}

function buildTreeMenu(nodeEl) {
  const path = nodeEl.dataset.path;
  if (!path) return [];
  const isDir = nodeEl.classList.contains('tree-dir');
  const items = [];
  if (!isDir) {
    items.push({ label: 'Open in New Tab', action: () => loadFile(path) });
    items.push({ separator: true });
    // "New File…" for a file is rooted at its parent directory.
    items.push({ label: 'New File…', action: () => createNewFile(parentDir(path)) });
    items.push({ label: 'New Folder…', action: () => createFolderIn(parentDir(path)) });
    items.push({ separator: true });
    items.push({ label: 'Rename…', action: () => renameTreeEntry(path, false) });
    items.push({ label: 'Duplicate', action: () => duplicateTreeEntry(path) });
    items.push({ label: 'Delete File…', action: () => deleteTreeEntry(path, false) });
  } else {
    // Right-clicking a folder roots creation at that folder, so the save
    // dialog / new subfolder lands inside the directory the user clicked.
    items.push({ label: 'New File…', action: () => createNewFile(path) });
    items.push({ label: 'New Folder…', action: () => createFolderIn(path) });
    items.push({ separator: true });
    items.push({ label: 'Rename…', action: () => renameTreeEntry(path, true) });
    items.push({ label: 'Delete Folder…', action: () => deleteTreeEntry(path, true) });
  }
  items.push({ separator: true });
  items.push({ label: 'Reveal in File Explorer', action: () => revealPath(path) });
  items.push(...copyPathItems(path));
  return items;
}

function buildTabMenu(tabEl) {
  const id = Number(tabEl.dataset.tabId);
  if (Number.isNaN(id)) return [];
  const tab = tabs.find(t => t.id === id);
  const multi = tabs.length > 1;
  const idx = tabs.findIndex(t => t.id === id);
  const isActive = id === state.activeTabId;
  const items: any[] = [
    { label: 'Close', action: () => closeTab(id), shortcut: `${modKey}+W` },
  ];
  if (multi) {
    items.push({ label: 'Close Others', action: () => closeOtherTabs(id) });
    if (idx !== -1 && idx < tabs.length - 1) {
      items.push({ label: 'Close Tabs to the Right', action: () => closeTabsToRight(id) });
    }
    items.push({ label: 'Close All', action: () => closeAllTabs() });
  }
  // Reload/Export run on the active tab (runAction routes to the same
  // handlers as the shortcuts), so only offer them there.
  if (isActive && tab?.path) {
    items.push({ separator: true });
    items.push({
      label: 'Reload from Disk',
      action: () => runAction('reload'),
      disabled: tab.editing || isDirty(tab),
      shortcut: accelFromBindings('reload'),
    });
    items.push({ label: 'Export as HTML…', action: () => runAction('exportHtml'), shortcut: accelFromBindings('exportHtml') });
  }
  if (tab?.path) {
    items.push({ separator: true });
    items.push({ label: 'Reveal in File Explorer', action: () => revealPath(tab.path) });
    items.push(...copyPathItems(tab.path));
  }
  return items;
}

// Display accelerator for a rebindable action id (same idea as the editor
// module's accelFor, duplicated here to keep this module CM6-free).
function accelFromBindings(id) {
  const primary = state.bindings?.[id]?.primary;
  return primary ? primary.replace('Mod', modKey) : undefined;
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

// Copy an <img> to the clipboard as a PNG bitmap. Local images (the
// normal case — the renderer stamps their filesystem path on
// data-oxide-src) come through the backend as base64, because the CSP's
// connect-src blocks fetch() of asset: URLs. Remote images (opt-in) fall
// back to fetch. The ImageBitmap + canvas round-trip avoids a tainted
// canvas and normalizes any source format to the PNG the clipboard
// API requires.
async function copyImageBitmap(img) {
  try {
    let blob;
    const localPath = img.dataset.oxideSrc;
    if (localPath) {
      const b64 = await invoke('read_image_base64', { path: localPath });
      blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]);
    } else {
      blob = await (await fetch(img.currentSrc || img.src)).blob();
    }
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const png: Blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => b ? res(b) : rej(new Error('PNG encode failed')), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (e) {
    logError('contextmenu', 'copy image failed', e);
    showToast('Could not copy image', 'error');
  }
}

function buildMarkdownMenu(root, target) {
  const link = target.closest('a[href]');
  const img  = !link ? target.closest('img') : null;
  const heading = !link && !img ? target.closest('h1,h2,h3,h4,h5,h6') : null;
  // Snapshot the selected text now. Clicking a menu item collapses the
  // window text selection (focus moves to the menu button), so by the
  // time the action runs `document.execCommand('copy')` would copy
  // nothing. CM6 and <input>/<textarea> menus are unaffected because
  // they retain their own selection state internally.
  const winSel = window.getSelection();
  const selectedText = winSel && !winSel.isCollapsed ? winSel.toString() : '';
  const hasSelection = selectedText.length > 0;
  const items = [];

  if (link) {
    items.push({ label: 'Open Link', action: () => handleAnchorClick(link) });
    const href = link.getAttribute('href');
    if (href) items.push({ label: 'Copy Link Address', action: () => copyText(href) });
    return items;
  }

  if (img) {
    items.push({ label: 'Copy Image', action: () => copyImageBitmap(img) });
    // Prefer the original filesystem path (set by the Rust renderer for
    // local images) over the asset:// URL, which isn't useful outside
    // the webview.
    const srcPath = img.dataset.oxideSrc || img.getAttribute('src') || '';
    if (srcPath) items.push({ label: 'Copy Image Path', action: () => copyText(srcPath) });
    return items;
  }

  if (hasSelection) items.push({ label: 'Copy', action: () => copyText(selectedText) });
  // The anchor form the in-app link handler understands ("#slug" scrolls
  // and survives cross-file fragment links).
  if (heading?.id) {
    items.push({ label: 'Copy Link to Heading', action: () => copyText(`#${heading.id}`) });
  }
  items.push({ label: 'Select All', action: () => selectAllIn(root) });
  // Document-level actions only apply when a document is open — on the
  // welcome screen (also rendered into #content) they'd print/export the
  // welcome page itself.
  const tab = activeTab();
  if (tab) {
    items.push({ separator: true });
    items.push({ label: 'Print…', action: () => printActiveTab(), shortcut: accelFromBindings('print') });
    if (tab.path) {
      items.push({ label: 'Export as HTML…', action: () => runAction('exportHtml'), shortcut: accelFromBindings('exportHtml') });
    }
  }
  return items;
}

// Welcome screen's recent-files list. Mirrors the click affordances
// (open, forget) plus the standard path actions.
function buildRecentMenu(itemEl) {
  const path = (itemEl.querySelector('.welcome-recent-link') as HTMLElement)?.dataset.path;
  if (!path) return [];
  return [
    { label: 'Open', action: () => loadFile(path) },
    {
      label: 'Remove from Recents',
      action: () => invoke('forget_recent_file', { path }).then(applyRecentFiles).catch(() => {}),
    },
    { separator: true },
    { label: 'Reveal in File Explorer', action: () => revealPath(path) },
    ...copyPathItems(path),
  ];
}

// Outline sidebar items. The rendered heading order matches the outline's
// (both come from the same source), so the anchor id is read from the
// corresponding rendered heading — same index trick the click-to-jump
// handler in outline.ts relies on.
function buildOutlineMenu(itemEl) {
  const text = itemEl.textContent.trim();
  if (!text) return [];
  const items = [{ label: 'Copy Heading Text', action: () => copyText(text) }];
  const index = parseInt(itemEl.dataset.index, 10);
  const root = activeTab()?.editing ? previewPane : contentEl;
  const id = Number.isFinite(index)
    ? root?.querySelectorAll('h1,h2,h3,h4,h5,h6')[index]?.id
    : null;
  if (id) items.push({ label: 'Copy Link to Heading', action: () => copyText(`#${id}`) });
  return items;
}

// Project-search results: both the per-file group header and each match
// row carry the file's path.
function buildSearchResultMenu(el) {
  const path = el.dataset.path;
  if (!path) return [];
  return [
    { label: 'Open', action: () => loadFile(path) },
    { separator: true },
    { label: 'Reveal in File Explorer', action: () => revealPath(path) },
    ...copyPathItems(path),
  ];
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
  if ((e.target as HTMLElement).closest('.ctx-menu')) return;

  let items = [];

  const target = e.target as HTMLElement;
  const treeNode = sidebarTreeEl?.contains(e.target as Node) ? target.closest('.tree-node') : null;
  const tabEl    = tabBarEl?.contains(e.target as Node)      ? target.closest('.tab')       : null;
  const searchEl = sidebarSearchResultsEl?.contains(e.target as Node)
    ? target.closest('.search-result-row, .search-group-header')
    : null;
  const outlineItem = outlineSidebar?.contains(e.target as Node) ? target.closest('.outline-item') : null;
  const recentItem  = target.closest('.welcome-recent-item');
  const mdEditor = target.closest('.cm-editor');
  const otherInput = !mdEditor
    ? target.closest('input[type="text"], input[type="search"], input:not([type]), textarea')
    : null;
  const inPreview = previewPane?.contains(e.target as Node);
  const inContent = contentEl?.contains(e.target as Node);

  if (treeNode) {
    items = buildTreeMenu(treeNode);
  } else if (tabEl) {
    items = buildTabMenu(tabEl);
  } else if (searchEl) {
    items = buildSearchResultMenu(searchEl);
  } else if (outlineItem) {
    items = buildOutlineMenu(outlineItem);
  } else if (recentItem) {
    items = buildRecentMenu(recentItem);
  } else if (mdEditor) {
    // Built by the (lazily-loaded) editor module — a visible .cm-editor
    // means it's loaded. No items means no menu, same as before.
    items = editorModule()?.buildEditorContextMenu() ?? [];
  } else if (otherInput) {
    items = buildInputMenu(otherInput);
  } else if (inPreview) {
    items = buildMarkdownMenu(previewPane, e.target);
  } else if (inContent) {
    items = buildMarkdownMenu(contentEl, e.target);
  }

  if (items.length) showMenu(items, e.clientX, e.clientY);
});
