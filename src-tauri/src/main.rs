#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod spelling;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Version of the project file format, stored in SQLite's `user_version`. 0 = files from before it was recorded.
/// 1 = adds the `dictionary` table (words the author added to the book's spelling dictionary).
const FORMAT_VERSION: i64 = 1;

#[derive(Serialize, Deserialize)]
struct Node { id: String, title: String, prose: String }
#[derive(Serialize, Deserialize)]
struct Project {
    root: String,
    nodes: Vec<Node>,
    #[serde(default)]
    words: Vec<String>,
}
type CmdResult<T> = Result<T, String>;
fn err(e: impl std::fmt::Display) -> String { e.to_string() }

#[tauri::command]
fn save_project(path: String, project: Project) -> CmdResult<()> {
    let mut db = Connection::open(&path).map_err(err)?;
    let tx = db.transaction().map_err(err)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS project (singleton INTEGER PRIMARY KEY CHECK(singleton=1), root TEXT NOT NULL); CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, title TEXT NOT NULL, prose TEXT NOT NULL); CREATE TABLE IF NOT EXISTS dictionary (word TEXT PRIMARY KEY); DELETE FROM nodes; DELETE FROM dictionary;").map_err(err)?;
    tx.execute("INSERT OR REPLACE INTO project VALUES (1, ?1)", [&project.root]).map_err(err)?;
    for n in project.nodes { tx.execute("INSERT INTO nodes VALUES (?1, ?2, ?3)", params![n.id,n.title,n.prose]).map_err(err)?; }
    for w in project.words { tx.execute("INSERT OR IGNORE INTO dictionary VALUES (?1)", [w]).map_err(err)?; }
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
    // Older files have no dictionary table; they get one on their next save.
    let has_dictionary: bool = db.query_row("SELECT count(*) > 0 FROM sqlite_master WHERE type='table' AND name='dictionary'", [], |r| r.get(0)).map_err(err)?;
    let words = if has_dictionary {
        let mut stmt = db.prepare("SELECT word FROM dictionary ORDER BY word").map_err(err)?;
        let words = stmt.query_map([], |r| r.get(0)).map_err(err)?.collect::<Result<Vec<String>,_>>().map_err(err)?;
        words
    } else { Vec::new() };
    Ok(Project { root, nodes, words })
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(spelling::Speller::start())
        .invoke_handler(tauri::generate_handler![save_project, load_project, export_markdown, spell_check, spell_suggest])
        .run(tauri::generate_context!()).expect("error running Strand");
}
