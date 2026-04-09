use crate::util::html_escape;
use syntect::easy::HighlightLines;
use syntect::highlighting::ThemeSet;
use syntect::html::{styled_line_to_highlighted_html, IncludeBackground};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

pub struct Highlighter {
    ss: SyntaxSet,
    ts: ThemeSet,
}

impl Highlighter {
    pub fn new() -> Self {
        Highlighter {
            ss: SyntaxSet::load_defaults_newlines(),
            ts: ThemeSet::load_defaults(),
        }
    }

    pub fn highlight(&self, code: &str, lang: &str) -> String {
        let syntax = self
            .ss
            .find_syntax_by_token(lang)
            .or_else(|| self.ss.find_syntax_by_extension(lang))
            .unwrap_or_else(|| self.ss.find_syntax_plain_text());

        let theme = &self.ts.themes["base16-ocean.dark"];
        let mut h = HighlightLines::new(syntax, theme);
        let mut html = String::new();

        for line in LinesWithEndings::from(code) {
            let ranges = match h.highlight_line(line, &self.ss) {
                Ok(r) => r,
                Err(_) => {
                    html.push_str(&html_escape(line));
                    continue;
                }
            };
            match styled_line_to_highlighted_html(&ranges[..], IncludeBackground::No) {
                Ok(line_html) => html.push_str(&line_html),
                Err(_) => html.push_str(&html_escape(line)),
            }
        }

        html
    }
}

