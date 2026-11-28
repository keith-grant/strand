import type {EditorState} from '@codemirror/state';
import {describe, expect, it} from 'vitest';
import {apply, editorState, redoIn, show, undoIn} from '../testing/editor';
import * as commands from './commands';

/** Run a command and show the result, or its error message. */
function run(state: EditorState, result: {spec: object} | {error: string}, selection = true) {
  return 'error' in result ? `error: ${result.error}` : show(apply(state, result.spec), selection);
}
const runOn = (spec: string, command: (s: EditorState) => {spec: object} | {error: string}, selection = true) => {
  const state = editorState(spec);
  return run(state, command(state), selection);
};

describe('new scene', () => {
  const newScene = (spec: string) => runOn(spec, s => commands.newScene(s, 'N'));

  it('wraps the selection where it stands, even mid-line', () => {
    expect(newScene('She arrived. <The letter waited.> Nobody knew.')).toBe('She arrived. [N:|The letter waited.] Nobody knew.');
  });
  it('inserts an empty scene at the cursor', () => {
    expect(newScene('dawn.| The letter')).toBe('dawn.[N:|] The letter');
  });
  it('makes a scene inside a scene a grandchild', () => {
    expect(newScene('[Opening:She arrived. <The letter.>]')).toBe('[Opening:She arrived. [N:|The letter.]]');
  });
  it('can wrap whole scenes, which then sit inside the new one', () => {
    expect(newScene('<a [A:x] b>')).toBe('[N:|a [A:x] b]');
  });
  it('refuses a selection that cuts across a boundary', () => {
    expect(newScene('a<b [A:x>y]')).toMatch(/^error: The selection crosses a scene boundary/);
  });
  it('treats a paragraph selected from just before a scene as text inside the scene', () => {
    expect(newScene('<[A:Whole paragraph>]')).toBe('[A:[N:|Whole paragraph]]');
  });
  it('ignores the end of a scene where a selection starts just before it closes', () => {
    expect(newScene('[A:a<]b>')).toBe('[A:a][N:|b]');
  });
  it('ignores the start of a scene where a selection ends just after it opens', () => {
    expect(newScene('a<b[A:>c]')).toBe('a[N:|b][A:c]');
  });
  it('can be undone and redone', () => {
    const start = editorState('One <two> three'), result = commands.newScene(start, 'N');
    if ('error' in result) throw Error(result.error);
    const done = apply(start, result.spec), undone = undoIn(done);
    expect(show(undone, false)).toBe('One two three');
    expect(show(redoIn(undone), false)).toBe('One [N:two] three');
  });
});

describe('split', () => {
  const split = (spec: string) => runOn(spec, s => commands.split(s, 'New'));

  it('splits at the cursor, mid-line, with the new scene straight after', () => {
    expect(split('[E:He entered.| She stood.]')).toBe('[E:He entered.][New:| She stood.]');
  });
  it('takes the sub-scenes after the cursor into the new scene', () => {
    expect(split('[E:a [A:x] b| c [B:y] d]')).toBe('[E:a [A:x] b][New:| c [B:y] d]');
  });
  it('splits the innermost scene the cursor is in', () => {
    expect(split('[E:[A:one| two]]')).toBe('[E:[A:one][New:| two]]');
  });
  it('at the end, adds an empty scene after', () => {
    expect(split('[E:all of it|]')).toBe('[E:all of it][New:|]');
  });
  it('at the start, leaves the first scene empty', () => {
    expect(split('[E:|all of it]')).toBe('[E:][New:|all of it]');
  });
  it('refuses outside a scene, or with a selection', () => {
    expect(split('loose| text')).toMatch(/^error: Put the cursor inside a scene/);
    expect(split('[E:<some> text]')).toMatch(/^error: Split works at the cursor/);
  });
  it('reports which scene was split', () => {
    const result = commands.split(editorState('[E:a|b]'), 'New');
    expect('scene' in result && result.scene.id).toBe('E');
  });
  it('then merging back restores the original', () => {
    const start = editorState('[E:He entered.| She stood.]'), split = commands.split(start, 'New');
    if ('error' in split) throw Error(split.error);
    const after = apply(start, split.spec), merged = commands.mergeWith(after, -1, 'New');
    if ('error' in merged) throw Error(merged.error);
    expect(show(apply(after, merged.spec), false)).toBe('[E:He entered. She stood.]');
  });
});

describe('nextTitle', () => {
  it('numbers the second half', () => {
    expect(commands.nextTitle('Ending')).toBe('Ending (2)');
    expect(commands.nextTitle('Ending (2)')).toBe('Ending (3)');
    expect(commands.nextTitle('Part (one)')).toBe('Part (one) (2)');
  });
});

describe('merging neighbours', () => {
  it('merges with the next scene; the first keeps its identity', () => {
    expect(runOn('[First:One.|][Second:Two.]', s => commands.mergeWith(s, 1), false)).toBe('[First:One.Two.]');
  });
  it('merges with the previous scene', () => {
    expect(runOn('[First:One.][Second:|Two.]', s => commands.mergeWith(s, -1), false)).toBe('[First:One.Two.]');
  });
  it('keeps the blank lines between them, inside the merged scene', () => {
    expect(runOn('[A:a|]\n\n[B:b]', s => commands.mergeWith(s, 1), false)).toBe('[A:a\n\nb]');
  });
  it('refuses when other text separates them', () => {
    expect(runOn('[A:a|] text [B:b]', s => commands.mergeWith(s, 1))).toMatch(/^error: There’s no scene directly after/);
  });
  it('refuses at the end of a run of scenes', () => {
    expect(runOn('[A:a|]', s => commands.mergeWith(s, 1))).toMatch(/^error:/);
    expect(runOn('[A:|a]', s => commands.mergeWith(s, -1))).toMatch(/^error:/);
  });
  it('works on a named scene, wherever the cursor is', () => {
    expect(runOn('|[A:a][B:b]', s => commands.mergeWith(s, 1, 'A'), false)).toBe('[A:ab]');
  });
  it('reports the scenes merged, the surviving one first', () => {
    const result = commands.mergeWith(editorState('[A:a][B:|b]'), -1);
    expect('group' in result && result.group.map(s => s.id)).toEqual(['A', 'B']);
  });
});

describe('merging a selection', () => {
  const merge = (spec: string) => runOn(spec, commands.mergeSelection, false);

  it('merges every scene the selection runs across, children and all', () => {
    expect(merge('[A:a<a][B:[B1:x] [B2:y]]\n[C:c>c]')).toBe('[A:aa[B1:x] [B2:y]\ncc]');
  });
  it('refuses when the two ends are at different levels', () => {
    expect(merge('[A:[A1:x<x]][B:b>b]')).toMatch(/^error: .*same level/);
  });
  it('refuses within one scene, or outside scenes', () => {
    expect(merge('[A:a<b>c]')).toMatch(/^error: To merge, select from inside one scene into another/);
    expect(merge('<loose> text')).toMatch(/^error:/);
  });
  it('refuses when other text separates them', () => {
    expect(merge('[A:a<a] text [B:b>b]')).toMatch(/^error: Only touching scenes/);
  });
});

describe('other commands', () => {
  it('merges a scene into its parent, keeping its text in place', () => {
    expect(runOn('Before [Middle:during] after', s => commands.mergeIntoParent(s, 'Middle'), false)).toBe('Before during after');
  });
  it('deletes a scene with its text and sub-scenes', () => {
    expect(runOn('a [M:b [Sub:c]] d', s => commands.remove(s, 'M'), false)).toBe('a  d');
  });
  it('reports scenes that aren’t in the open text', () => {
    expect(runOn('a', s => commands.remove(s, 'Ghost'))).toMatch(/^error:/);
    expect(runOn('a', s => commands.mergeIntoParent(s, 'Ghost'))).toMatch(/^error:/);
  });
});

describe('placing scenes', () => {
  const place = (spec: string, id: string, target: string | null, where: 'before' | 'after' | 'inside') => {
    const state = editorState(spec), result = commands.place(state, id, target, where);
    return result === null ? null : show(apply(state, result.spec), false);
  };

  it('moves a scene before a sibling, carrying its paragraph break', () => {
    expect(place('[A:a]\n\n[B:b]\n\n[C:c]', 'C', 'A', 'before')).toBe('[C:c]\n\n[A:a]\n\n[B:b]');
  });
  it('moves a scene after a sibling', () => {
    expect(place('[A:a]\n\n[B:b]\n\n[C:c]', 'A', 'C', 'after')).toBe('[B:b]\n\n[C:c]\n\n[A:a]');
  });
  it('moves a scene to the end of another', () => {
    expect(place('[A:a]\n\n[B:b]', 'B', 'A', 'inside')).toBe('[A:a\n\n[B:b]]');
  });
  it('moves a scene to the end of the opened node', () => {
    // Only blank-line gaps travel with a moved scene; spaces within a line stay where they were.
    expect(place('[A:[In:x] a]\n\nend', 'In', null, 'inside')).toBe('[A: a]\n\nend\n\n[In:x]');
  });
  it('does nothing when the scene is already there', () => {
    const state = editorState('[A:a]\n\n[B:b]'), result = commands.place(state, 'B', 'A', 'after');
    expect(result?.spec).toEqual({});
  });
  it('declines scenes that aren’t in the open text', () => {
    expect(place('[A:a]', 'Ghost', 'A', 'before')).toBeNull();
    expect(place('[A:a]', 'A', null, 'before')).toBeNull();
  });
});

describe('available commands', () => {
  const available = (spec: string) => commands.available(editorState(spec));

  it('offers split and both merges inside touching scenes', () => {
    expect(available('[A:a][B:|b][C:c]')).toEqual({newScene: true, split: true, mergePrevious: true, mergeNext: true, merge: false});
  });
  it('offers only new scene outside scenes', () => {
    expect(available('text| [A:a]')).toEqual({newScene: true, split: false, mergePrevious: false, mergeNext: false, merge: false});
  });
  it('offers merge for a selection across touching scenes, and not new scene', () => {
    expect(available('[A:a<a][B:b>b]')).toMatchObject({newScene: false, split: false, merge: true});
  });
  it('offers new scene for a selection within one scene', () => {
    expect(available('[A:<abc>]')).toMatchObject({newScene: true, merge: false});
  });
});
