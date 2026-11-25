# Strand

A deliberately minimal desktop skeleton for hierarchical Markdown composition. Tauri 2, Rust, TypeScript (no UI framework), Vite and SQLite via bundled rusqlite.

## Windows development

Install Node.js (22 LTS), Rust stable via rustup (MSVC target), Visual Studio 2022 Build Tools with Desktop development with C++, and WebView2 Runtime. From this directory:

    npm install
    npm run tauri dev

`npm run build` checks TypeScript and builds the frontend. `npm run tauri build` builds the desktop executable (installer bundling is disabled for this skeleton).

## Structure

- `src/model.ts`: narrative model, reference parsing, validation, composition and moving nodes.
- `src/main.ts`: UI, basic segmented editor, file dialogs and debounced persistence.
- `src/style.css`: two-pane layout.
- `src-tauri/src/main.rs`: SQLite persistence and Markdown export through Tauri commands.

## Current functionality

New/open/save/save as projects, SQLite transactions, rename, extract selected text into child nodes or insert empty children, nested expansion, inline editing, independent node editing, move to end of another node, delete subtree, word counts and Markdown export. Save once to enable autosaving. All references use stable UUIDs; the tree is derived from prose rather than separately persisted. Project files are SQLite databases.

## Intentional limitations / development boundaries

The editor is a set of textareas for contiguous prose segments, not a unified rich-text editing surface. Native undo is local to each textarea and lost when the editor rebuilds. Cross-node selections, structural undo, arbitrary-position drag/drop, raw interpolation typing, revision history and timeline features are not implemented. Reference syntax is reserved (`{{node:UUID}}`); do not type it manually in this prototype. Node moves append to the destination. Markdown is edited as source rather than rendered. The save-on-close behavior is basic (browser unload warning); production should use Tauri close interception and await persistence. File operations are intended for a trusted local single-user tool; restrict paths and validate the model on the backend before distributing. Save As replaces the contents of an existing Strand database if selected. No installer or application icons are supplied.

The environment used to create this skeleton did not have the Rust toolchain or installed npm dependencies, so a native build has not been verified.
