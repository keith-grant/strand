#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod grammar;
mod spelling;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Version of the project file format, stored in SQLite's `user_version`. 0 = files from before it was recorded.
/// 1 = adds the `dictionary` table (words the author added to the book's spelling dictionary).
/// 2 = adds the `settings` table (per-book settings, one JSON value per key).
const FORMAT_VERSION: i64 = 2;

#[derive(Serialize, Deserialize)]
struct Node { id: String, title: String, prose: String }

/// Per-book settings. Missing keys (older files, or settings added later) take their defaults.
#[derive(Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    /// Grammar checking on for this book.
    grammar: bool,
    /// Harper rules the author turned off for this book.
    grammar_off_rules: Vec<String>,
}
impl Default for Settings {
    fn default() -> Self { Settings { grammar: true, grammar_off_rules: Vec::new() } }
}

#[derive(Serialize, Deserialize)]
struct Project {
    root: String,
    nodes: Vec<Node>,
    #[serde(default)]
    words: Vec<String>,
    #[serde(default)]
    settings: Settings,
}
type CmdResult<T> = Result<T, String>;
fn err(e: impl std::fmt::Display) -> String { e.to_string() }

#[tauri::command]
fn save_project(path: String, project: Project) -> CmdResult<()> {
    let mut db = Connection::open(&path).map_err(err)?;
    let tx = db.transaction().map_err(err)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS project (singleton INTEGER PRIMARY KEY CHECK(singleton=1), root TEXT NOT NULL); CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, title TEXT NOT NULL, prose TEXT NOT NULL); CREATE TABLE IF NOT EXISTS dictionary (word TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); DELETE FROM nodes; DELETE FROM dictionary; DELETE FROM settings;").map_err(err)?;
    tx.execute("INSERT OR REPLACE INTO project VALUES (1, ?1)", [&project.root]).map_err(err)?;
    for n in project.nodes { tx.execute("INSERT INTO nodes VALUES (?1, ?2, ?3)", params![n.id,n.title,n.prose]).map_err(err)?; }
    for w in project.words { tx.execute("INSERT OR IGNORE INTO dictionary VALUES (?1)", [w]).map_err(err)?; }
    if let serde_json::Value::Object(settings) = serde_json::to_value(&project.settings).map_err(err)? {
        for (key, value) in settings { tx.execute("INSERT INTO settings VALUES (?1, ?2)", params![key, value.to_string()]).map_err(err)?; }
    }
    tx.pragma_update(None, "user_version", FORMAT_VERSION).map_err(err)?;
    tx.commit().map_err(err)
}
#[tauri::command]
fn load_project(path: String) -> CmdResult<Project> {
    let db = Connection::open_with_flags(Path::new(&path), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(err)?;
    if version > FORMAT_VERSION { return Err("This project was saved by a newer version of Strand.".into()); }
    let root = db.query_row("SELECT root FROM project WHERE singleton=1", [], |r| r.get(0)).map_err(err)?;
    let mut stmt = db.prepare("SELECT id,title,prose FROM nodes").map_err(err)?;
    let nodes = stmt.query_map([], |r| Ok(Node {id:r.get(0)?,title:r.get(1)?,prose:r.get(2)?})).map_err(err)?.collect::<Result<Vec<_>,_>>().map_err(err)?;
    // Older files lack the dictionary and settings tables; they get them on their next save.
    let has_table = |name: &str| db.query_row("SELECT count(*) > 0 FROM sqlite_master WHERE type='table' AND name=?1", [name], |r| r.get::<_, bool>(0)).map_err(err);
    let words = if has_table("dictionary")? {
        let mut stmt = db.prepare("SELECT word FROM dictionary ORDER BY word").map_err(err)?;
        let words = stmt.query_map([], |r| r.get(0)).map_err(err)?.collect::<Result<Vec<String>,_>>().map_err(err)?;
        words
    } else { Vec::new() };
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
#[tauri::command]
fn export_markdown(path: String, prose: String) -> CmdResult<()> { std::fs::write(path, prose).map_err(err) }

#[tauri::command]
async fn spell_check(speller: tauri::State<'_, spelling::Speller>, language: String, texts: Vec<String>) -> CmdResult<spelling::Checked> {
    speller.check(language, texts).await
}
#[tauri::command]
async fn spell_suggest(speller: tauri::State<'_, spelling::Speller>, language: String, word: String) -> CmdResult<Vec<String>> {
    speller.suggest(language, word).await
}
#[tauri::command]
async fn grammar_check(grammar: tauri::State<'_, grammar::Grammar>, texts: Vec<String>) -> CmdResult<Vec<Vec<grammar::GrammarIssue>>> {
    grammar.check(texts).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(spelling::Speller::start())
        .manage(grammar::Grammar::start())
        .invoke_handler(tauri::generate_handler![save_project, load_project, export_markdown, spell_check, spell_suggest, grammar_check])
        .run(tauri::generate_context!()).expect("error running Strand");
}
