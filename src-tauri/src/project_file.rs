//! The project file: a SQLite database holding the nodes, the book's spelling dictionary and its settings.
//!
//! The format version is kept in SQLite's `user_version`:
//! 0 = files from before it was recorded (project and nodes tables only);
//! 1 = adds the `dictionary` table (words the author added to the book's spelling dictionary);
//! 2 = adds the `settings` table (per-book settings, one JSON value per key).
//! Older files load with defaults for what they lack, and are upgraded on their next save.

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FORMAT_VERSION: i64 = 2;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Node {
    pub id: String,
    pub title: String,
    pub prose: String,
}

/// Per-book settings. Missing keys (older files, or settings added later) take their defaults.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Grammar checking on for this book.
    pub grammar: bool,
    /// Harper rules the author turned off for this book.
    pub grammar_off_rules: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { grammar: true, grammar_off_rules: Vec::new() }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Project {
    pub root: String,
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub words: Vec<String>,
    #[serde(default)]
    pub settings: Settings,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Write the whole project, replacing whatever the file held, in one transaction.
pub fn save(path: &Path, project: &Project) -> Result<(), String> {
    let mut db = Connection::open(path).map_err(err)?;
    let tx = db.transaction().map_err(err)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS project (singleton INTEGER PRIMARY KEY CHECK(singleton=1), root TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, title TEXT NOT NULL, prose TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS dictionary (word TEXT PRIMARY KEY);
         CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         DELETE FROM nodes; DELETE FROM dictionary; DELETE FROM settings;",
    )
    .map_err(err)?;
    tx.execute("INSERT OR REPLACE INTO project VALUES (1, ?1)", [&project.root]).map_err(err)?;
    for n in &project.nodes {
        tx.execute("INSERT INTO nodes VALUES (?1, ?2, ?3)", params![n.id, n.title, n.prose]).map_err(err)?;
    }
    for w in &project.words {
        tx.execute("INSERT OR IGNORE INTO dictionary VALUES (?1)", [w]).map_err(err)?;
    }
    if let serde_json::Value::Object(settings) = serde_json::to_value(&project.settings).map_err(err)? {
        for (key, value) in settings {
            tx.execute("INSERT INTO settings VALUES (?1, ?2)", params![key, value.to_string()]).map_err(err)?;
        }
    }
    tx.pragma_update(None, "user_version", FORMAT_VERSION).map_err(err)?;
    tx.commit().map_err(err)
}

pub fn load(path: &Path) -> Result<Project, String> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(err)?;
    if version > FORMAT_VERSION {
        return Err("This project was saved by a newer version of Strand.".into());
    }
    let root = db.query_row("SELECT root FROM project WHERE singleton=1", [], |r| r.get(0)).map_err(err)?;
    let mut stmt = db.prepare("SELECT id, title, prose FROM nodes").map_err(err)?;
    let nodes = stmt
        .query_map([], |r| Ok(Node { id: r.get(0)?, title: r.get(1)?, prose: r.get(2)? }))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let has_table = |name: &str| {
        db.query_row("SELECT count(*) > 0 FROM sqlite_master WHERE type='table' AND name=?1", [name], |r| r.get::<_, bool>(0)).map_err(err)
    };
    let words = if has_table("dictionary")? {
        let mut stmt = db.prepare("SELECT word FROM dictionary ORDER BY word").map_err(err)?;
        let words = stmt.query_map([], |r| r.get(0)).map_err(err)?.collect::<Result<Vec<String>, _>>().map_err(err)?;
        words
    } else {
        Vec::new()
    };
    let mut settings = serde_json::Map::new();
    if has_table("settings")? {
        let mut stmt = db.prepare("SELECT key, value FROM settings").map_err(err)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(err)?;
        for row in rows {
            let (key, value) = row.map_err(err)?;
            settings.insert(key, serde_json::from_str(&value).map_err(err)?);
        }
    }
    let settings = serde_json::from_value(serde_json::Value::Object(settings)).map_err(err)?;
    Ok(Project { root, nodes, words, settings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A temporary file path that's removed when dropped.
    struct TempFile(PathBuf);
    impl TempFile {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("strand-test-{}-{name}.strand", std::process::id()));
            let _ = std::fs::remove_file(&path);
            TempFile(path)
        }
    }
    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn sample() -> Project {
        Project {
            root: "root".into(),
            nodes: vec![
                Node { id: "root".into(), title: "Manuscript".into(), prose: "Before {{node:child}} after.".into() },
                Node { id: "child".into(), title: "The Letter".into(), prose: "She read the note. “Quoted”, émigré.".into() },
            ],
            words: vec!["Anna".into(), "Strand".into()],
            settings: Settings { grammar: false, grammar_off_rules: vec!["SentenceCapitalization".into()] },
        }
    }

    fn sorted(mut p: Project) -> Project {
        p.nodes.sort_by(|a, b| a.id.cmp(&b.id));
        p
    }

    #[test]
    fn round_trip_keeps_everything() {
        let file = TempFile::new("round-trip");
        save(&file.0, &sample()).unwrap();
        assert_eq!(sorted(load(&file.0).unwrap()), sorted(sample()));
    }

    #[test]
    fn saving_again_replaces_the_previous_contents() {
        let file = TempFile::new("replace");
        save(&file.0, &sample()).unwrap();
        let mut smaller = sample();
        smaller.nodes.truncate(1);
        smaller.nodes[0].prose = "Only text.".into();
        smaller.words = vec![];
        smaller.settings = Settings::default();
        save(&file.0, &smaller).unwrap();
        assert_eq!(load(&file.0).unwrap(), smaller);
    }

    #[test]
    fn records_the_format_version() {
        let file = TempFile::new("version");
        save(&file.0, &sample()).unwrap();
        let db = Connection::open(&file.0).unwrap();
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, FORMAT_VERSION);
    }

    #[test]
    fn old_files_load_with_defaults() {
        // A version-0 file: just the project and nodes tables.
        let file = TempFile::new("old");
        let db = Connection::open(&file.0).unwrap();
        db.execute_batch(
            "CREATE TABLE project (singleton INTEGER PRIMARY KEY CHECK(singleton=1), root TEXT NOT NULL);
             CREATE TABLE nodes (id TEXT PRIMARY KEY, title TEXT NOT NULL, prose TEXT NOT NULL);
             INSERT INTO project VALUES (1, 'root');
             INSERT INTO nodes VALUES ('root', 'Manuscript', 'Text.');",
        )
        .unwrap();
        drop(db);
        let project = load(&file.0).unwrap();
        assert!(project.words.is_empty());
        assert_eq!(project.settings, Settings::default());
        assert_eq!(project.nodes[0].prose, "Text.");
    }

    #[test]
    fn unknown_settings_and_missing_keys_are_tolerated() {
        let file = TempFile::new("settings");
        save(&file.0, &sample()).unwrap();
        let db = Connection::open(&file.0).unwrap();
        db.execute_batch("DELETE FROM settings WHERE key = 'grammarOffRules'; INSERT INTO settings VALUES ('fromTheFuture', '42');").unwrap();
        drop(db);
        let project = load(&file.0).unwrap();
        assert!(!project.settings.grammar);
        assert!(project.settings.grammar_off_rules.is_empty());
    }

    #[test]
    fn newer_files_are_refused() {
        let file = TempFile::new("newer");
        save(&file.0, &sample()).unwrap();
        Connection::open(&file.0).unwrap().pragma_update(None, "user_version", FORMAT_VERSION + 1).unwrap();
        assert!(load(&file.0).unwrap_err().contains("newer version"));
    }

    #[test]
    fn duplicate_dictionary_words_are_stored_once() {
        let file = TempFile::new("words");
        let mut p = sample();
        p.words.push("Anna".into());
        save(&file.0, &p).unwrap();
        assert_eq!(load(&file.0).unwrap().words, vec!["Anna".to_string(), "Strand".to_string()]);
    }
}
