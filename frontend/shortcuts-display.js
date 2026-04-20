// Renders the shortcut chips shown in the popover, welcome screen, and
// toolbar tooltips. Reads `state.bindings` (the effectiveBindings result)
// so a rebind in the Shortcuts tab is reflected everywhere on save.
//
// Called: once at init, after Save in the Shortcuts tab, after
// showWelcome() rewrites contentEl, and after renderTabBar() rebuilds tab
// close buttons (so per-tab close tooltips reflect the live binding).

import { ACTIONS, getAction, accelToTokens } from './keybindings.js';
import {
  state,
  shortcutsPopover, contentEl,
  btnOpen, btnOpenFolder, btnReload, btnSearch, btnModeToggle, btnSave,
  btnZoomOut, btnZoomIn, zoomLabel, sidebarCloseBtn, tabBarEl,
} from './state.js';

// Welcome screen ordering (curated; not every action belongs here). Static
// rows for non-rebindable keys append at the end.
const WELCOME_ACTION_IDS = [
  'openFile', 'openFolder', 'toggleSearch', 'reload', 'closeTab',
  'nextTab', 'prevTab', 'moveTabLeft', 'moveTabRight',
  'zoomIn', 'zoomOut', 'zoomReset',
];
const WELCOME_STATIC = [
  { label: 'Scroll to top',          tokens: ['Home'] },
  { label: 'Close dialog / search',  tokens: ['Esc'] },
];

// Toolbar tooltips: short label per element, then we append the live key
// combo. The registry's `label` is sometimes too generic ("Search" vs
// "Search in document"), so we keep tooltip strings local.
const TOOLBAR_LABELS = {
  openFile:     'Open file',
  openFolder:   'Open folder',
  reload:       'Reload file',
  toggleSearch: 'Search',
  toggleEdit:   'Edit Markdown source',
  save:         'Save file',
  zoomOut:      'Zoom out',
  zoomIn:       'Zoom in',
  zoomReset:    'Reset zoom',
  closeFolder:  'Close folder',
  closeTab:     'Close',
};

// Edit-toolbar format buttons. Each `data-format` here has a matching
// editor-context action in the registry, so its title can carry the live
// shortcut hint. Format buttons that lack a shortcut (quote, codeblock,
// hr) are absent from this map and keep their static HTML title.
const FMT_TO_ACTION = {
  bold:   'bold',   italic: 'italic', strike: 'strike', code:   'code',
  h1:     'h1',     h2:     'h2',     h3:     'h3',
  ul:     'ul',     ol:     'ol',     task:   'task',
  link:   'link',   image:  'image',
};
const FMT_LABELS = {
  bold:   'Bold',          italic: 'Italic',        strike: 'Strikethrough', code:   'Inline code',
  h1:     'Heading 1',     h2:     'Heading 2',     h3:     'Heading 3',
  ul:     'Bullet list',   ol:     'Numbered list', task:   'Task list',
  link:   'Insert link',   image:  'Insert image',
};

function tokensFor(actionId) {
  const b = state.bindings && state.bindings[actionId];
  return b && b.primary ? accelToTokens(b.primary) : [];
}

function tokensToHtml(tokens) {
  if (!tokens.length) return '<span class="shortcut-unbound">Unassigned</span>';
  return tokens.map(t => `<kbd>${escapeHtml(t)}</kbd>`).join('');
}

function tooltipFor(label, tokens) {
  return tokens.length ? `${label} (${tokens.join('+')})` : label;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderPopover() {
  if (!shortcutsPopover) return;
  const groups = new Map();
  for (const a of ACTIONS) {
    if (!groups.has(a.category)) groups.set(a.category, []);
    groups.get(a.category).push(a);
  }
  const html = ['<div class="shortcuts-header">Keyboard Shortcuts</div>'];
  for (const [category, actions] of groups) {
    html.push('<div class="shortcuts-group">');
    html.push(`<div class="shortcuts-group-label">${escapeHtml(category)}</div>`);
    for (const a of actions) {
      const tokens = tokensFor(a.id);
      html.push(
        '<div class="shortcut-row">' +
          `<span>${tokensToHtml(tokens)}</span>` +
          `<span>${escapeHtml(a.label)}</span>` +
        '</div>'
      );
    }
    html.push('</div>');
  }
  shortcutsPopover.innerHTML = html.join('');
}

function renderWelcome() {
  // Welcome may be replaced by a tab's content; render only when present.
  const list = contentEl.querySelector('#welcome-shortcuts-list');
  if (list) {
    const rows = [];
    for (const id of WELCOME_ACTION_IDS) {
      const a = getAction(id);
      if (!a) continue;
      const tokens = tokensFor(id);
      rows.push(
        '<div class="welcome-shortcut">' +
          `<span class="welcome-shortcut-label">${escapeHtml(a.label)}</span>` +
          `<span class="welcome-shortcut-keys">${tokensToHtml(tokens)}</span>` +
        '</div>'
      );
    }
    for (const s of WELCOME_STATIC) {
      rows.push(
        '<div class="welcome-shortcut">' +
          `<span class="welcome-shortcut-label">${escapeHtml(s.label)}</span>` +
          `<span class="welcome-shortcut-keys">${tokensToHtml(s.tokens)}</span>` +
        '</div>'
      );
    }
    list.innerHTML = rows.join('');
  }

  // Hero subtitles ("Press X or drag…") — span with data-shortcut="id"
  // gets its kbds rebuilt per current binding. Scope to #welcome so we
  // never reach into rendered markdown that happens to use the attr.
  contentEl.querySelectorAll('#welcome [data-shortcut]').forEach(el => {
    const id = el.dataset.shortcut;
    el.innerHTML = tokensToHtml(tokensFor(id));
  });
}

function renderToolbarTooltips() {
  const map = [
    [btnOpen,         'openFile'],
    [btnOpenFolder,   'openFolder'],
    [btnReload,       'reload'],
    [btnSearch,       'toggleSearch'],
    [btnModeToggle,   'toggleEdit'],
    [btnSave,         'save'],
    [btnZoomOut,      'zoomOut'],
    [btnZoomIn,       'zoomIn'],
    [zoomLabel,       'zoomReset'],
    [sidebarCloseBtn, 'closeFolder'],
  ];
  for (const [el, id] of map) {
    if (!el) continue;
    el.title = tooltipFor(TOOLBAR_LABELS[id] || id, tokensFor(id));
  }

  refreshTabCloseTitles();

  // Edit-toolbar formatting buttons that have a shortcut in the registry.
  document.querySelectorAll('#edit-toolbar .fmt-btn[data-format]').forEach(btn => {
    const fmt = btn.dataset.format;
    const actionId = FMT_TO_ACTION[fmt];
    if (!actionId) return;
    btn.title = tooltipFor(FMT_LABELS[fmt], tokensFor(actionId));
  });
}

// Narrow refresh used by renderTabBar() — only the close buttons are rebuilt
// per tab change, so re-rendering the popover/welcome/all toolbar tooltips
// every time would be wasteful.
export function refreshTabCloseTitles() {
  if (!tabBarEl) return;
  const title = tooltipFor(TOOLBAR_LABELS.closeTab, tokensFor('closeTab'));
  tabBarEl.querySelectorAll('.tab-close').forEach(b => { b.title = title; });
}

export function renderShortcutsUI() {
  renderPopover();
  renderWelcome();
  renderToolbarTooltips();
}
