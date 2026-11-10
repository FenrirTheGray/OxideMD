use crate::util::html_escape;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

pub struct Highlighter {
    ss: SyntaxSet,
}

impl Highlighter {
    pub fn new() -> Self {
        Highlighter {
            ss: SyntaxSet::load_defaults_newlines(),
        }
    }

    /// Scope classes (`hl-keyword`, `hl-string`, ...) rather than inline
    /// colours, so markdown.css can colour them per light/dark theme.
    pub fn highlight(&self, code: &str, lang: &str) -> String {
        let syntax = self
            .ss
            .find_syntax_by_token(lang)
            .or_else(|| self.ss.find_syntax_by_extension(lang))
            .unwrap_or_else(|| self.ss.find_syntax_plain_text());

        let mut out = ClassedHTMLGenerator::new_with_class_style(
            syntax,
            &self.ss,
            ClassStyle::SpacedPrefixed { prefix: "hl-" },
        );
        for line in LinesWithEndings::from(code) {
            if out
                .parse_html_for_line_which_includes_newline(line)
                .is_err()
            {
                return html_escape(code);
            }
        }
        out.finalize()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlight_emits_scope_classes_not_inline_colours() {
        let out = Highlighter::new().highlight("let s = \"a<b\"; // c\n", "rust");
        assert!(out.contains("class=\"hl-"), "{out}");
        assert!(out.contains("hl-string"), "{out}");
        assert!(out.contains("hl-comment"), "{out}");
        assert!(!out.contains("style="), "{out}");
        assert!(out.contains("a&lt;b"), "{out}");
    }
}
