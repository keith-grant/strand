/*
 * The right-click menu in the text: spelling and grammar help for what was clicked, then Cut/Copy/Paste, then the
 * scene commands that make sense there.
 */
import type {Grammar} from '../checking/grammar';
import {plainMessage, ruleName} from '../checking/grammar';
import type {Spelling} from '../checking/spelling';
import type {SceneEditor} from '../editor/scene-editor';
import {type MenuItem, showMenu} from './menu';

export interface TextMenuContext {
  editor: SceneEditor;
  spelling: Spelling;
  grammar: Grammar;
  addWord(word: string): void;
  turnOffRule(rule: string): void;
  copy(cut: boolean): void;
  paste(): void;
}

/** The menu for a right-click at document position `pos`. */
export function textMenuItems(ctx: TextMenuContext, pos: number): MenuItem[] {
  const {editor, spelling, grammar} = ctx, view = editor.view, state = view.state, sel = state.selection.main, items: MenuItem[] = [];

  const found = spelling.issueAt(state, pos);
  if (found) {
    const replace = (from: number, text: string) => view.dispatch({changes: {from, to: found.to, insert: text}, userEvent: 'input.spelling'});
    if (found.issue.action === 'delete') {
      let from = found.from; // also remove the space before the repeated word
      while (from > state.doc.lineAt(found.from).from && /[ \t]/.test(state.sliceDoc(from - 1, from))) from--;
      items.push({label: 'Delete repeated word', strong: true, run: () => replace(from, '')});
    } else if (found.issue.action === 'replace' && found.issue.replacement) {
      const fix = found.issue.replacement;
      items.push({label: fix, strong: true, run: () => replace(found.from, fix)});
    } else {
      items.push({
        placeholder: 'Looking for suggestions…',
        load: spelling.suggestions(found.text).then(list => list.length
          ? list.slice(0, 6).map(s => ({label: s, strong: true, run: () => replace(found.from, s)}))
          : [{label: 'No suggestions', disabled: true as const}]),
      });
    }
    if (found.issue.action !== 'delete') items.push(
      {label: 'Add to dictionary', hint: 'Accept this word everywhere in this book', run: () => ctx.addWord(found.text)},
      {label: 'Ignore', hint: 'Accept this word until Strand is closed', run: () => spelling.ignore(found.text, view)},
    );
    items.push('separator');
  }

  const problem = grammar.issueAt(state, pos);
  if (problem) {
    const fix = (text: string) => view.dispatch({changes: {from: problem.from, to: problem.to, insert: text}, userEvent: 'input.grammar'});
    items.push({note: plainMessage(problem.issue.message)});
    for (const text of problem.issue.fixes.slice(0, 4))
      items.push({label: text === '' ? `Remove “${problem.text}”` : text, strong: true, run: () => fix(text)});
    items.push(
      {label: 'Ignore', hint: 'Hide this one until Strand is closed', run: () => grammar.ignore(problem, view)},
      {label: `Turn off “${ruleName(problem.issue.rule)}” for this book`, run: () => ctx.turnOffRule(problem.issue.rule)},
      'separator',
    );
  }

  items.push(
    {label: 'Cut', disabled: sel.empty, run: () => ctx.copy(true)},
    {label: 'Copy', disabled: sel.empty, run: () => ctx.copy(false)},
    {label: 'Paste', run: () => ctx.paste()},
    'separator',
  );

  const can = editor.available(), scene = editor.activeScene();
  if (can.newScene) items.push({label: 'New scene', hint: 'Ctrl+Shift+E', run: () => editor.newScene()});
  if (can.split) items.push({label: 'Split scene here', hint: 'Ctrl+Shift+Enter', run: () => editor.split()});
  if (can.merge) items.push({label: 'Merge selected scenes', hint: 'Ctrl+Shift+M', run: () => editor.mergeSelection()});
  if (can.mergePrevious) items.push({label: 'Merge with previous', run: () => editor.mergeWith(-1)});
  if (can.mergeNext) items.push({label: 'Merge with next', run: () => editor.mergeWith(1)});
  if (scene && sel.empty) items.push({label: 'Merge with parent', run: () => editor.mergeIntoParent(scene.id)});
  return items;
}

/** Open the menu on right-click (or the keyboard's menu key) in the text. */
export function attachTextMenu(ctx: TextMenuContext) {
  const view = ctx.editor.view;
  view.contentDOM.addEventListener('contextmenu', e => {
    e.preventDefault();
    const sel = view.state.selection.main;
    let x = e.clientX, y = e.clientY, pos = view.posAtCoords({x, y});
    if (pos === null || (x === 0 && y === 0)) { // opened from the keyboard: use the cursor
      pos = sel.head;
      const c = view.coordsAtPos(pos);
      if (c) { x = c.left; y = c.bottom; }
    } else if (sel.empty || pos < sel.from || pos > sel.to) {
      view.dispatch({selection: {anchor: pos}}); // right-clicking outside the selection moves the cursor there
    }
    showMenu(x, y, textMenuItems(ctx, pos), () => ctx.editor.focus());
  });
}
