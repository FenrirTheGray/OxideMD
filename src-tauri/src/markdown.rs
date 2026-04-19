use crate::highlight::Highlighter;
use crate::util::{html_escape, html_escape_attr};
use pulldown_cmark::{
    Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd,
};
use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

/// Result of resolving an image src.
///
/// Remote URLs (http(s), protocol-relative, data:) are passed through as the
/// element's `src`. Local files are emitted as `data-oxide-src` so the
/// frontend can rewrite them via `convertFileSrc` to asset:// URLs — this
/// avoids inlining the image bytes as base64 into the HTML string.
#[derive(Debug, PartialEq, Eq)]
pub enum ResolvedImage {
    AssetPath(String),
    Passthrough(String),
}

static HIGHLIGHTER: OnceLock<Highlighter> = OnceLock::new();

pub fn render(source: &str, base_dir: Option<&Path>) -> String {
    let highlighter = HIGHLIGHTER.get_or_init(Highlighter::new);

    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_SMART_PUNCTUATION;

    let parser = Parser::new_ext(source, options);

    let mut html = String::new();
    let mut heading_counts: HashMap<String, usize> = HashMap::new();

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
    let mut in_image: Option<(String, String)> = None; // (src, title)
    let mut image_alt_buf = String::new();

    for event in parser {
        match event {
            // ── Blocks ──────────────────────────────────────────────────────
            Event::Start(Tag::Heading { level, .. }) => {
                current_heading = Some(level);
                heading_start = html.len();
                heading_slug_buf.clear();
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
                let slug = slugify(&heading_slug_buf);
                let count = heading_counts.entry(slug.clone()).or_insert(0);
                let id = if *count == 0 {
                    slug.clone()
                } else {
                    format!("{}-{}", slug, count)
                };
                *count += 1;
                html.push_str(&format!(
                    "<{} id=\"{}\">{}</{}>",
                    tag, id, content, tag
                ));
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
                html.push_str(&format!(
                    "<pre><code{}>{}</code></pre>\n",
                    lang_class, highlighted
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
                html.push_str(&format!(
                    "<a href=\"{}\" class=\"md-link\">",
                    html_escape_attr(&dest_url)
                ));
            }
            Event::End(TagEnd::Link) => html.push_str("</a>"),

            Event::Start(Tag::Image { dest_url, title, .. }) => {
                in_image = Some((dest_url.to_string(), title.to_string()));
                image_alt_buf.clear();
            }
            Event::End(TagEnd::Image) => {
                if let Some((src, title)) = in_image.take() {
                    let (attr, value) = match resolve_image(&src, base_dir) {
                        ResolvedImage::AssetPath(p) => ("data-oxide-src", p),
                        ResolvedImage::Passthrough(u) => ("src", u),
                    };
                    html.push_str(&format!(
                        "<img {}=\"{}\" alt=\"{}\" title=\"{}\" loading=\"lazy\">",
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
                    html.push(' ');
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
                } else {
                    html.push_str(&html_escape(&raw));
                }
            }

            _ => {}
        }
    }

    html
}

/// Resolve an image src into either an absolute local path (for asset://)
/// or a passthrough URL.
///
/// Remote URLs and data URIs are passed through unchanged. Local paths that
/// resolve to an existing file are canonicalized and stripped of the Windows
/// `\\?\` verbatim prefix so that `convertFileSrc` in the frontend produces
/// a well-formed asset URL. Missing files fall back to passthrough so the
/// browser renders a broken-image icon rather than a blank area.
fn resolve_image(src: &str, base_dir: Option<&Path>) -> ResolvedImage {
    if src.starts_with("http://")
        || src.starts_with("https://")
        || src.starts_with("data:")
        || src.starts_with("//")
    {
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
    fn render_heading_with_bold_preserves_inline_tag_inside_hN() {
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
    fn render_heading_with_inline_code_preserves_code_inside_hN() {
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
    fn render_heading_with_link_preserves_anchor_inside_hN() {
        let out = render("## [see](./x.md) this\n", None);
        assert!(out.contains("<h2 id=\"see-this\">"));
        assert!(out.contains("<a href=\"./x.md\""));
        assert!(out.contains("see</a>"));
        assert!(out.contains("</h2>"));
    }

    #[test]
    fn render_heading_with_emphasis_preserves_em_inside_hN() {
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
    fn resolve_image_remote_passthrough() {
        assert_eq!(
            resolve_image("https://example.com/a.png", None),
            ResolvedImage::Passthrough("https://example.com/a.png".into())
        );
        assert_eq!(
            resolve_image("http://example.com/a.png", None),
            ResolvedImage::Passthrough("http://example.com/a.png".into())
        );
        assert_eq!(
            resolve_image("//cdn.example.com/a.png", None),
            ResolvedImage::Passthrough("//cdn.example.com/a.png".into())
        );
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
    fn render_remote_image_emits_src_directly() {
        let out = render("![a](https://example.com/a.png)", None);
        assert!(out.contains("src=\"https://example.com/a.png\""));
        assert!(!out.contains("data-oxide-src"));
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

}

