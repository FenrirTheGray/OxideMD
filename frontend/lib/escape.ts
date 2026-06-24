// Escape a string for safe interpolation into an HTML template literal.
// Shared by the UI modules that build markup from user-controlled text
// (tab titles, file paths, error strings).

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
