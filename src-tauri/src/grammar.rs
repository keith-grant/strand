//! Grammar checking with Harper (offline, English only), on its own thread. The linter keeps internal caches, so
//! one long-lived instance serves every request.

use harper_core::linting::{LintGroup, LintKind, Suggestion};
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};
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

    // Every remaining finding is kept, overlapping or not. (Harper's remove_overlaps would let one finding hide
    // others under it, e.g. a "this sentence is long" note hiding a typo inside the sentence, even though that note
    // is then discarded as style.)
    let mut out = Vec::new();
    for (rule, lints) in linter.organized_lints(&document) {
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
    fn problems_inside_a_long_sentence_are_kept() {
        // Harper also notes that this sentence is long (a style note, which Strand discards). That note must not
        // hide the problems inside the sentence.
        let text = "I watched out of the window for the rest of the day,But she was my friend and so, with all the \
                    confidence of youth teh (I was a whole eleven years old after all), I sneaked out of the back door \
                    and made my way through the gardens to her house.";
        let issues = lint(text);
        assert!(issues.iter().any(|i| marked(text, i) == "teh"), "“teh” should be flagged");
        assert!(issues.iter().any(|i| i.rule == "CommaFixes"), "the missing space after the comma should be flagged");
        assert!(issues.iter().all(|i| i.kind != "Readability"));
    }

    #[test]
    fn no_spelling_or_style() {
        let issues = lint("Teh qwertyuiop was really very basic fundamentals.");
        assert!(issues.iter().all(|i| i.rule != "SpellCheck" && i.kind != "Spelling" && i.kind != "Style"));
    }

    /// The book's text as the editor shows it with the root open, without scene markers (what grammar receives).
    fn compose(project: &crate::project_file::Project, id: &str) -> String {
        let prose = &project.nodes.iter().find(|n| n.id == id).expect("node").prose;
        let (mut out, mut rest) = (String::new(), prose.as_str());
        while let Some(start) = rest.find("{{node:") {
            out.push_str(&rest[..start]);
            let end = rest[start..].find("}}").expect("closing braces") + start;
            out.push_str(&compose(project, &rest[start + 7..end]));
            rest = &rest[end + 2..];
        }
        out + rest
    }

    #[test]
    #[ignore] // diagnostic: STRAND_FILE=path cargo test real_book -- --ignored --nocapture
    fn real_book() {
        let path = std::env::var("STRAND_FILE").expect("set STRAND_FILE");
        let project = crate::project_file::load(std::path::Path::new(&path)).unwrap();
        let text = compose(&project, &project.root);
        let dictionary = FstDictionary::curated();
        let mut linter = new_linter(&dictionary);
        for (n, line) in text.split('\n').enumerate().filter(|(_, l)| l.contains("teh")) {
            println!("=== paragraph {n} ({} chars)\n{line}", line.chars().count());
            for i in check(&mut linter, &dictionary, line) {
                println!("    {:?} at {} [{}] {}: {} → {:?}", marked(line, &i), i.start, i.kind, i.rule, i.message, i.fixes);
            }
            println!("  raw, before any filtering:");
            let document = Document::new_markdown_default(line, &dictionary);
            for (rule, lints) in linter.organized_lints(&document) {
                for l in lints {
                    println!("    {rule} [{}] chars {}..{} priority {}: {}", l.lint_kind, l.span.start, l.span.end, l.priority, l.message);
                }
            }
        }
    }

    #[test]
    #[ignore] // diagnostic: STRAND_FILE=path cargo test overlaps_in_book -- --ignored --nocapture
    fn overlaps_in_book() {
        let path = std::env::var("STRAND_FILE").expect("set STRAND_FILE");
        let project = crate::project_file::load(std::path::Path::new(&path)).unwrap();
        let text = compose(&project, &project.root);
        let dictionary = FstDictionary::curated();
        let mut linter = new_linter(&dictionary);
        let (mut paragraphs, mut findings, mut overlapping) = (0, 0, 0);
        for line in text.split('\n').filter(|l| !l.trim().is_empty()) {
            paragraphs += 1;
            let issues = check(&mut linter, &dictionary, line);
            findings += issues.len();
            for (a, x) in issues.iter().enumerate() {
                for y in &issues[a + 1..] {
                    if x.start < y.start + y.length && y.start < x.start + x.length {
                        overlapping += 1;
                        println!("overlap: {:?} ({}) and {:?} ({})", marked(line, x), x.rule, marked(line, y), y.rule);
                    }
                }
            }
        }
        println!("{paragraphs} paragraphs, {findings} findings shown, {overlapping} overlapping pairs");
    }

    #[test]
    #[ignore] // timing only: cargo test timing -- --ignored --nocapture
    fn timing() {
        let start = std::time::Instant::now();
        let dictionary = FstDictionary::curated();
        let mut linter = new_linter(&dictionary);
        println!("linter ready: {:?}", start.elapsed());
        let paragraph = "We were setting off on our bikes to explore the woods like we did most weekends and Anna came running out her house and asked to join us. As I said, we'd seen her around so we said sure and off we went. She have a apple.";
        let start = std::time::Instant::now();
        for i in 0..40 {
            check(&mut linter, &dictionary, &format!("{paragraph} {i}"));
        }
        println!("40 paragraphs: {:?}", start.elapsed());
        for text in [
            "She have two dogs.", "He took a apple.", "Their going to the shop.", "I could of done it.",
            "Its a nice day.", "He don't know.", "She walked to to the shop.", "i went home.", "We was late.",
            "But she was my friend and so, with the confidence of youth teh (I was a whole 11 years old after all)",
            "with the confidence of youth teh.", "youth teh and", "teh (",
            "Teh cat sat on the mat.", "The cat sat on teh mat.", "I saw teh dog.", "teh", "Teh", "We went to teh shop and bought teh milk.",
            "Me and him went out.", "Your welcome.", "He should have went.", "Who's coat is this?", "It was a historical moment",
            "A girl lives in the house at the end of our street.",
            "No one else ever seems to come in or out, and no-one seems to talk about it.",
            "I must have thought she was older than us because I remember seeing her around maybe playing with the older kids, but when you're 10 there are only really three ages; your age, old and babies.",
            "But she was my friend and so with the confidence of youth (I was a whole 11 years old after all), I sneaked out the back and made my way through the neighbours' gardens to her house. I peered through the kitchen window and there she was sitting at her Kitchen table talking to some police officers. I remember thinking it was odd that there were only 2, given how many cars were outside. The police officers seemed agitated and kept pointing at a half open door in the corner and asking her questions. She had that look of exasperation  she always got when explaining something she thought was obvious and I could just hear her insisting that they shouldn't go downstairs.",
            "The next day all the cars were gone, and no-one ever spoke about it again.",
            "“Hello,” she said — and then… nothing. ‘Quiet,’ he whispered; “don’t.”",
            "# Chapter One", "*Emphasis* and **bold** and `code`.", "", "   ", "—", "…", "\"", "''", "1.", "- list item", "> quote",
            "Ünïcödé 😀 text with émigrés and naïve café façades.",
        ] {
            println!("--- {text}");
            for i in check(&mut linter, &dictionary, text) {
                println!("    [{}] {}: {} → {:?}", i.kind, i.rule, i.message, i.fixes);
            }
        }
    }

    #[test]
    fn sample_fiction() {
        // Not an assertion: shows what Harper says about ordinary first-person fiction.
        lint("I must have thought she was older than us because I remember seeing her around maybe playing with the older kids, but when you're 10 there are only really three ages; your age, old and babies.");
        lint("We were setting off on our bikes to explore the woods like we did most weekends and Anna came running out her house and asked to join us.");
    }
}
