//! Grammar checking with Harper (offline, English only), on its own thread. The linter keeps internal caches, so
//! one long-lived instance serves every request.

use harper_core::linting::{LintGroup, LintKind, Suggestion};
use harper_core::spell::FstDictionary;
use harper_core::{remove_overlaps_map, Dialect, Document};
use serde::Serialize;
use std::sync::mpsc::{channel, Receiver, Sender};

#[derive(Serialize)]
pub struct GrammarIssue {
    /// Offset and length in UTF-16 code units, which is how JavaScript measures strings.
    pub start: u32,
    pub length: u32,
    /// Harper's rule name (e.g. "SentenceCapitalization"), used to turn a rule off for a book.
    pub rule: String,
    pub kind: String,
    pub message: String,
    /// Replacement text for the marked span, best first. An empty string means "remove it".
    pub fixes: Vec<String>,
}

struct Request {
    texts: Vec<String>,
    reply: Sender<Vec<Vec<GrammarIssue>>>,
}

pub struct Grammar(Sender<Request>);

impl Grammar {
    pub fn start() -> Grammar {
        let (tx, rx) = channel();
        std::thread::Builder::new().name("grammar".into()).spawn(move || run(rx)).expect("couldn't start the grammar thread");
        Grammar(tx)
    }

    pub async fn check(&self, texts: Vec<String>) -> Result<Vec<Vec<GrammarIssue>>, String> {
        let (reply, answer) = channel();
        self.0.send(Request { texts, reply }).map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || answer.recv().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())?
    }
}

/// Leave out spelling (Windows' checker does that) and categories about style or preference rather than errors.
fn wanted(kind: LintKind) -> bool {
    !matches!(
        kind,
        LintKind::Spelling | LintKind::Style | LintKind::Enhancement | LintKind::Readability | LintKind::Redundancy | LintKind::Regionalism
    )
}

fn new_linter(dictionary: &std::sync::Arc<FstDictionary>) -> LintGroup {
    let mut linter = LintGroup::new_curated(dictionary.clone(), Dialect::British);
    linter.config.set_rule_enabled("SpellCheck", false);
    linter
}

fn run(requests: Receiver<Request>) {
    let dictionary = FstDictionary::curated();
    let mut linter = new_linter(&dictionary);
    for Request { texts, reply } in requests {
        let issues = texts.iter().map(|text| check(&mut linter, &dictionary, text)).collect();
        let _ = reply.send(issues);
    }
}

fn check(linter: &mut LintGroup, dictionary: &FstDictionary, text: &str) -> Vec<GrammarIssue> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let document = Document::new_markdown_default(text, dictionary);
    let source = document.get_source();
    // UTF-16 offset of each character (plus one past the end), to convert Harper's character spans.
    let mut utf16 = Vec::with_capacity(source.len() + 1);
    let mut at = 0u32;
    for c in source {
        utf16.push(at);
        at += c.len_utf16() as u32;
    }
    utf16.push(at);

    let mut lints = linter.organized_lints(&document);
    remove_overlaps_map(&mut lints);
    let mut out = Vec::new();
    for (rule, lints) in lints {
        for lint in lints.into_iter().filter(|l| wanted(l.lint_kind)) {
            let (start, end) = (lint.span.start.min(source.len()), lint.span.end.min(source.len()));
            let original: String = source[start..end].iter().collect();
            let fixes = lint
                .suggestions
                .iter()
                .map(|s| match s {
                    Suggestion::ReplaceWith(chars) => chars.iter().collect(),
                    Suggestion::InsertAfter(chars) => format!("{original}{}", chars.iter().collect::<String>()),
                    Suggestion::Remove => String::new(),
                })
                .collect();
            out.push(GrammarIssue {
                start: utf16[start],
                length: utf16[end] - utf16[start],
                rule: rule.clone(),
                kind: lint.lint_kind.to_string(),
                message: lint.message,
                fixes,
            });
        }
    }
    out.sort_by_key(|i| i.start);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marked(text: &str, issue: &GrammarIssue) -> String {
        let utf16: Vec<u16> = text.encode_utf16().collect();
        String::from_utf16_lossy(&utf16[issue.start as usize..(issue.start + issue.length) as usize])
    }

    fn lint(text: &str) -> Vec<GrammarIssue> {
        let dictionary = FstDictionary::curated();
        let issues = check(&mut new_linter(&dictionary), &dictionary, text);
        for i in &issues {
            println!("{:?} [{}] {}: {} → {:?}", marked(text, i), i.kind, i.rule, i.message, i.fixes);
        }
        issues
    }

    #[test]
    fn offsets_are_utf16_after_curly_quotes() {
        // Curly quotes and an emoji before the error: character and UTF-16 offsets differ.
        let text = "“Hello,” she said 😀. He took a apple.";
        let issues = lint(text);
        let an = issues.iter().find(|i| marked(text, i) == "a").expect("a/an should be flagged");
        assert!(an.fixes.iter().any(|f| f == "an"), "should suggest “an”");
    }

    #[test]
    fn no_spelling_or_style() {
        let issues = lint("Teh qwertyuiop was really very basic fundamentals.");
        assert!(issues.iter().all(|i| i.rule != "SpellCheck" && i.kind != "Spelling" && i.kind != "Style"));
    }

    #[test]
    fn sample_fiction() {
        // Not an assertion: shows what Harper says about ordinary first-person fiction.
        lint("I must have thought she was older than us because I remember seeing her around maybe playing with the older kids, but when you're 10 there are only really three ages; your age, old and babies.");
        lint("We were setting off on our bikes to explore the woods like we did most weekends and Anna came running out her house and asked to join us.");
    }
}
