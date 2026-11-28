/*
 * Structural commands as plain functions: given the editor state, return the edit to make (as a transaction spec)
 * or the reason it can't be done. SceneEditor applies them; unit tests apply them to bare editor states.
 */
import {EditorSelection, type ChangeSpec, type EditorState, type TransactionSpec} from '@codemirror/state';
import {isolateHistory} from '@codemirror/commands';
import {type Place, cutWithGap, separators} from '../model';
import {endToken, startToken} from './markers';
import {type Scene, mergeableNeighbours, sceneAt, sceneById, scenesField, siblingsOf, structural, touching} from './scenes';

export type Result<T = object> = ({spec: TransactionSpec} & T) | {error: string};

/** Mark an edit as a structural command: it passes the guard, and is its own undo step. */
function command(kind: string, spec: TransactionSpec): TransactionSpec {
  return {...spec, annotations: [structural.of(kind), isolateHistory.of('full')], userEvent: `structure.${kind}`, scrollIntoView: true};
}

/** "Ending" → "Ending (2)", "Ending (2)" → "Ending (3)". */
export function nextTitle(title: string) {
  const m = /^(.*) \((\d+)\)$/.exec(title);
  return m ? `${m[1]} (${Number(m[2]) + 1})` : `${title} (2)`;
}

/** Nudge selection ends that sit just outside a token to the side that makes sense, e.g. a triple-clicked
 *  paragraph that starts a scene selects the scene's text rather than reaching into the parent. */
export function tighten(scenes: readonly Scene[], from: number, to: number) {
  for (let moved = true; moved && from < to;) {
    moved = false;
    for (const s of scenes) {
      if (from === s.from && to < s.to) { from = s.innerFrom; moved = true; }
      else if (from === s.innerTo) { from = s.to; moved = true; }
      if (to === s.to && from > s.from) { to = s.innerTo; moved = true; }
      else if (to === s.innerFrom) { to = s.from; moved = true; }
    }
  }
  return {from: Math.min(from, to), to};
}

/** The text New scene would wrap, or why it can't. */
export function newSceneRange(state: EditorState): {from: number; to: number} | string {
  const {scenes} = state.field(scenesField);
  const {from, to} = tighten(scenes, state.selection.main.from, state.selection.main.to);
  for (const s of scenes) {
    const apart = s.to <= from || s.from >= to, around = s.innerFrom <= from && to <= s.innerTo, within = from <= s.from && s.to <= to;
    if (!apart && !around && !within) return 'The selection crosses a scene boundary. Select text inside one scene.';
  }
  return {from, to};
}

/** Make the selection a new child scene with the given id where it stands; with no selection, an empty one. */
export function newScene(state: EditorState, id: string): Result {
  const range = newSceneRange(state);
  if (typeof range === 'string') return {error: range};
  return {spec: command('new', {
    changes: [{from: range.from, insert: startToken(id)}, {from: range.to, insert: endToken(id)}],
    selection: EditorSelection.cursor(range.from + startToken(id).length),
  })};
}

/** Split the scene the cursor is in: everything after the cursor becomes a new scene (with the given id) straight
 *  after it. `scene` is the scene that was split. */
export function split(state: EditorState, id: string): Result<{scene: Scene}> {
  const sel = state.selection.main, s = sceneAt(state, sel.head);
  if (!sel.empty) return {error: 'Split works at the cursor. Clear the selection first.'};
  if (!s) return {error: 'Put the cursor inside a scene to split it. (To split the node you have open, open its parent.)'};
  const pos = sel.head, middle = endToken(s.id) + startToken(id);
  // The old closing token now closes the new scene; the cursor gets the old scene's closing token plus the new opening one.
  const changes = pos === s.innerTo
    ? [{from: s.innerTo, to: s.to, insert: middle + endToken(id)}]
    : [{from: pos, insert: middle}, {from: s.innerTo, to: s.to, insert: endToken(id)}];
  return {spec: command('split', {changes, selection: EditorSelection.cursor(pos + middle.length)}), scene: s};
}

/** Join touching sibling scenes into the first, which keeps its title. Blank space between them is kept. */
function mergeScenes(group: readonly Scene[]): TransactionSpec {
  const first = group[0], last = group[group.length - 1], changes: ChangeSpec[] = [];
  for (let i = 0; i + 1 < group.length; i++)
    changes.push({from: group[i].innerTo, to: group[i].to}, {from: group[i + 1].from, to: group[i + 1].innerFrom});
  changes.push({from: last.innerTo, to: last.to, insert: endToken(first.id)});
  return command('merge', {changes});
}

/** Merge a scene (default: the one the cursor is in) with the touching scene before (-1) or after (1) it.
 *  `group` is the scenes merged, the surviving one first. */
export function mergeWith(state: EditorState, direction: -1 | 1, id?: string): Result<{group: Scene[]}> {
  const s = id ? sceneById(state, id) : sceneAt(state, state.selection.main.head);
  if (!s) return {error: 'Put the cursor inside a scene first.'};
  const siblings = siblingsOf(state, s.parent), other = siblings[siblings.indexOf(s) + direction];
  const group = other && (direction < 0 ? [other, s] : [s, other]);
  if (!group || !touching(state, group[0], group[1])) return {error: `There’s no scene directly ${direction < 0 ? 'before' : 'after'} this one to merge with.`};
  return {spec: mergeScenes(group), group};
}

/** The scenes a selection would merge: from the scene it starts in to the scene it ends in, which must share a
 *  parent and all touch. Scenes nested inside them simply come along. */
export function selectionGroup(state: EditorState): Scene[] | string {
  const {from, to} = state.selection.main, {scenes} = state.field(scenesField);
  let start: Scene | null = null, end: Scene | null = null;
  for (const s of scenes) { // later matches are nested deeper, so the last match is the innermost
    if (s.from <= from && from < s.to) start = s;
    if (s.from < to && to <= s.to) end = s;
  }
  if (!start || !end || start === end) return 'To merge, select from inside one scene into another.';
  if (start.parent !== end.parent) return 'To merge, the selection must start and end in scenes at the same level.';
  const siblings = siblingsOf(state, start.parent), group = siblings.slice(siblings.indexOf(start), siblings.indexOf(end) + 1);
  for (let i = 1; i < group.length; i++)
    if (!touching(state, group[i - 1], group[i])) return 'Only touching scenes can be merged. There’s other text between these.';
  return group;
}

/** Merge every scene the selection runs across. */
export function mergeSelection(state: EditorState): Result<{group: Scene[]}> {
  const group = selectionGroup(state);
  return typeof group === 'string' ? {error: group} : {spec: mergeScenes(group), group};
}

/** Remove a scene's boundary, leaving its text (and sub-scenes) in the parent. */
export function mergeIntoParent(state: EditorState, id: string): Result {
  const s = sceneById(state, id);
  if (!s) return {error: 'That scene isn’t in the open text.'};
  return {spec: command('merge', {changes: [{from: s.from, to: s.innerFrom}, {from: s.innerTo, to: s.to}]})};
}

/** Delete a scene, its text and its sub-scenes. */
export function remove(state: EditorState, id: string): Result {
  const s = sceneById(state, id);
  if (!s) return {error: 'That scene isn’t in the open text.'};
  return {spec: command('delete', {changes: {from: s.from, to: s.to}})};
}

/** Move a scene before or after another scene, or to the end of one (target null = the opened node, 'inside'
 *  only). Null if either isn't in this document, so the caller can move it in the stored model instead.
 *  An empty spec means it's already there. */
export function place(state: EditorState, id: string, target: string | null, where: Place): {spec: TransactionSpec} | null {
  const s = sceneById(state, id), t = target === null ? null : sceneById(state, target);
  if (!s || (target === null ? where !== 'inside' : !t)) return null;
  const slice = (a: number, b: number) => state.sliceDoc(a, b);
  const inner = (scene: Scene | null | undefined): [number, number] => scene ? [scene.innerFrom, scene.innerTo] : [0, state.doc.length];
  const parentOf = (scene: Scene) => scene.parent === null ? null : sceneById(state, scene.parent);
  const [start, end] = where === 'inside' ? inner(t) : inner(parentOf(t!));
  const at = where === 'inside' ? end : where === 'before' ? t!.from : t!.to;
  const [cutFrom, cutTo] = cutWithGap(slice, s.from, s.to, ...inner(parentOf(s)));
  if (at >= cutFrom && at <= cutTo) return {spec: {}};
  const [lead, trail] = separators(slice, at, start, end);
  const changes = [{from: cutFrom, to: cutTo}, {from: at, insert: lead + slice(s.from, s.to) + trail}].sort((a, b) => a.from - b.from);
  return {spec: command('move', {changes})};
}

/** Which scene commands make sense for the current cursor or selection. */
export function available(state: EditorState) {
  const sel = state.selection.main, scene = sceneAt(state, sel.head);
  const neighbours = scene && sel.empty ? mergeableNeighbours(state).get(scene.id) : undefined;
  return {
    newScene: typeof newSceneRange(state) !== 'string',
    split: !!scene && sel.empty,
    mergePrevious: !!neighbours?.previous,
    mergeNext: !!neighbours?.next,
    merge: !sel.empty && typeof selectionGroup(state) !== 'string',
  };
}
export type Available = ReturnType<typeof available>;
