/*
 * Test helpers for editor state, using a readable notation instead of raw boundary tokens:
 *
 *   "Before [Middle:inside] after."   a scene with id Middle
 *   "|"                               the cursor
 *   "<" … ">"                         a selection
 *
 * Scene ids must be plain words (letters, digits, hyphens). Prose in tests can't use [ ] | < > themselves.
 */
import {EditorState, type StateCommand, type TransactionSpec} from '@codemirror/state';
import {deleteCharBackward, deleteCharForward, history, redo, undo} from '@codemirror/commands';
import {guard} from '../editor/guard';
import {OPEN, TOKEN, endToken, startToken} from '../editor/markers';
import {collapsedField, scenesField, toggleCollapse} from '../editor/scenes';

export function parse(spec: string): {doc: string; anchor: number; head: number} {
  let doc = '', anchor = -1, head = -1;
  const open: string[] = [];
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === '[') {
      const m = /^\[([A-Za-z0-9-]+):/.exec(spec.slice(i));
      if (!m) throw Error(`Bad scene at ${i} in ${spec}`);
      open.push(m[1]);
      doc += startToken(m[1]);
      i += m[0].length - 1;
    } else if (c === ']') {
      const id = open.pop();
      if (!id) throw Error(`Unmatched ] at ${i} in ${spec}`);
      doc += endToken(id);
    } else if (c === '|') anchor = head = doc.length;
    else if (c === '<') anchor = doc.length;
    else if (c === '>') head = doc.length;
    else doc += c;
  }
  if (open.length) throw Error(`Unclosed scene ${open.join(', ')} in ${spec}`);
  if (anchor < 0) anchor = head = doc.length;
  if (head < 0) head = anchor;
  return {doc, anchor, head};
}

/** An editor state with the scene machinery and undo history, but no view. */
export function editorState(spec: string, collapsed: string[] = []): EditorState {
  const {doc, anchor, head} = parse(spec);
  let state = EditorState.create({doc, selection: {anchor, head}, extensions: [scenesField, collapsedField, guard, history()]});
  for (const id of collapsed) state = state.update({effects: toggleCollapse.of(id)}).state;
  return state;
}

/** The state written back in the notation, with the cursor or selection. */
export function show(state: EditorState, selection = true): string {
  const doc = state.doc.toString(), {from, to, empty} = state.selection.main;
  const tokens = new Map<number, {length: number; text: string}>();
  for (const m of doc.matchAll(TOKEN)) tokens.set(m.index!, {length: m[0].length, text: m[1] === OPEN ? `[${m[2]}:` : ']'});
  let out = '';
  for (let p = 0; ; ) {
    if (selection) {
      if (empty && p === from) out += '|';
      if (!empty && p === from) out += '<';
      if (!empty && p === to) out += '>';
    }
    if (p >= doc.length) break;
    const t = tokens.get(p);
    if (t) { out += t.text; p += t.length; } else { out += doc[p]; p++; }
  }
  return out;
}

/** Apply a transaction the way the editor would, filters (the guard) included. */
export const apply = (state: EditorState, spec: TransactionSpec) => state.update(spec).state;

/** Type text at the selection, as the keyboard does. */
export const type = (state: EditorState, text: string) => apply(state, {...state.replaceSelection(text), userEvent: 'input.type'});

/** Paste text at the selection. */
export const paste = (state: EditorState, text: string) => apply(state, {...state.replaceSelection(text), userEvent: 'input.paste'});

function run(state: EditorState, command: StateCommand): EditorState {
  let result = state;
  command({state, dispatch: tr => { result = tr.state; }});
  return result;
}
// Declared as needing a view, but they only use the state; without a view, scene tokens aren't treated as single
// units, which is fine here since the guard is what's being tested.
export const backspace = (state: EditorState) => run(state, deleteCharBackward as unknown as StateCommand);
export const del = (state: EditorState) => run(state, deleteCharForward as unknown as StateCommand);
export const undoIn = (state: EditorState) => run(state, undo);
export const redoIn = (state: EditorState) => run(state, redo);

/** Position of the first occurrence of `text` in the document (throws if absent). */
export function at(state: EditorState, text: string, offset = 0) {
  const i = state.doc.toString().indexOf(text);
  if (i < 0) throw Error(`“${text}” not found`);
  return i + offset;
}
