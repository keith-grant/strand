//! Spell checking. On Windows this uses the system spell checker (the Windows Spell Checking API), driven from
//! one dedicated thread that owns the COM objects; Tauri commands talk to that thread over a channel.
//! Other platforms currently get a checker that finds nothing, so the app still builds and runs there.

use serde::Serialize;
use std::sync::mpsc::{channel, Receiver, Sender};

#[derive(Serialize)]
pub struct Issue {
    /// Offset and length in UTF-16 code units, which is also how JavaScript measures strings.
    pub start: u32,
    pub length: u32,
    /// "suggest": misspelt, ask for suggestions. "replace": a known slip with one fix (e.g. "teh").
    /// "delete": a repeated word.
    pub action: &'static str,
    pub replacement: Option<String>,
}

#[derive(Serialize)]
pub struct Checked {
    /// The language actually used, which differs from the one asked for if that isn't installed.
    pub language: String,
    pub issues: Vec<Vec<Issue>>,
}

type Reply<T> = Sender<Result<T, String>>;

enum Request {
    Check { language: String, texts: Vec<String>, reply: Reply<Checked> },
    Suggest { language: String, word: String, reply: Reply<Vec<String>> },
}

pub struct Speller(Sender<Request>);

impl Speller {
    pub fn start() -> Speller {
        let (tx, rx) = channel();
        std::thread::Builder::new().name("spelling".into()).spawn(move || imp::run(rx)).expect("couldn't start the spelling thread");
        Speller(tx)
    }

    async fn ask<T: Send + 'static>(&self, request: impl FnOnce(Reply<T>) -> Request) -> Result<T, String> {
        let (reply, answer) = channel();
        self.0.send(request(reply)).map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || answer.recv().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())??
    }

    pub async fn check(&self, language: String, texts: Vec<String>) -> Result<Checked, String> {
        self.ask(|reply| Request::Check { language, texts, reply }).await
    }

    pub async fn suggest(&self, language: String, word: String) -> Result<Vec<String>, String> {
        self.ask(|reply| Request::Suggest { language, word, reply }).await
    }
}

#[cfg(windows)]
mod imp {
    use super::{Checked, Issue, Receiver, Request};
    use std::collections::HashMap;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Globalization::*;
    use windows::Win32::System::Com::*;

    const FALLBACK: &str = "en-US";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Read a string Windows allocated for us, then free it.
    unsafe fn take(p: PWSTR) -> Option<String> {
        if p.is_null() {
            return None;
        }
        let s = unsafe { p.to_string() }.ok();
        unsafe { CoTaskMemFree(Some(p.0 as *const core::ffi::c_void)) };
        s
    }

    #[derive(Default)]
    struct Checkers {
        factory: Option<ISpellCheckerFactory>,
        by_language: HashMap<String, Option<ISpellChecker>>,
    }

    impl Checkers {
        fn create(&mut self, language: &str) -> windows::core::Result<Option<ISpellChecker>> {
            if self.factory.is_none() {
                self.factory = Some(unsafe { CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER) }?);
            }
            let factory = self.factory.as_ref().unwrap();
            let tag = wide(language);
            if !unsafe { factory.IsSupported(PCWSTR(tag.as_ptr())) }?.as_bool() {
                return Ok(None);
            }
            Ok(Some(unsafe { factory.CreateSpellChecker(PCWSTR(tag.as_ptr())) }?))
        }

        /// The checker for `language`, or for US English if that one isn't installed.
        fn get(&mut self, language: &str) -> Result<(String, ISpellChecker), String> {
            for tag in [language, FALLBACK] {
                if !self.by_language.contains_key(tag) {
                    let checker = self.create(tag).map_err(|e| e.to_string())?;
                    self.by_language.insert(tag.to_string(), checker);
                }
                if let Some(Some(checker)) = self.by_language.get(tag) {
                    return Ok((tag.to_string(), checker.clone()));
                }
            }
            Err(format!("Windows has no spell checker installed for {language}. Add the language under Settings › Time & language › Language."))
        }
    }

    fn check(checker: &ISpellChecker, text: &str) -> windows::core::Result<Vec<Issue>> {
        let mut issues = Vec::new();
        if text.trim().is_empty() {
            return Ok(issues);
        }
        let text = wide(text);
        let errors = unsafe { checker.Check(PCWSTR(text.as_ptr())) }?;
        loop {
            let mut error = None;
            unsafe { errors.Next(&mut error) }.ok()?; // S_FALSE, with no error, marks the end
            let Some(error) = error else { break };
            let action = unsafe { error.CorrectiveAction() }?;
            let action = if action == CORRECTIVE_ACTION_GET_SUGGESTIONS {
                "suggest"
            } else if action == CORRECTIVE_ACTION_REPLACE {
                "replace"
            } else if action == CORRECTIVE_ACTION_DELETE {
                "delete"
            } else {
                continue;
            };
            let replacement = if action == "replace" { unsafe { error.Replacement().ok().and_then(|p| take(p)) } } else { None };
            issues.push(Issue { start: unsafe { error.StartIndex() }?, length: unsafe { error.Length() }?, action, replacement });
        }
        Ok(issues)
    }

    fn suggest(checker: &ISpellChecker, word: &str) -> windows::core::Result<Vec<String>> {
        let word = wide(word);
        let list = unsafe { checker.Suggest(PCWSTR(word.as_ptr())) }?;
        let mut out = Vec::new();
        while out.len() < 8 {
            let mut item = [PWSTR::null()];
            let mut fetched = 0u32;
            unsafe { list.Next(&mut item, Some(&mut fetched)) }.ok()?;
            if fetched == 0 {
                break;
            }
            if let Some(s) = unsafe { take(item[0]) } {
                out.push(s);
            }
        }
        Ok(out)
    }

    pub fn run(requests: Receiver<Request>) {
        // Failure here (already initialised) is harmless; creating the factory reports any real problem.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let mut checkers = Checkers::default();
        for request in requests {
            match request {
                Request::Check { language, texts, reply } => {
                    let result = checkers.get(&language).and_then(|(language, checker)| {
                        let issues = texts.iter().map(|t| check(&checker, t)).collect::<windows::core::Result<Vec<_>>>().map_err(|e| e.to_string())?;
                        Ok(Checked { language, issues })
                    });
                    let _ = reply.send(result);
                }
                Request::Suggest { language, word, reply } => {
                    let result = checkers.get(&language).and_then(|(_, checker)| suggest(&checker, &word).map_err(|e| e.to_string()));
                    let _ = reply.send(result);
                }
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn marked(text: &str, issue: &Issue) -> String {
        let utf16: Vec<u16> = text.encode_utf16().collect();
        String::from_utf16_lossy(&utf16[issue.start as usize..(issue.start + issue.length) as usize])
    }

    #[test]
    fn finds_misspellings_with_utf16_offsets() {
        let speller = Speller::start();
        let texts = vec!["“Quoted” émigrés sat on teh mat.".to_string(), "All fine here.".to_string(), String::new()];
        let checked = tauri::async_runtime::block_on(speller.check("en-GB".into(), texts.clone())).unwrap();
        assert_eq!(checked.issues.len(), 3);
        let words: Vec<String> = checked.issues[0].iter().map(|i| marked(&texts[0], i)).collect();
        assert_eq!(words, vec!["teh"]);
        assert!(checked.issues[1].is_empty() && checked.issues[2].is_empty());
    }

    #[test]
    fn suggests_corrections() {
        let speller = Speller::start();
        let suggestions = tauri::async_runtime::block_on(speller.suggest("en-GB".into(), "recieve".into())).unwrap();
        assert!(suggestions.iter().any(|s| s == "receive"), "got {suggestions:?}");
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Checked, Receiver, Request};

    pub fn run(requests: Receiver<Request>) {
        for request in requests {
            match request {
                Request::Check { language, texts, reply } => {
                    let _ = reply.send(Ok(Checked { language, issues: texts.iter().map(|_| Vec::new()).collect() }));
                }
                Request::Suggest { reply, .. } => {
                    let _ = reply.send(Ok(Vec::new()));
                }
            }
        }
    }
}
