use crate::highlight::Highlighter;
use crate::util::{html_escape, html_escape_attr};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use pulldown_cmark::{
    Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd,
};
use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

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
    let mut heading_text_buf = String::new();
    let mut current_heading: Option<HeadingLevel> = None;
    let mut in_image: Option<(String, String)> = None; // (src, title)
    let mut image_alt_buf = String::new();

    for event in parser {
        match event {
            // ── Blocks ──────────────────────────────────────────────────────
            Event::Start(Tag::Heading { level, .. }) => {
                current_heading = Some(level);
                heading_text_buf.clear();
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
                let slug = slugify(&heading_text_buf);
                let count = heading_counts.entry(slug.clone()).or_insert(0);
                let id = if *count == 0 {
                    slug.clone()
                } else {
                    format!("{}-{}", slug, count)
                };
                *count += 1;
                html.push_str(&format!(
                    "<{} id=\"{}\">{}</{}>",
                    tag, id, heading_text_buf, tag
                ));
                heading_text_buf.clear();
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
                    let resolved = resolve_image(&src, base_dir);
                    html.push_str(&format!(
                        "<img src=\"{}\" alt=\"{}\" title=\"{}\" loading=\"lazy\">",
                        html_escape_attr(&resolved),
                        html_escape(&image_alt_buf),
                        html_escape_attr(&title)
                    ));
                    image_alt_buf.clear();
                }
            }

            // ── Leaf events ──────────────────────────────────────────────────
            Event::Text(text) => {
                if in_code_block {
                    code_buf.push_str(&text);
                } else if in_image.is_some() {
                    image_alt_buf.push_str(&text);
                } else if current_heading.is_some() {
                    heading_text_buf.push_str(&html_escape(&text));
                } else {
                    html.push_str(&html_escape(&text));
                }
            }

            Event::Code(code) => {
                html.push_str(&format!("<code>{}</code>", html_escape(&code)));
            }

            Event::SoftBreak => {
                if current_heading.is_none() && in_image.is_none() {
                    html.push(' ');
                }
            }
            Event::HardBreak => html.push_str("<br>"),

            Event::Rule => html.push_str("<hr>\n"),

            Event::Html(raw) => html.push_str(&raw),

            _ => {}
        }
    }

    html
}

/// Resolve a local image path to a base64 data URI.
/// Remote URLs and data URIs are returned as-is.
fn resolve_image(src: &str, base_dir: Option<&Path>) -> String {
    if src.starts_with("http://")
        || src.starts_with("https://")
        || src.starts_with("data:")
        || src.starts_with("//")
    {
        return src.to_string();
    }

    let base = match base_dir {
        Some(d) => d,
        None => return src.to_string(),
    };

    let path = if Path::new(src).is_absolute() {
        std::path::PathBuf::from(src)
    } else {
        base.join(src)
    };

    match std::fs::read(&path) {
        Ok(bytes) => {
            let mime = mime_for_path(&path);
            let encoded = B64.encode(&bytes);
            format!("data:{};base64,{}", mime, encoded)
        }
        Err(_) => src.to_string(),
    }
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
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

