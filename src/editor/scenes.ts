/*
 * Scene state: the scenes in the editor document (found from the boundary tokens and kept up to date through every
 * edit), which ones are collapsed, and queries over them. No DOM here, so it all works in plain unit tests.
 */
import {Annotation, StateEffect, StateField, type EditorState, type Text, type Transaction} from '@codemirror/state';
import {CLOSE, MARKER, OPEN, TOKEN} from './markers';

export interface Scene {
  id: string;
  from: number;      // start of the opening token
  innerFrom: number; // first position inside the scene
  innerTo: number;   // start of the closing token
  to: number;        // end of the closing token
  depth: number;     // 1 = direct child of the opened node
  parent: string | null; // null = the opened node
  hue: number;       // colour slot, shared with the scene's top-level ancestor
}
export interface SceneState { scenes: readonly Scene[]; byId: ReadonlyMap<string, Scene> }
export const HUES = 6;

/** Find the scenes in a document, in order of where they start (so a scene comes before the scenes inside it). */
export function scan(doc: Text): Scene[] {
  const scenes: Scene[] = [], open: Scene[] = [];
  let topLevel = 0;
  for (const m of doc.toString().matchAll(TOKEN)) {
    const pos = m.index!, len = m[0].length;
    if (m[1] === OPEN) {
      const parent = open[open.length - 1];
      const scene = {id: m[2], from: pos, innerFrom: pos + len, innerTo: -1, to: -1, depth: open.length + 1, parent: parent ? parent.id : null, hue: parent ? parent.hue : topLevel++ % HUES};
      scenes.push(scene);
      open.push(scene);
    } else if (m[1] === CLOSE && open.length && open[open.length - 1].id === m[2]) {
      const scene = open.pop()!;
      scene.innerTo = pos;
      scene.to = pos + len;
    }
  }
  return scenes.filter(s => s.to >= 0);
}

const indexScenes = (scenes: readonly Scene[]): SceneState => ({scenes, byId: new Map(scenes.map(s => [s.id, s]))});

/** Marks transactions made by the structural commands (commands.ts). */
export const structural = Annotation.define<string>();
/** Structural commands, and undo/redo (which may replay them), may add or remove tokens. */
export const isStructural = (tr: Transaction) => tr.annotation(structural) !== undefined || tr.isUserEvent('undo') || tr.isUserEvent('redo');

export const scenesField = StateField.define<SceneState>({
  create: state => indexScenes(scan(state.doc)),
  update(value, tr) {
    if (!tr.docChanged) return value;
    let rescan = isStructural(tr);
    if (!rescan) tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (MARKER.test(inserted.toString())) rescan = true;
      else if (toA > fromA && value.scenes.some(s => (fromA < s.innerFrom && toA > s.from) || (fromA < s.to && toA > s.innerTo))) rescan = true;
    });
    if (rescan) return indexScenes(scan(tr.state.doc));
    // Ordinary edits never touch tokens, so token positions just shift. An insertion right before a
    // token belongs to the text before it, hence assoc 1 (the token moves right).
    return indexScenes(value.scenes.map(s => {
      const from = tr.changes.mapPos(s.from, 1), innerTo = tr.changes.mapPos(s.innerTo, 1);
      return {...s, from, innerFrom: from + (s.innerFrom - s.from), innerTo, to: innerTo + (s.to - s.innerTo)};
    }));
  },
});

export const toggleCollapse = StateEffect.define<string>();
/** Asks for a redraw without changing anything, e.g. after a rename. */
export const refresh = StateEffect.define<null>();

export const collapsedField = StateField.define<ReadonlySet<string>>({
  create: () => new Set(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(toggleCollapse)) {
      const next = new Set(value);
      if (!next.delete(e.value)) next.add(e.value);
      value = next;
    }
    return value;
  },
});

export const sceneById = (state: EditorState, id: string) => state.field(scenesField).byId.get(id);

/** The innermost scene containing `pos`, i.e. the scene that typing at `pos` goes into. */
export function sceneAt(state: EditorState, pos: number): Scene | null {
  let found: Scene | null = null;
  for (const s of state.field(scenesField).scenes) {
    if (s.from > pos) break;
    if (s.innerFrom <= pos && pos <= s.innerTo) found = s;
  }
  return found;
}

/** Scenes that are on screen in some form: everything except the contents of collapsed scenes. */
export function shownScenes(state: EditorState): Scene[] {
  const collapsed = state.field(collapsedField), out: Scene[] = [];
  let hiddenUntil = -1;
  for (const s of state.field(scenesField).scenes) {
    if (s.from < hiddenUntil) continue;
    out.push(s);
    if (collapsed.has(s.id)) hiddenUntil = s.to;
  }
  return out;
}

/** Two scenes in the same parent touch when only blank space (or nothing) lies between them. */
export const touching = (state: EditorState, a: Scene, b: Scene) => state.sliceDoc(a.to, b.from).trim() === '';

export const siblingsOf = (state: EditorState, parent: string | null) => state.field(scenesField).scenes.filter(s => s.parent === parent);

/** For each scene, whether it touches the scene before / after it in the same parent (so can merge with it). */
export function mergeableNeighbours(state: EditorState): Map<string, {previous: boolean; next: boolean}> {
  const out = new Map<string, {previous: boolean; next: boolean}>(), lastInParent = new Map<string | null, Scene>();
  for (const s of state.field(scenesField).scenes) {
    const flags = {previous: false, next: false}, before = lastInParent.get(s.parent);
    out.set(s.id, flags);
    if (before && touching(state, before, s)) { flags.previous = true; out.get(before.id)!.next = true; }
    lastInParent.set(s.parent, s);
  }
  return out;
}
