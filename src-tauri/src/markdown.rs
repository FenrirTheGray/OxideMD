use crate::highlight::Highlighter;
use crate::util::{html_escape, html_escape_attr};
use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// How an image `src` should reach the rendered HTML.
///
/// - `AssetPath` — a real local file. Emitted as `data-oxide-src` so the
///   frontend rewrites it via `convertFileSrc` to an asset:// URL rather
///   than inlining the bytes as base64.
/// - `Passthrough` — a `data:` URI (or an unresolvable relative ref).
///   Self-contained, makes no network request, so it goes straight into
///   `src`.
/// - `RemoteGated` — an `http(s)` / protocol-relative URL. Loading it
///   hits the network on render, leaking the reader's IP to an arbitrary
///   host — a tracking-pixel vector in untrusted documents. Emitted as
///   `data-oxide-remote-src` with no live `src`; the frontend promotes it
///   to `src` only when the user has opted into remote images.
#[derive(Debug, PartialEq, Eq)]
pub enum ResolvedImage {
    AssetPath(String),
    Passthrough(String),
    RemoteGated(String),
}

static HIGHLIGHTER: OnceLock<Highlighter> = OnceLock::new();

/// Force the lazy highlighter into existence. Called from a background
/// thread at app startup so the first document with a code block doesn't
/// pay the syntect definition-loading cost (easily 100ms+ on weak
/// hardware) at render time. `get_or_init` makes a render that arrives
/// mid-warm simply block until the same init finishes — never a double
/// load.
pub fn warm_highlighter() {
    HIGHLIGHTER.get_or_init(Highlighter::new);
}

/// Whether a single newline inside a paragraph (a CommonMark "soft
/// break") is rendered as a `<br>` rather than a space. Mirrors the
/// `preserve_line_breaks` config field; seeded at startup by `lib.rs`
/// and updated by `save_config_cmd`, so the live preview and reopened
/// files pick up a change without a restart.
pub static PRESERVE_LINE_BREAKS: AtomicBool = AtomicBool::new(false);

pub fn render(source: &str, base_dir: Option<&Path>) -> String {
    render_with(
        source,
        base_dir,
        PRESERVE_LINE_BREAKS.load(Ordering::Relaxed),
    )
}

/// Core renderer. Split from `render` so tests can pass the soft-break
/// mode explicitly instead of racing on the global atomic.
fn render_with(source: &str, base_dir: Option<&Path>, preserve_line_breaks: bool) -> String {
    let highlighter = HIGHLIGHTER.get_or_init(Highlighter::new);

    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_SMART_PUNCTUATION
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_HEADING_ATTRIBUTES;

    let parser = Parser::new_ext(source, options);

    let mut html = String::new();
    let mut used_heading_ids: HashSet<String> = HashSet::new();

    // State
    let mut in_code_block = false;
    let mut code_lang = String::new();
    let mut code_buf = String::new();
    let mut table_alignments: Vec<Alignment> = Vec::new();
    let mut col_index: usize = 0;
    let mut in_table_head = false;
    // Heading state:
    //   `heading_start` is the offset into `html` where the heading's
    //   inline content begins. When the heading ends we `split_off` at
    //   that offset so all the inline span tags that accumulated (e.g.
    //   <em>, <strong>, <a>) end up wrapped inside <hN>...</hN> instead
    //   of leaking before it.
    //   `heading_slug_buf` collects the raw plain-text of the heading
    //   for use in slug/ID generation so that slugs don't contain HTML
    //   entities like "amp" (from the escaped "&").
    let mut heading_start: usize = 0;
    let mut heading_slug_buf = String::new();
    let mut current_heading: Option<HeadingLevel> = None;
    // An explicit `{#id}` heading attribute, if the source supplied one.
    // When present it overrides the auto-generated slug for the heading's
    // `id`, but still flows through `used_heading_ids` so a later collision
    // (with another explicit id or an auto-slug) gets disambiguated.
    let mut heading_explicit_id: Option<String> = None;
    let mut in_image: Option<(String, String)> = None; // (src, title)
    let mut image_alt_buf = String::new();
    // Footnotes. Definitions are numbered by encounter order: the label
    // (`[^foo]`) is the lookup key, the `usize` its display number. A
    // reference or a definition — whichever the parser emits first —
    // claims the next number. A definition's inner events (paragraphs,
    // spans) render into `html` like any other block; at the definition's
    // end we `split_off` that content — same idiom as headings — and
    // stash it in `footnote_defs`, which flushes into a
    // `<section class="footnotes">` after the loop.
    let mut footnote_numbers: HashMap<String, usize> = HashMap::new();
    let mut footnote_defs: Vec<(usize, String)> = Vec::new();
    // While inside a definition: (its number, the `html` offset its body
    // started at).
    let mut footnote_def: Option<(usize, usize)> = None;

    for event in parser {
        match event {
            // ── Blocks ──────────────────────────────────────────────────────
            Event::Start(Tag::Heading { level, id, .. }) => {
                current_heading = Some(level);
                heading_start = html.len();
                heading_slug_buf.clear();
                // An explicit `{#id}` attribute, when present, becomes the
                // heading's `id` instead of the auto-generated slug.
                heading_explicit_id = id.map(|s| s.to_string());
            }
            Event::End(TagEnd::Heading(level)) => {
                let tag = match level {
                    HeadingLevel::H1 => "h1",
                    HeadingLevel::H2 => "h2",
                    HeadingLevel::H3 => "h3",
                    HeadingLevel::H4 => "h4",
                    HeadingLevel::H5 => "h5",
                    HeadingLevel::H6 => "h6",
                };
                let content = html.split_off(heading_start);
                // An explicit `{#id}` wins over the slug, but still runs
                // through `used_heading_ids` so a later collision (with
                // another explicit id or an auto-slug) is disambiguated.
                let base = heading_explicit_id
                    .take()
                    .unwrap_or_else(|| slugify(&heading_slug_buf));
                // Probe forward for a free id rather than tracking a per-base
                // counter: a counter's `base-N` can itself collide with a
                // real slug already in use (e.g. "step-1" from "# Step 1"
                // versus the 2nd "# Step"), handing two headings the same id.
                let id = if used_heading_ids.insert(base.clone()) {
                    base
                } else {
                    let mut n = 1;
                    loop {
                        let candidate = format!("{}-{}", base, n);
                        if used_heading_ids.insert(candidate.clone()) {
                            break candidate;
                        }
                        n += 1;
                    }
                };
                html.push_str(&format!("<{} id=\"{}\">{}</{}>", tag, id, content, tag));
                heading_slug_buf.clear();
                current_heading = None;
            }

            Event::Start(Tag::Paragraph) => html.push_str("<p>"),
            Event::End(TagEnd::Paragraph) => html.push_str("</p>\n"),

            Event::Start(Tag::BlockQuote(_)) => html.push_str("<blockquote>"),
            Event::End(TagEnd::BlockQuote(_)) => html.push_str("</blockquote>\n"),

            Event::Start(Tag::CodeBlock(kind)) => {
                in_code_block = true;
                code_buf.clear();
                code_lang = match kind {
                    CodeBlockKind::Fenced(lang) => lang.to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
                let highlighted = if code_lang.is_empty() {
                    html_escape(&code_buf)
                } else {
                    highlighter.highlight(&code_buf, &code_lang)
                };
                let lang_class = if code_lang.is_empty() {
                    String::new()
                } else {
                    format!(" class=\"language-{}\"", html_escape_attr(&code_lang))
                };
                let lang_label = if code_lang.is_empty() {
                    String::new()
                } else {
                    format!(
                        "<span class=\"codeblock-lang\">{}</span>",
                        html_escape(&code_lang)
                    )
                };
                // HTML5 attribute parsing collapses literal CR/LF to spaces.
                // Encode them as numeric entities so the JS-side copy
                // handler reads the original whitespace.
                let raw_attr = html_escape_attr(&code_buf)
                    .replace('\n', "&#10;")
                    .replace('\r', "&#13;");
                html.push_str(&format!(
                    "<div class=\"codeblock\" data-code=\"{}\">{}<button type=\"button\" class=\"codeblock-copy\" aria-label=\"Copy code\" title=\"Copy code\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"9\" y=\"9\" width=\"12\" height=\"12\" rx=\"2\"/><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"/></svg></button><pre><code{}>{}</code></pre></div>\n",
                    raw_attr, lang_label, lang_class, highlighted
                ));
                code_buf.clear();
                code_lang.clear();
            }

            Event::Start(Tag::List(start)) => {
                if let Some(n) = start {
                    html.push_str(&format!("<ol start=\"{}\">", n));
                } else {
                    html.push_str("<ul>");
                }
            }
            Event::End(TagEnd::List(ordered)) => {
                if ordered {
                    html.push_str("</ol>\n");
                } else {
                    html.push_str("</ul>\n");
                }
            }
            Event::Start(Tag::Item) => html.push_str("<li>"),
            Event::End(TagEnd::Item) => html.push_str("</li>\n"),

            Event::TaskListMarker(checked) => {
                html.push_str(&format!(
                    "<input type=\"checkbox\" class=\"task-list-checkbox\" disabled{}>",
                    if checked { " checked" } else { "" }
                ));
            }

            // ── Footnotes ────────────────────────────────────────────────────
            // The definition's inner content renders into `html` as usual;
            // we record where it starts so the matching End can `split_off`
            // the rendered body and divert it into the footnotes section.
            Event::Start(Tag::FootnoteDefinition(label)) => {
                let next = footnote_numbers.len() + 1;
                let num = *footnote_numbers.entry(label.to_string()).or_insert(next);
                footnote_def = Some((num, html.len()));
            }
            Event::End(TagEnd::FootnoteDefinition) => {
                if let Some((num, start)) = footnote_def.take() {
                    let body = html.split_off(start);
                    footnote_defs.push((num, body));
                }
            }
            Event::FootnoteReference(label) => {
                let next = footnote_numbers.len() + 1;
                let num = *footnote_numbers.entry(label.to_string()).or_insert(next);
                html.push_str(&format!(
                    "<sup class=\"footnote-ref\"><a id=\"fnref{}\" href=\"#fn{}\">{}</a></sup>",
                    num, num, num
                ));
            }

            // ── Tables ──────────────────────────────────────────────────────
            Event::Start(Tag::Table(alignments)) => {
                table_alignments = alignments;
                html.push_str("<table>");
            }
            Event::End(TagEnd::Table) => {
                html.push_str("</table>\n");
                table_alignments.clear();
            }
            Event::Start(Tag::TableHead) => {
                in_table_head = true;
                col_index = 0;
                html.push_str("<thead><tr>");
            }
            Event::End(TagEnd::TableHead) => {
                in_table_head = false;
                html.push_str("</tr></thead><tbody>");
            }
            Event::Start(Tag::TableRow) => {
                col_index = 0;
                html.push_str("<tr>");
            }
            Event::End(TagEnd::TableRow) => html.push_str("</tr>"),
            Event::Start(Tag::TableCell) => {
                let align = table_alignments
                    .get(col_index)
                    .copied()
                    .unwrap_or(Alignment::None);
                let style = match align {
                    Alignment::Left => " style=\"text-align:left\"",
                    Alignment::Center => " style=\"text-align:center\"",
                    Alignment::Right => " style=\"text-align:right\"",
                    Alignment::None => "",
                };
                if in_table_head {
                    html.push_str(&format!("<th{}>", style));
                } else {
                    html.push_str(&format!("<td{}>", style));
                }
            }
            Event::End(TagEnd::TableCell) => {
                if in_table_head {
                    html.push_str("</th>");
                } else {
                    html.push_str("</td>");
                }
                col_index += 1;
            }

            // ── Spans ────────────────────────────────────────────────────────
            Event::Start(Tag::Emphasis) => html.push_str("<em>"),
            Event::End(TagEnd::Emphasis) => html.push_str("</em>"),

            Event::Start(Tag::Strong) => html.push_str("<strong>"),
            Event::End(TagEnd::Strong) => html.push_str("</strong>"),

            Event::Start(Tag::Strikethrough) => html.push_str("<del>"),
            Event::End(TagEnd::Strikethrough) => html.push_str("</del>"),

            Event::Start(Tag::Link { dest_url, .. }) => {
                if is_dangerous_link_scheme(&dest_url) {
                    // Render the link inert: keep its text, drop the scheme
                    // so it can never fire. Our in-app click handler already
                    // refuses to navigate these, but an exported standalone
                    // HTML file (`export_html`) carries the raw markup with
                    // no such interceptor — neutralizing here closes that gap
                    // and keeps links symmetric with the image gating.
                    html.push_str("<a class=\"md-link md-link-blocked\">");
                } else {
                    html.push_str(&format!(
                        "<a href=\"{}\" class=\"md-link\">",
                        html_escape_attr(&dest_url)
                    ));
                }
            }
            Event::End(TagEnd::Link) => html.push_str("</a>"),

            Event::Start(Tag::Image {
                dest_url, title, ..
            }) => {
                in_image = Some((dest_url.to_string(), title.to_string()));
                image_alt_buf.clear();
            }
            Event::End(TagEnd::Image) => {
                if let Some((src, title)) = in_image.take() {
                    // Remote images get a neutral `data-oxide-remote-src`
                    // (never a live `src`) plus a class the frontend and
                    // CSS key off — so an untrusted doc can't phone home on
                    // render. The frontend promotes them to `src` only when
                    // the user has opted into remote images.
                    let (attr, value, class) = match resolve_image(&src, base_dir) {
                        ResolvedImage::AssetPath(p) => ("data-oxide-src", p, ""),
                        ResolvedImage::Passthrough(u) => ("src", u, ""),
                        ResolvedImage::RemoteGated(u) => {
                            ("data-oxide-remote-src", u, " class=\"md-remote-image\"")
                        }
                    };
                    html.push_str(&format!(
                        "<img{} {}=\"{}\" alt=\"{}\" title=\"{}\" loading=\"lazy\">",
                        class,
                        attr,
                        html_escape_attr(&value),
                        html_escape(&image_alt_buf),
                        html_escape_attr(&title)
                    ));
                    if current_heading.is_some() {
                        heading_slug_buf.push_str(&image_alt_buf);
                    }
                    image_alt_buf.clear();
                }
            }

            // ── Leaf events ──────────────────────────────────────────────────
            Event::Text(text) => {
                if in_code_block {
                    code_buf.push_str(&text);
                } else if in_image.is_some() {
                    image_alt_buf.push_str(&text);
                } else {
                    html.push_str(&html_escape(&text));
                    if current_heading.is_some() {
                        heading_slug_buf.push_str(&text);
                    }
                }
            }

            Event::Code(code) => {
                html.push_str(&format!("<code>{}</code>", html_escape(&code)));
                if current_heading.is_some() {
                    heading_slug_buf.push_str(&code);
                }
            }

            Event::SoftBreak => {
                if in_image.is_some() {
                    image_alt_buf.push(' ');
                } else {
                    // A single newline inside a paragraph. CommonMark
                    // renders it as a space; with "Preserve line breaks"
                    // on we emit a <br> so each source line stays on its
                    // own line. The slug always uses a space — a heading
                    // can't span a soft break, but keep IDs <br>-free.
                    if preserve_line_breaks {
                        html.push_str("<br>");
                    } else {
                        html.push(' ');
                    }
                    if current_heading.is_some() {
                        heading_slug_buf.push(' ');
                    }
                }
            }
            Event::HardBreak => html.push_str("<br>"),

            Event::Rule => html.push_str("<hr>\n"),

            // Raw HTML in the source is rendered as literal text, not
            // executed. Passing it through unchanged is an XSS vector:
            // a malicious .md file could embed `<script>` or an
            // `onerror=` handler. Covers both block-level Html and
            // inline HTML spans (e.g. `<br>` within a paragraph).
            // Inside a heading the escaped text gets drained into the
            // <hN> via `split_off`; we deliberately do NOT contribute
            // raw HTML tokens to the slug buffer so IDs stay clean.
            Event::Html(raw) | Event::InlineHtml(raw) => {
                if in_image.is_some() {
                    image_alt_buf.push_str(&raw);
                } else if let Some(safe) = sanitize_inline_html(&raw) {
                    html.push_str(safe);
                } else {
                    html.push_str(&html_escape(&raw));
                }
            }

            _ => {}
        }
    }

    // Flush the collected footnote definitions into a trailing section.
    // Definitions are ordered by their display number so the list reads
    // 1, 2, 3 regardless of the order they appeared in the source. Each
    // definition gets a back-reference arrow linking to its `[^label]`
    // call site; the body is rendered HTML, so the arrow is spliced just
    // before the closing `</p>` of the last paragraph when there is one,
    // otherwise simply appended.
    if !footnote_defs.is_empty() {
        footnote_defs.sort_by_key(|(num, _)| *num);
        html.push_str("<section class=\"footnotes\">\n<ol>\n");
        for (num, body) in &footnote_defs {
            let backref = format!(
                "<a href=\"#fnref{}\" class=\"footnote-backref\" aria-label=\"Back to reference {}\">\u{21a9}</a>",
                num, num
            );
            // Tuck the arrow inside the final paragraph — but only when a
            // paragraph really is the last block. `rfind` alone would also
            // match a `</p>` buried before a trailing list or code block and
            // splice the arrow mid-footnote; guard on nothing but whitespace
            // following the close so those cases fall through to an append.
            let body = match body.rfind("</p>\n") {
                Some(pos) if body[pos + "</p>\n".len()..].trim().is_empty() => {
                    format!("{}{}{}", &body[..pos], backref, &body[pos..])
                }
                _ => format!("{}{}", body, backref),
            };
            html.push_str(&format!("<li id=\"fn{}\">{}</li>\n", num, body));
        }
        html.push_str("</ol>\n</section>\n");
    }

    html
}

/// Resolve an image src into a local asset path, an inline passthrough, or
/// a gated remote URL — see [`ResolvedImage`].
///
/// `http(s)` and protocol-relative URLs are gated (no network on render);
/// `data:` URIs pass through inline. Local paths that resolve to an existing
/// file are canonicalized and stripped of the Windows `\\?\` verbatim prefix
/// so that `convertFileSrc` in the frontend produces a well-formed asset URL.
/// Missing files fall back to passthrough so the browser renders a
/// broken-image icon rather than a blank area.
/// Allowlist a tiny set of formatting-only inline HTML tags so the
/// editor's Underline action (`<u>…</u>`) actually renders. Only the
/// bare opening/closing tags are permitted — no attributes, no other
/// elements — so the broader XSS-safety guarantee on the raw-HTML path
/// (every other `Event::Html`/`InlineHtml` token stays escaped) holds.
fn sanitize_inline_html(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "<u>" => Some("<u>"),
        "</u>" => Some("</u>"),
        _ => None,
    }
}

fn resolve_image(src: &str, base_dir: Option<&Path>) -> ResolvedImage {
    // The gate is a security boundary, so scheme detection can't be naive:
    // URL schemes are case-insensitive (`HTTP://` loads just like `http://`),
    // and the webview ignores leading whitespace/control chars in a `src`.
    // Match on a trimmed, lowercased copy so `HTTP://`, `\thttp://`, etc. are
    // still gated rather than slipping through to the live-passthrough
    // fallback below.
    let probe = src.trim_start_matches(|c: char| c.is_ascii_whitespace() || c.is_control());
    let lower = probe.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || probe.starts_with("//") {
        return ResolvedImage::RemoteGated(src.to_string());
    }
    if lower.starts_with("data:") {
        return ResolvedImage::Passthrough(src.to_string());
    }

    let base = match base_dir {
        Some(d) => d,
        None => return ResolvedImage::Passthrough(src.to_string()),
    };

    let path = if Path::new(src).is_absolute() {
        std::path::PathBuf::from(src)
    } else {
        base.join(src)
    };

    if !path.is_file() {
        return ResolvedImage::Passthrough(src.to_string());
    }

    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
    let stripped = crate::commands::strip_windows_verbatim(canonical);
    ResolvedImage::AssetPath(stripped.to_string_lossy().into_owned())
}

/// True when a link `href` uses a scheme that can execute script or
/// smuggle active content if the anchor is ever followed outside our
/// click interceptor (notably the standalone file `export_html` writes).
/// Such links are rendered without an `href` so the document text stays
/// but the scheme can't fire. Mirrors the case/whitespace care in
/// `resolve_image`: URL schemes are case-insensitive and the webview
/// ignores leading whitespace/control chars before the scheme, so the
/// gate matches on a trimmed, lowercased probe rather than naively.
fn is_dangerous_link_scheme(href: &str) -> bool {
    let probe = href.trim_start_matches(|c: char| c.is_ascii_whitespace() || c.is_control());
    let lower = probe.to_ascii_lowercase();
    lower.starts_with("javascript:") || lower.starts_with("vbscript:") || lower.starts_with("data:")
}

fn slugify(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Hello World"), "hello-world");
    }

    #[test]
    fn slugify_collapses_runs_of_punctuation() {
        assert_eq!(slugify("Hello --- World!!!"), "hello-world");
    }

    #[test]
    fn slugify_trims_edges() {
        assert_eq!(slugify("  spaced  "), "spaced");
    }

    #[test]
    fn slugify_empty() {
        assert_eq!(slugify(""), "");
        assert_eq!(slugify("!!!"), "");
    }

    #[test]
    fn slugify_keeps_unicode_letters() {
        // is_alphanumeric() in Rust accepts unicode letters.
        assert_eq!(slugify("Café au lait"), "café-au-lait");
    }

    #[test]
    fn render_plain_paragraph() {
        let out = render("hello world", None);
        assert_eq!(out, "<p>hello world</p>\n");
    }

    #[test]
    fn render_escapes_text_content() {
        let out = render("a < b & c", None);
        assert!(out.contains("&lt;"));
        assert!(out.contains("&amp;"));
        assert!(!out.contains("<b "));
    }

    #[test]
    fn render_allows_underline_tag() {
        // The editor's Underline action emits bare <u>…</u>; the renderer
        // allowlists just those tags so the formatting actually shows.
        let out = render("a <u>b</u> c", None);
        assert!(out.contains("<u>b</u>"), "got: {out}");
    }

    #[test]
    fn render_still_escapes_other_inline_html() {
        // The underline allowlist must not widen the raw-HTML hole: other
        // tags (and <u> with attributes) stay escaped.
        let out = render("<u onclick=\"x\">b</u> <b>c</b>", None);
        assert!(out.contains("&lt;u onclick"), "got: {out}");
        assert!(out.contains("&lt;b&gt;"), "got: {out}");
        assert!(!out.contains("<b>"), "got: {out}");
    }

    #[test]
    fn render_unordered_list() {
        let out = render("- one\n- two\n", None);
        assert!(out.contains("<ul>"));
        assert!(out.contains("<li>one</li>"));
        assert!(out.contains("<li>two</li>"));
    }

    #[test]
    fn render_ordered_list_with_start() {
        let out = render("3. a\n4. b\n", None);
        assert!(out.contains("<ol start=\"3\">"));
    }

    #[test]
    fn render_code_block_unlabeled_escapes() {
        let out = render("```\n<html>\n```\n", None);
        assert!(out.contains("<pre><code>"));
        assert!(out.contains("&lt;html&gt;"));
    }

    #[test]
    fn render_code_block_labeled_sets_class() {
        let out = render("```rust\nfn main() {}\n```\n", None);
        assert!(out.contains("class=\"language-rust\""));
    }

    #[test]
    fn render_inline_code_escapes() {
        let out = render("use `<tag>` here", None);
        assert!(out.contains("<code>&lt;tag&gt;</code>"));
    }

    #[test]
    fn render_link_escapes_href() {
        let out = render("[x](https://example.com/?a=1&b=2)", None);
        assert!(out.contains("href=\"https://example.com/?a=1&amp;b=2\""));
        assert!(out.contains("class=\"md-link\""));
    }

    #[test]
    fn render_link_javascript_scheme_is_neutralized() {
        // A `javascript:` href must never reach the rendered markup — it
        // would execute if the anchor were followed outside our click
        // interceptor (e.g. an exported standalone HTML file).
        let out = render("[click](javascript:alert(1))", None);
        assert!(
            !out.contains("href=\"javascript"),
            "javascript: href leaked: {out}"
        );
        assert!(
            out.contains("class=\"md-link md-link-blocked\""),
            "not marked blocked: {out}"
        );
        // The link text is preserved.
        assert!(out.contains(">click</a>"), "link text lost: {out}");
    }

    #[test]
    fn render_link_neutralizes_scheme_case_and_whitespace_variants() {
        // The gate is a security control: a case-variant scheme or
        // webview-ignored leading whitespace must not slip a live href
        // through.
        for href in [
            "JavaScript:alert(1)",
            "  javascript:alert(1)",
            "\tvbscript:msgbox(1)",
            "data:text/html,<script>alert(1)</script>",
            "VBScript:msgbox(1)",
        ] {
            let md = format!("[x]({href})");
            let out = render(&md, None);
            assert!(
                out.contains("md-link-blocked") && !out.contains(" href="),
                "scheme variant not neutralized: {href:?} -> {out}"
            );
        }
    }

    #[test]
    fn render_link_safe_schemes_keep_href() {
        // Regression: ordinary links (http/https/mailto/relative) must
        // still get a live href.
        assert!(render("[a](https://example.com)", None).contains("href=\"https://example.com\""));
        assert!(render("[a](mailto:x@y.z)", None).contains("href=\"mailto:x@y.z\""));
        assert!(render("[a](./other.md)", None).contains("href=\"./other.md\""));
    }

    #[test]
    fn render_table_with_alignment() {
        let md = "| a | b |\n|:--|--:|\n| 1 | 2 |\n";
        let out = render(md, None);
        assert!(out.contains("<table>"));
        assert!(out.contains("<thead>"));
        assert!(out.contains("style=\"text-align:left\""));
        assert!(out.contains("style=\"text-align:right\""));
    }

    #[test]
    fn render_heading_assigns_id() {
        let out = render("# Hello World\n", None);
        assert!(out.contains("<h1 id=\"hello-world\">"));
        assert!(out.contains("Hello World"));
        assert!(out.contains("</h1>"));
    }

    #[test]
    fn render_heading_duplicate_ids_disambiguated() {
        let out = render("# Intro\n\n# Intro\n", None);
        assert!(out.contains("<h1 id=\"intro\">"));
        assert!(out.contains("<h1 id=\"intro-1\">"));
    }

    #[test]
    fn render_heading_slug_collides_with_disambiguation_suffix() {
        // "Step 1" slugs to "step-1"; the 2nd "Step" would naively also
        // become "step-1". Each heading must still get a unique id.
        let out = render("# Step 1\n\n# Step\n\n# Step\n", None);
        assert!(out.contains("<h1 id=\"step-1\">"));
        assert!(out.contains("<h1 id=\"step\">"));
        assert!(out.contains("<h1 id=\"step-2\">"), "collision not resolved: {out}");
        // The first "step-1" (from "Step 1") must not be reused by a later heading.
        assert_eq!(out.matches("id=\"step-1\"").count(), 1, "duplicate id: {out}");
    }

    #[test]
    fn render_heading_with_bold_preserves_inline_tag_inside_hn() {
        let out = render("## **bold** x\n", None);
        // The <strong> must be INSIDE <h2>, not orphaned before it.
        assert!(
            out.contains("<h2 id=\"bold-x\"><strong>bold</strong> x</h2>"),
            "unexpected output: {out}"
        );
    }

    #[test]
    fn render_heading_with_ampersand_has_clean_slug() {
        // Regression: the old code built the slug from HTML-escaped text,
        // so "Hello & World" became "hello-amp-world" via "&amp;". The
        // slug must come from the raw plain text.
        let out = render("## Hello & World\n", None);
        assert!(out.contains("id=\"hello-world\""));
        assert!(!out.contains("hello-amp-world"));
        // And the display text must still be properly entity-escaped.
        assert!(out.contains("Hello &amp; World"));
    }

    #[test]
    fn render_heading_with_inline_code_preserves_code_inside_hn() {
        let out = render("## `code` x\n", None);
        assert!(
            out.contains("<h2 id=\"code-x\"><code>code</code> x</h2>"),
            "unexpected output: {out}"
        );
    }

    #[test]
    fn render_heading_with_image_uses_alt_in_slug() {
        let out = render("## ![alt](img.png) x\n", None);
        // Alt contributes to the slug; the <img> tag stays inside <h2>.
        assert!(out.contains("id=\"alt-x\""), "unexpected output: {out}");
        assert!(out.contains("<h2 id=\"alt-x\"><img src="));
        assert!(out.contains("</h2>"));
    }

    #[test]
    fn render_heading_with_link_preserves_anchor_inside_hn() {
        let out = render("## [see](./x.md) this\n", None);
        assert!(out.contains("<h2 id=\"see-this\">"));
        assert!(out.contains("<a href=\"./x.md\""));
        assert!(out.contains("see</a>"));
        assert!(out.contains("</h2>"));
    }

    #[test]
    fn render_heading_with_emphasis_preserves_em_inside_hn() {
        let out = render("### *emph* rest\n", None);
        assert!(out.contains("<h3 id=\"emph-rest\"><em>emph</em> rest</h3>"));
    }

    #[test]
    fn render_hr() {
        let out = render("---\n", None);
        assert!(out.contains("<hr>"));
    }

    #[test]
    fn render_blockquote() {
        let out = render("> quoted\n", None);
        assert!(out.contains("<blockquote>"));
        assert!(out.contains("quoted"));
        assert!(out.contains("</blockquote>"));
    }

    #[test]
    fn render_strikethrough() {
        let out = render("~~gone~~", None);
        assert!(out.contains("<del>gone</del>"));
    }

    #[test]
    fn render_soft_break_is_space_by_default() {
        // A single newline inside a paragraph is CommonMark "soft break"
        // territory: rendered as a space, so the two lines join.
        let out = render_with("line one\nline two", None, false);
        assert!(out.contains("line one line two"));
        assert!(!out.contains("<br>"));
    }

    #[test]
    fn render_soft_break_is_br_when_preserve_line_breaks() {
        let out = render_with("line one\nline two", None, true);
        assert!(out.contains("line one<br>line two"));
    }

    #[test]
    fn render_hard_break_is_br_regardless_of_setting() {
        // Two trailing spaces force a hard break — always a <br>, whether
        // or not soft breaks are being preserved.
        assert!(render_with("a  \nb", None, false).contains("a<br>b"));
        assert!(render_with("a  \nb", None, true).contains("a<br>b"));
    }

    #[test]
    fn render_task_list_unchecked_emits_disabled_checkbox() {
        let out = render("- [ ] todo\n", None);
        assert!(
            out.contains("task-list-checkbox") && out.contains("disabled"),
            "task list missing checkbox markup: {out}"
        );
        assert!(
            !out.contains("checked"),
            "unchecked task should not have `checked`: {out}"
        );
    }

    #[test]
    fn render_task_list_checked_emits_checked_checkbox() {
        let out = render("- [x] done\n", None);
        assert!(out.contains("task-list-checkbox"));
        assert!(out.contains("checked"));
    }

    #[test]
    fn render_code_block_wraps_with_codeblock_div_and_data_code() {
        let out = render("```\nhello\nworld\n```\n", None);
        assert!(
            out.contains("class=\"codeblock\""),
            "missing wrapper: {out}"
        );
        assert!(out.contains("data-code=\""), "missing data-code: {out}");
        // Newlines get encoded as numeric entities so HTML5 attribute
        // parsing doesn't normalize them to spaces.
        assert!(
            out.contains("hello&#10;world&#10;"),
            "newlines not encoded: {out}"
        );
        // And the original <pre><code> structure is still there.
        assert!(out.contains("<pre><code>"), "lost pre/code: {out}");
    }

    #[test]
    fn render_code_block_with_language_emits_lang_label() {
        let out = render("```rust\nfn x() {}\n```\n", None);
        assert!(
            out.contains("codeblock-lang"),
            "missing lang label span: {out}"
        );
        assert!(out.contains(">rust</span>"), "lang text wrong: {out}");
    }

    #[test]
    fn resolve_image_remote_is_gated() {
        // http(s) and protocol-relative URLs are gated — they must not
        // become a live `src` that fires a request on render.
        assert_eq!(
            resolve_image("https://example.com/a.png", None),
            ResolvedImage::RemoteGated("https://example.com/a.png".into())
        );
        assert_eq!(
            resolve_image("http://example.com/a.png", None),
            ResolvedImage::RemoteGated("http://example.com/a.png".into())
        );
        assert_eq!(
            resolve_image("//cdn.example.com/a.png", None),
            ResolvedImage::RemoteGated("//cdn.example.com/a.png".into())
        );
    }

    #[test]
    fn resolve_image_gates_case_and_whitespace_variants() {
        // The gate is a security control, so it must not be defeated by a
        // case-variant scheme or webview-ignored leading whitespace — those
        // would otherwise fall through to a live-passthrough `src` and leak
        // the reader's IP on render even with remote images disabled.
        for variant in [
            "HTTP://example.com/a.png",
            "HTTPS://example.com/a.png",
            "HttpS://example.com/a.png",
            "  http://example.com/a.png",
            "\thttps://example.com/a.png",
        ] {
            assert_eq!(
                resolve_image(variant, None),
                ResolvedImage::RemoteGated(variant.into()),
                "scheme variant not gated: {variant:?}"
            );
        }
    }

    #[test]
    fn resolve_image_data_uri_passes_through() {
        // data: URIs are self-contained — no network, so they stay inline.
        assert_eq!(
            resolve_image("data:image/png;base64,AAAA", None),
            ResolvedImage::Passthrough("data:image/png;base64,AAAA".into())
        );
    }

    #[test]
    fn resolve_image_no_base_dir_passthrough() {
        assert_eq!(
            resolve_image("./a.png", None),
            ResolvedImage::Passthrough("./a.png".into())
        );
    }

    #[test]
    fn resolve_image_missing_file_passthrough() {
        let base = std::path::Path::new("/definitely/does/not/exist");
        assert_eq!(
            resolve_image("nope.png", Some(base)),
            ResolvedImage::Passthrough("nope.png".into())
        );
    }

    #[test]
    fn resolve_image_local_file_returns_asset_path() {
        // Write a real file under a temp dir, pass its parent as base_dir,
        // and check we get back an AssetPath with the canonical absolute
        // path — free of the Windows `\\?\` verbatim prefix.
        let dir = std::env::temp_dir().join(format!(
            "oxidemd-img-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("pic.png");
        std::fs::write(&img, b"not-real-png-bytes").unwrap();

        let resolved = resolve_image("pic.png", Some(&dir));
        match resolved {
            ResolvedImage::AssetPath(p) => {
                assert!(!p.starts_with(r"\\?\"), "verbatim prefix leaked: {p}");
                assert!(p.ends_with("pic.png"), "path missing filename: {p}");
            }
            other => panic!("expected AssetPath, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn render_local_image_emits_data_oxide_src() {
        // A real local file must go into data-oxide-src (not src) so the
        // frontend can route it through the asset protocol.
        let dir = std::env::temp_dir().join(format!(
            "oxidemd-render-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("pic.png");
        std::fs::write(&img, b"bytes").unwrap();

        let out = render("![alt](pic.png)", Some(&dir));
        assert!(
            out.contains("data-oxide-src=\""),
            "local image didn't route through data-oxide-src: {out}"
        );
        assert!(!out.contains("src=\"pic.png\""));
        assert!(out.contains("alt=\"alt\""));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn render_remote_image_is_gated_not_live() {
        let out = render("![a](https://example.com/a.png)", None);
        // Gated: a neutral data attribute plus the marker class, never a
        // live `src` that would fire a request on render.
        assert!(
            out.contains("data-oxide-remote-src=\"https://example.com/a.png\""),
            "remote url not gated: {out}"
        );
        assert!(
            out.contains("class=\"md-remote-image\""),
            "missing marker class: {out}"
        );
        assert!(!out.contains("data-oxide-src"));
        // A leading space distinguishes a real `src=` attribute from the
        // `…-src=` tail of `data-oxide-remote-src`.
        assert!(
            !out.contains(" src=\"https"),
            "remote url leaked into live src: {out}"
        );
    }

    #[test]
    fn raw_block_html_script_is_escaped_not_executed() {
        let out = render("<script>alert(1)</script>\n", None);
        assert!(!out.contains("<script>"));
        assert!(!out.contains("</script>"));
        assert!(out.contains("&lt;script&gt;"));
    }

    #[test]
    fn raw_block_html_img_onerror_is_escaped() {
        let out = render("<img src=x onerror=\"alert(1)\">\n", None);
        // The neutralized form must not contain a raw <img tag with onerror.
        assert!(!out.contains("<img src=x onerror"));
        assert!(out.contains("&lt;img"));
    }

    #[test]
    fn raw_inline_html_is_escaped() {
        // A `<b>` inside a paragraph is emitted as Event::InlineHtml by
        // pulldown-cmark; it must not pass through as raw markup.
        let out = render("paragraph with <b>bold</b> html\n", None);
        assert!(!out.contains("<b>bold</b>"));
        assert!(out.contains("&lt;b&gt;"));
    }

    #[test]
    fn raw_inline_script_in_paragraph_is_escaped() {
        let out = render("before <script>alert(1)</script> after\n", None);
        assert!(!out.contains("<script>"));
        assert!(out.contains("&lt;script&gt;"));
    }

    #[test]
    fn raw_html_inside_heading_is_escaped() {
        let out = render("# Hello <script>alert(1)</script>\n", None);
        assert!(!out.contains("<script>"));
        assert!(out.contains("&lt;script&gt;"));
    }

    #[test]
    fn render_footnote_links_reference_and_definition() {
        let out = render("Text[^1].\n\n[^1]: The note.\n", None);
        // Reference site: a superscript anchor pointing at the definition.
        assert!(
            out.contains("<sup class=\"footnote-ref\"><a id=\"fnref1\" href=\"#fn1\">1</a></sup>"),
            "missing footnote reference markup: {out}"
        );
        // Definitions flush into a trailing <section class="footnotes">.
        assert!(
            out.contains("<section class=\"footnotes\">"),
            "missing footnotes section: {out}"
        );
        assert!(
            out.contains("<li id=\"fn1\">"),
            "missing footnote definition item: {out}"
        );
        assert!(out.contains("The note."), "footnote body lost: {out}");
        // And a back-reference arrow links the definition to its call site.
        assert!(
            out.contains("href=\"#fnref1\" class=\"footnote-backref\""),
            "missing footnote back-reference: {out}"
        );
    }

    #[test]
    fn render_heading_explicit_id_overrides_slug() {
        let out = render("# Hello World {#custom}\n", None);
        // The explicit `{#id}` wins over the auto-generated slug.
        assert!(
            out.contains("<h1 id=\"custom\">"),
            "explicit id not used: {out}"
        );
        assert!(
            !out.contains("id=\"hello-world\""),
            "auto slug leaked: {out}"
        );
        assert!(out.contains("Hello World"));
    }

    #[test]
    fn render_heading_explicit_id_still_disambiguates() {
        // An explicit `{#custom}` still flows through `heading_counts`, so a
        // later auto-slug that collides with it gets a `-1` suffix.
        let out = render("# A {#custom}\n\n# Custom\n", None);
        assert!(
            out.contains("<h1 id=\"custom\">"),
            "explicit id not used: {out}"
        );
        assert!(
            out.contains("<h1 id=\"custom-1\">"),
            "collision not disambiguated: {out}"
        );
    }

    #[test]
    fn render_autolink_angle_bracket_is_clickable() {
        // pulldown-cmark 0.12.2 has no GFM bare-URL autolink option, but
        // CommonMark angle-bracket autolinks work with no options at all.
        let out = render("Visit <https://example.com> today.\n", None);
        assert!(
            out.contains("href=\"https://example.com\""),
            "angle-bracket autolink not rendered as a link: {out}"
        );
    }
}
