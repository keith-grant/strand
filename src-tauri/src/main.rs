#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod grammar;
mod project_file;
mod spelling;

use project_file::Project;
use std::path::Path;

type CmdResult<T> = Result<T, String>;

#[tauri::command]
fn save_project(path: String, project: Project) -> CmdResult<()> {
    project_file::save(Path::new(&path), &project)
}
#[tauri::command]
fn load_project(path: String) -> CmdResult<Project> {
    project_file::load(Path::new(&path))
}
#[tauri::command]
fn export_markdown(path: String, prose: String) -> CmdResult<()> {
    std::fs::write(path, prose).map_err(|e| e.to_string())
}

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
        .run(tauri::generate_context!())
        .expect("error running Strand");
}
