# Strand — Gherkin acceptance scenarios (refined)

30 behavioural scenarios in six feature files. These are **specifications**, not runnable tests: no step definitions, browser runner, Tauri mocks, or backend changes are included.

## Scope

| File | Scenarios | Focus |
| --- | ---: | --- |
| `01-recursive-composition.feature` | 4 | Continuous editing, nested and empty scenes |
| `02-scene-creation.feature` | 4 | Extracting, inserting, contextual actions |
| `03-editing-ownership.feature` | 6 | Caret sides, boundaries, cross-scene deletion, paste |
| `04-collapse-and-navigation.feature` | 5 | Collapse, expand, navigation, usable caret |
| `05-restructure-and-undo.feature` | 7 | Split, merge, move, rejected moves, undo/redo |
| `06-project-and-export.feature` | 4 | Save, autosave, reload, export, word count |

## Reusable step vocabulary

Prefer these *exact phrases* when adding scenarios. Repeated steps are intended to have a single shared implementation; quoted values are parameters. Gherkin's `And` inherits the previous keyword; a step's wording is reusable between `Given`, `When`, and `Then` where the tool allows it.

### Fixture and setup steps

- `a project with a root manuscript named "{name}"`
- `a saved project with a root manuscript named "{name}"`
- `"{parent}" contains a child scene "{child}"`
- `"{node}" contains the prose "{text}"`
- `"{node}" contains the prose:` followed by a doc string
- `"{node}" contains the following content in order:` followed by the standard `kind | title | text` table
- `"{node}" is collapsed`

The **content-in-order table** uses `prose` rows for text and `scene` rows for child references. Prose cells contain **JSON-quoted strings**, including spaces that must be preserved (`"Before "`, `" after."`). A `scene` row identifies a new, initially empty child by title. Fixture steps that add prose to a node containing children append it after existing content unless using the ordered table. A given node title uniquely identifies a node within a scenario.

### User actions

- `I open "{node}" in the editor`
- `I select the text "{text}"`
- `I select all prose in the editor`
- `I select from the text "{start}" to the text "{end}"`
- `I clear the selection`
- `I place the caret at the start of "{node}" on the {parent|child} side`
- `I place the caret at the end of "{node}" on the {parent|child} side`
- `I place the caret between "{preceding}" and "{following}"`
- `I type "{text}"`
- `I press "{key}"`
- `I create a child scene named "{name}" from the selection`
- `I insert an empty child scene named "{name}" at the caret`
- `I split "{node}" at the caret`
- `I merge "{source}" into "{destination}"`
- `I merge "{node}" into its parent`
- `I {collapse|expand} "{node}"`
- `I move "{node}" into "{destination}" using the manuscript tree`
- `I attempt to move "{node}" into "{destination}" using the manuscript tree`
- `I open the editor context menu`
- `I {undo|redo}`
- `I {save|close} the project`, `I reopen the saved project`, `autosave completes`
- `I export the manuscript as Markdown`, `I view the word counts`
- `I paste text containing reserved editor boundary characters`

### Assertions

- `"{child}" should be a child of "{parent}"` / `"{parent}" should not contain a child scene "{child}"`
- `"{node}" should own the prose "{text}"` / `"{node}" should own no prose`
- `"{node}" should contain exactly {n} child scenes`
- `the project should contain exactly {n} narrative nodes`
- `the project should not contain a scene named "{name}"`
- `the editor should {show|not show} the prose "{text}"`
- `"{node}" should have a visible scene boundary` / `a visible collapsed placeholder`
- `the assembled manuscript prose should be unchanged`
- `the project structure should remain valid`
- `the project structure and prose should be unchanged`
- `"{node}" should report {n} {owned|aggregate} words`
- `the exported Markdown should equal "{text}"`

There are also a few intentionally domain-specific assertions (for instance, a newly extracted scene occupying the original selection position or two split child scenes having particular ordered prose). They should remain explicit rather than being forced into an overly generic step language.

## Step semantics and unresolved behaviour

- **Opening a node:** `I open ... in the editor` always means navigating to that node as the editor root. The initial state may be established by the same step in a background or scenario.
- **Ownership:** `should own the prose "X"` asserts that `X` appears as a substring of *that node's directly owned text*, not only of its recursively assembled text. Nodes may own multiple separate prose spans.
- **Text equality:** The assembled-manuscript comparison is against the state **immediately before the first `When` action in that scenario** (or a snapshot captured by the implementation before a structural sequence). It compares prose exactly, including whitespace, excluding structural markers.
- **Viewport visibility:** `should show` / `should not show` refers to the rendered editor content, not project storage. It must not rely solely on DOM existence for replaced or collapsed CodeMirror ranges.
- **Position:** A `parent side` caret is outside a child boundary; a `child side` caret is inside the child. `at the end of "Manuscript" on the parent side` refers to the end of the root's assembled editor document.
- **Selection across nodes:** `select from the text "A" to the text "B"` includes the intervening child; exact parent-text deletion behaviour remains intentionally unspecified. The child and its contents must survive.
- **Undo:** `undo` / `redo` invokes the editor's normal UI interaction; it is not a direct model mutation.
- **Context-menu labels:** `Create child from selection` and `Insert child here` are **semantic action names** in these specifications, not fixed UI copy. The selector layer may map them to accessible labels.
- **Structure validation:** The tests describe expected product behaviour, including operations not necessarily implemented in the current prototype. Do not mark them passing solely because the UI is visually plausible.
- **Persistence:** The fixture layer may directly populate a test project. `When` operations should exercise the actual UI. Read-only inspection of the live model or saved project is appropriate for ownership, hierarchy and identity assertions.

No implementation decisions about the exact caret location after a cross-boundary delete, or about cross-open-node undo history, have been introduced.
