// Daily, human-readable error log.
//
// Every warning or error the app surfaces is appended as a single line to
// `<config-dir>/error-log/yyyy-mm-dd-errors.log` (one file per calendar
// day, alongside `config.toml`/`fonts/`/`themes/`). Each line is
// `HH:MM:SS - <message>` in local time. The frontend funnels its logger
// here through the `append_error_log` command; backend-only failures call
// `append_error_line` directly.

use std::fs::{self, OpenOptions};
use std::io::Write;

use chrono::Local;

use crate::config::error_log_dir;

/// Append one `HH:MM:SS - <message>` line to today's error log. Best-effort:
/// any filesystem problem is swallowed so logging can never itself become a
/// failure the user has to deal with. Embedded newlines are flattened so a
/// single error stays a single line (stack traces keep their content,
/// joined with ` | `).
pub fn append_error_line(message: &str) {
    let Some(dir) = error_log_dir() else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let now = Local::now();
    let file = dir.join(format!("{}-errors.log", now.format("%Y-%m-%d")));
    let flat = message
        .replace("\r\n", " | ")
        .replace(['\n', '\r'], " | ");
    let line = format!("{} - {}\n", now.format("%H:%M:%S"), flat);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&file) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Frontend-facing sink: the webview logger calls this for every WARN/ERROR
/// it emits (including uncaught exceptions and rejected promises) so they
/// persist to the daily file.
#[tauri::command]
pub fn append_error_log(message: String) {
    append_error_line(&message);
}
