# Strand

A deliberately minimal desktop skeleton for hierarchical Markdown composition. Tauri 2, Rust, TypeScript (no UI framework), CodeMirror 6, Vite and SQLite via bundled rusqlite.

## Windows development

Install Node.js (22 LTS), Rust stable via rustup (MSVC target), Visual Studio 2022 Build Tools with Desktop development with C++, and WebView2 Runtime. From this directory:

    npm install
    npm run tauri dev

`npm run build` checks TypeScript and builds the frontend. `npm run tauri build` builds the desktop executable (installer bundling is disabled for this skeleton).

## Structure

- `src/model.ts`: narrative model, reference parsing, validation, composition, moving nodes and word counts.
- `src/scenes.ts`: the scene editor, plus the structural commands (new scene, split, merge, delete, move).
- `src/main.ts`: toolbar, book tree, status bar, file dialogs and debounced persistence.
- `src/style.css`: layout and scene styling.
- `src-tauri/src/main.rs`: SQLite persistence and Markdown export through Tauri commands.

## How the editor works

Opening a node expands its prose and all its descendants into one continuous CodeMirror document. Each child scene sits between a hidden opening and closing marker: private-use characters carrying the scene's id. A marker can sit anywhere, so scene boundaries can fall partway through a line. The cursor steps over a marker in one keypress, so either side of a boundary is a separate cursor position, and text typed there belongs to that side's scene.

A transaction filter stops ordinary typing, deleting, cutting, pasting and dropping from creating or removing markers. Only the explicit structural commands change the structure, and because those are ordinary document edits, undo covers them.

The markers exist only in the editor. Saving and export convert the document back into each node's own prose, with children as `{{node:UUID}}` references, so the project file and the Markdown never contain them.

## Current functionality

- New, open, save (Ctrl+S) and save as; projects are SQLite databases and autosave once saved.
- One editor for any node. Scenes are shown as tinted bands, with titles in the margin, and can be collapsed to a one-line summary.
- New scene from a selection, or an empty one at the cursor (Ctrl+Shift+E).
- Split at the cursor (Ctrl+Shift+Enter).
- Merge with previous, next or parent; merge the scenes a selection runs across (Ctrl+Shift+M). Merging needs scenes in the same parent with only blank space between them.
- Rename, delete, open a scene on its own.
- Undo and redo of typing and structural changes.
- Book tree with word counts and a marker for nodes without prose. Drag a node onto the top or bottom edge of another to place it before or after it, or onto the middle to put it inside, at the end.
- Status bar shows the total word count and the current scene's own and aggregate word counts.
- Markdown export.
- Spell checking through Windows' own spell checker (`src-tauri/src/spelling.rs`, `src/spelling.ts`), in British English, falling back to US English if that isn't installed. Each paragraph is checked once in its current form; what's on screen is checked straight away and the rest as it scrolls into view. The word being typed isn't underlined until the cursor leaves it.
- Right-click menu in the text (`src/menu.ts`): spelling suggestions, Add to dictionary (stored in the project file, so it applies to this book only), Ignore (until Strand closes), Cut/Copy/Paste and the scene commands.

The project file records its format version in SQLite's `user_version`: 0 for files from before it was recorded, 1 since the dictionary table was added. Older files open as normal and are upgraded on their next save; Strand refuses files from a newer version.

## Intentional limitations / development boundaries

Undo history resets when another node is opened, or when a tree move involves a node outside the open text; renames are not undoable. Spelling works on Windows only for now (other platforms get no underlines), the language isn't yet a per-book setting, and there is no way yet to review or remove dictionary words. Grammar checking isn't implemented. Moving a node inside another always puts it at the end; placing it at a chosen point within the text isn't implemented. Markdown is edited as source rather than rendered. Revision history, timeline and search are not implemented. Reference syntax is reserved (`{{node:UUID}}`); do not type it manually in this prototype. The save-on-close behavior is basic (browser unload warning); production should use Tauri close interception and await persistence. File operations are intended for a trusted local single-user tool; restrict paths and validate the model on the backend before distributing. Save As replaces the contents of an existing Strand database if selected. No installer or application icons are supplied.
