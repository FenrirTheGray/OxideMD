// Diagnostic logger — forwards messages to tauri-plugin-log so they
// land in the same dated file the Rust side writes to (e.g.
// `OxideMD-2026-05-16.log` in the OS app log dir).
//
// Each helper also tees to the webview console so DevTools (in dev
// builds) shows the same line that hits the file. Use these wrappers
// instead of raw `console.error/warn` so errors are persisted for
// users reporting issues.
//
// Side effect on import: registers `window.onerror` and
// `unhandledrejection` listeners so uncaught exceptions and broken
// promise chains end up in the log without each call site having to
// remember to wrap them. Import this module FIRST in app.js so the
// handlers are live before any other code runs.

import { invoke } from "./state.ts";

// Numeric levels match the plugin's `LogLevel` enum (1=trace … 5=error).
const LEVEL = Object.freeze({
  TRACE: 1, DEBUG: 2, INFO: 3, WARN: 4, ERROR: 5,
});

function describe(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Error) {
    const stack = value.stack ? `\n${value.stack}` : '';
    return `${value.name}: ${value.message}${stack}`;
  }
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function send(level, scope, message, detail) {
  const tail = detail ? ` :: ${describe(detail)}` : '';
  // Fire-and-forget — never throw from the logger itself.
  invoke('plugin:log|log', {
    level,
    message: `[${scope}] ${message}${tail}`,
    location: scope,
  }).catch(() => {});
}

export function logError(scope, message, err) {
  console.error(`[${scope}] ${message}`, err ?? '');
  send(LEVEL.ERROR, scope, message, err);
}

export function logWarn(scope, message, detail) {
  console.warn(`[${scope}] ${message}`, detail ?? '');
  send(LEVEL.WARN, scope, message, detail);
}

export function logInfo(scope, message, detail) {
  send(LEVEL.INFO, scope, message, detail);
}

window.addEventListener('error', (event) => {
  const where = `${event.filename || '?'}:${event.lineno || 0}:${event.colno || 0}`;
  logError('uncaught', `${event.message} (${where})`, event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  logError('unhandled-rejection', 'Unhandled promise rejection', event.reason);
});
