#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
struct Node { id: String, title: String, prose: String }
#[derive(Serialize, Deserialize)]
struct Project { root: String, nodes: Vec<Node> }
type CmdResult<T> = Result<T, String>;
fn err(e: impl std::fmt::Display) -> String { e.to_string() }

#[tauri::command]
fn save_project(path: String, project: Project) -> CmdResult<()> {
    let mut db = Connection::open(&path).map_err(err)?;
    let tx = db.transaction().map_err(err)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS project (singleton INTEGER PRIMARY KEY CHECK(singleton=1), root TEXT NOT NULL); CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, title TEXT NOT NULL, prose TEXT NOT NULL); DELETE FROM nodes;").map_err(err)?;
    tx.execute("INSERT OR REPLACE INTO project VALUES (1, ?1)", [&project.root]).map_err(err)?;
    for n in project.nodes { tx.execute("INSERT INTO nodes VALUES (?1, ?2, ?3)", params![n.id,n.title,n.prose]).map_err(err)?; }
    tx.commit().map_err(err)
}
#[tauri::command]
fn load_project(path: String) -> CmdResult<Project> {
    let db = Connection::open_with_flags(Path::new(&path), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
    let root = db.query_row("SELECT root FROM project WHERE singleton=1", [], |r| r.get(0)).map_err(err)?;
    let mut stmt = db.prepare("SELECT id,title,prose FROM nodes").map_err(err)?;
    let nodes = stmt.query_map([], |r| Ok(Node {id:r.get(0)?,title:r.get(1)?,prose:r.get(2)?})).map_err(err)?.collect::<Result<Vec<_>,_>>().map_err(err)?;
    Ok(Project { root, nodes })
}
#[tauri::command]
fn export_markdown(path: String, prose: String) -> CmdResult<()> { std::fs::write(path, prose).map_err(err) }
fn main() {
    tauri::Builder::default().plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_project, load_project, export_markdown])
        .run(tauri::generate_context!()).expect("error running Strand");
}
