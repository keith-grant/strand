import {describe, expect, it} from 'vitest';
import {apply, backspace, del, editorState, paste, show, type, undoIn} from '../testing/editor';
import * as commands from './commands';
import {protectedRanges, subtract} from './guard';
import {endToken, startToken} from './markers';
import {scenesField} from './scenes';

describe('ordinary editing around scene boundaries', () => {
  it('lets plain typing through untouched', () => {
    expect(show(type(editorState('Hello| world'), ','))).toBe('Hello,| world');
  });

  it('lets ordinary Backspace and Delete through untouched', () => {
    expect(show(backspace(editorState('Hello| world')))).toBe('Hell| world');
    expect(show(del(editorState('Hello| world')))).toBe('Hello|world');
    expect(show(backspace(editorState('a [M:in|side] b')))).toBe('a [M:i|side] b');
  });

  it('lets a deletion that stays clear of boundaries through untouched', () => {
    expect(show(del(editorState('a [M:b<cd>e] f')))).toBe('a [M:b|e] f');
  });

  it('Backspace at the start of a scene does nothing', () => {
    const state = editorState('Before [Middle:|inside] after.');
    expect(show(backspace(state))).toBe('Before [Middle:|inside] after.');
  });

  it('Delete at the end of a scene does nothing', () => {
    const state = editorState('Before [Middle:inside|] after.');
    expect(show(del(state))).toBe('Before [Middle:inside|] after.');
  });

  it('Backspace just after a scene does nothing', () => {
    expect(show(backspace(editorState('[A:a]|b')))).toBe('[A:a]|b');
  });

  it('deleting a selection across a boundary deletes the text but keeps the scene', () => {
    // Current behaviour (still under discussion, see features/03): the text goes, the scene's boundary stays.
    const state = del(editorState('Be<fore [Middle:ins>ide] after.'));
    expect(show(state, false)).toBe('Be[Middle:ide] after.');
    expect(state.field(scenesField).scenes.map(s => s.id)).toEqual(['Middle']);
  });

  it('deleting a selection across a whole scene empties it but keeps it', () => {
    const state = del(editorState('<Before [Middle:inside] after.>'));
    expect(show(state, false)).toBe('[Middle:]');
  });

  it('typing over a selection that starts just before a scene puts the text inside it', () => {
    // E.g. a triple-clicked paragraph that begins a scene.
    const state = type(editorState('Intro\n<[Scene:Old text]>'), 'New');
    expect(show(state)).toBe('Intro\n[Scene:New|]');
  });

  it('typing over a selection across a boundary lands where the selection starts', () => {
    expect(show(type(editorState('Be<fore [M:in>side]'), 'X'))).toBe('BeX|[M:side]');
  });

  it('carries on typing in order after replacing a selection across a boundary', () => {
    let state = editorState('Be<fore [M:in>side]');
    for (const c of 'Hello') state = type(state, c);
    expect(show(state)).toBe('BeHello|[M:side]');
  });

  it('leaves the cursor where the text was after deleting across a boundary', () => {
    expect(show(del(editorState('Be<fore [M:in>side]')))).toBe('Be|[M:side]');
  });

  it('strips scene markers from pasted text', () => {
    const state = paste(editorState('a [M:|x]'), `smuggled${startToken('Evil')}text${endToken('Evil')}`);
    expect(show(state)).toBe('a [M:smuggledtext|x]');
  });

  it('protects the whole of a collapsed scene', () => {
    const state = del(editorState('<before [C:hidden] after>', ['C']));
    expect(show(state, false)).toBe('[C:hidden]');
  });

  it('lets structural commands through', () => {
    const result = commands.mergeIntoParent(editorState('a [M:b] c'), 'M');
    if ('error' in result) throw Error(result.error);
    expect(show(apply(editorState('a [M:b] c'), result.spec), false)).toBe('a b c');
  });

  it('lets undo of a structural command through', () => {
    const start = editorState('a [M:b] c'), result = commands.mergeIntoParent(start, 'M');
    if ('error' in result) throw Error(result.error);
    expect(show(undoIn(apply(start, result.spec)), false)).toBe('a [M:b] c');
  });
});

describe('protected ranges', () => {
  it('covers every token, and whole collapsed scenes, sorted and merged', () => {
    const state = editorState('[A:a][B:[B1:x]]', ['B']);
    const field = state.field(scenesField), s = (id: string) => field.byId.get(id)!;
    expect(protectedRanges(state)).toEqual([[s('A').from, s('A').innerFrom], [s('A').innerTo, s('B').to]]);
  });

  it('subtracts ranges', () => {
    expect(subtract(0, 10, [[2, 4], [6, 7]])).toEqual([[0, 2], [4, 6], [7, 10]]);
    expect(subtract(3, 5, [[0, 10]])).toEqual([]);
    expect(subtract(3, 3, [])).toEqual([]);
    expect(subtract(0, 5, [[5, 8]])).toEqual([[0, 5]]);
  });
});
