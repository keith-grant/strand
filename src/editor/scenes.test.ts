import {Text} from '@codemirror/state';
import {describe, expect, it} from 'vitest';
import {apply, at, editorState, parse, show, type} from '../testing/editor';
import {HUES, mergeableNeighbours, sceneAt, sceneById, scan, scenesField, shownScenes, siblingsOf, touching} from './scenes';
import {serialize} from './markers';

const scenes = (spec: string) => scan(Text.of(parse(spec).doc.split('\n')));

describe('scan', () => {
  it('finds scenes in order of where they start, with depth and parent', () => {
    expect(scenes('[A:a [B:b]] [C:c]').map(s => [s.id, s.depth, s.parent])).toEqual([['A', 1, null], ['B', 2, 'A'], ['C', 1, null]]);
  });
  it('gives each top-level scene a colour, shared by everything inside it', () => {
    const found = scenes('[A:[A1:]] [B:] [C:] [D:] [E:] [F:] [G:]');
    expect(found.map(s => s.hue)).toEqual([0, 0, 1, 2, 3, 4, 5, 0]);
    expect(HUES).toBe(6);
  });
  it('records where each scene and its inside begin and end', () => {
    const {doc} = parse('ab[X:cd]ef');
    const [x] = scan(Text.of([doc]));
    expect(doc.slice(x.innerFrom, x.innerTo)).toBe('cd');
    expect(doc.slice(0, x.from)).toBe('ab');
    expect(doc.slice(x.to)).toBe('ef');
  });
});

describe('keeping scenes in step with edits', () => {
  // Typing exactly at a boundary: which scene does the text belong to?
  const typed = (spec: string, text: string) => serialize(type(editorState(spec), text).doc.toString(), 'Root');

  it('typing just before a scene belongs to the parent', () => {
    expect(typed('Before |[Middle:inside] after.', 'right ').get('Root')).toBe('Before right {{node:Middle}} after.');
  });
  it('typing just inside the start of a scene belongs to the scene', () => {
    expect(typed('Before [Middle:|inside] after.', 'just ').get('Middle')).toBe('just inside');
  });
  it('typing just inside the end of a scene belongs to the scene', () => {
    expect(typed('Before [Middle:inside|] after.', ' out').get('Middle')).toBe('inside out');
  });
  it('typing just after a scene belongs to the parent', () => {
    expect(typed('Before [Middle:inside]| after.', 'and then').get('Root')).toBe('Before {{node:Middle}}and then after.');
  });
  it('typing into an empty scene fills it', () => {
    expect(typed('x[Empty:|]y', 'New prose.').get('Empty')).toBe('New prose.');
  });
  it('tracks positions without rescanning', () => {
    let state = editorState('|[A:a] [B:b]');
    state = type(state, 'Prefix ');
    const field = state.field(scenesField);
    expect(field.scenes.map(s => state.sliceDoc(s.innerFrom, s.innerTo))).toEqual(['a', 'b']);
    expect(sceneById(state, 'B')).toBe(field.scenes[1]);
  });
});

describe('queries', () => {
  it('finds the innermost scene at a position', () => {
    const state = editorState('out [A:a [B:b] a] out');
    expect(sceneAt(state, at(state, 'b'))?.id).toBe('B');
    expect(sceneAt(state, at(state, 'a'))?.id).toBe('A');
    expect(sceneAt(state, 0)).toBeNull();
  });
  it('hides the contents of collapsed scenes', () => {
    const state = editorState('[A:[A1:x]] [B:y]', ['A']);
    expect(shownScenes(state).map(s => s.id)).toEqual(['A', 'B']);
  });
  it('finds siblings within a parent', () => {
    const state = editorState('[A:[A1:] [A2:]] [B:]');
    expect(siblingsOf(state, null).map(s => s.id)).toEqual(['A', 'B']);
    expect(siblingsOf(state, 'A').map(s => s.id)).toEqual(['A1', 'A2']);
  });
  it('treats scenes as touching when only blank space separates them', () => {
    const state = editorState('[A:a]\n\n[B:b] text [C:c][D:d]');
    const s = (id: string) => sceneById(state, id)!;
    expect(touching(state, s('A'), s('B'))).toBe(true);
    expect(touching(state, s('B'), s('C'))).toBe(false);
    expect(touching(state, s('C'), s('D'))).toBe(true);
  });
  it('knows which scenes can merge with their neighbours', () => {
    const flags = mergeableNeighbours(editorState('[A:] [B:] text [C:[C1:][C2:]]'));
    expect(flags.get('A')).toEqual({previous: false, next: true});
    expect(flags.get('B')).toEqual({previous: true, next: false});
    expect(flags.get('C')).toEqual({previous: false, next: false});
    expect(flags.get('C1')).toEqual({previous: false, next: true});
  });
});

describe('notation helper', () => {
  it('round-trips', () => {
    for (const spec of ['a|b', '<ab>c', 'x [A:y [B:|z]] w', '']) expect(show(editorState(spec))).toBe(spec === '' ? '|' : spec);
  });
  it('applies plain transactions', () => {
    expect(show(apply(editorState('ab|'), {changes: {from: 0, insert: 'z'}}), false)).toBe('zab');
  });
});
