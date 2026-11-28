# Strand

A desktop writing tool for fiction, built around scenes that nest inside each other. Tauri 2 (Rust), TypeScript, CodeMirror 6, SQLite.

## Setup (Windows)

Needs: Node.js 22.12+, pnpm, Rust (MSVC), Visual Studio 2022 Build Tools (C++ workload), WebView2 Runtime, Microsoft Edge (for acceptance tests).

    pnpm install
    pnpm tauri dev

The first build takes a few minutes (Harper, the grammar checker, is compiled optimised).

pnpm only lets packages run install scripts if `pnpm-workspace.yaml` allows them. esbuild's is deliberately not allowed; Strand works without it.

## Running and building

| Command | Does |
|---|---|
| `pnpm tauri dev` | Run the app |
| `pnpm tauri build` | Build the desktop executable |
| `pnpm build` | Type-check and build the frontend only |

## Tests

| Tests | What they check | Command |
|---|---|---|
| Unit | The TypeScript logic: model, editor markers and structural commands, edit guard, saving and autosave. Fast; no browser. | `pnpm test:unit` |
| Acceptance | The scenarios in `features/`, run through the real UI in headless Edge, with the Rust side faked. | `pnpm test:acceptance` |
| Rust | Project file saving and loading, Windows spell checker, Harper grammar. | `pnpm test:rust` |
| All | All three, in that order. | `pnpm test` |

Coverage report for the unit tests: `pnpm test:unit --coverage`.

## Code layout

| Where | What |
|---|---|
| `src/app.ts` | Builds the screen and connects everything |
| `src/session.ts` | The open book: syncing with the editor, autosave, dictionary, settings |
| `src/model.ts` | The stored model: nodes, references, word counts, moving nodes |
| `src/backend.ts` | All calls to the Rust side, file dialogs and clipboard |
| `src/editor/` | The scene editor: markers, scene state, edit guard, structural commands, drawing |
| `src/checking/` | Spelling and grammar |
| `src/ui/` | Tree, status bar, menus, rename box |
| `src-tauri/src/` | Commands, project file, Windows spell checker, Harper grammar |
| `features/` | Gherkin scenarios |
| `tests/acceptance/` | Step definitions for the scenarios |

## How the editor works

- Opening a node shows it and all its descendants as one continuous text.
- Each scene sits between two hidden markers. Markers can fall mid-line, and the cursor steps over each one in a single keypress.
- Ordinary edits can't add or remove markers. Only the structural commands can, so undo covers them.
- Markers exist only in the editor. The project file stores `{{node:id}}` references instead.

## Features

- One editor for any node; scenes shown as coloured bands with titles in the margin; collapsible.
- New scene (Ctrl+Shift+E), split (Ctrl+Shift+Enter), merge with previous / next / parent, merge a selection (Ctrl+Shift+M), rename, delete.
- Undo and redo, including structural changes.
- Book tree with word counts; drag to reorder or reparent.
- Spelling (Windows' spell checker, British English) and grammar (Harper, offline). Dialogue is never grammar-checked; grammar can be switched off per book.
- Right-click menu: suggestions, add to dictionary, ignore, cut/copy/paste, scene commands.
- Autosave once saved; Markdown export.

## Project file

A SQLite database (`.strand`) holding nodes, the book's dictionary and settings. Its format version is in SQLite's `user_version` (currently 2). Older files open fine and upgrade on save; newer ones are refused.

## Testing notes

- Unit tests sit next to the code they test (`*.test.ts`).
- Acceptance scenarios tagged `@todo` are skipped. After a failure, see `playwright-report/`.
- Test-mode code (`src/testing/`) isn't included in real builds.
- Rust diagnostics, not run by default: `timing`, `real_book`, `overlaps_in_book`. The last two need `STRAND_FILE` set to a `.strand` file.

## Known limitations

- Undo resets when you open another node, or move a node outside the open text. Renames can't be undone.
- Spelling is Windows only; there's no way to review or remove dictionary words yet.
- Grammar is English only; Ignore lasts until Strand closes.
- An apostrophe starting a word (`'cause`) can be mistaken for the start of dialogue.
- Moving a node inside another always puts it at the end.
- Not built yet: versions, chronology and timeline, search, reference material, metadata.
- Closing the window may lose the last second of typing; never-saved projects aren't autosaved.
- Don't type `{{node:...}}` by hand.
