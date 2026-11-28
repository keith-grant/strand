import {describe, expect, it} from 'vitest';
import {children, compose, cutWithGap, node, parts, place, reference, separators, subtree, validate, wordCount, wordTotals} from './model';
import {book, prose} from './testing/book';

describe('parts', () => {
  it('splits prose into text and child references, in order', () => {
    expect(parts('a{{node:x}}b{{node:y}}')).toEqual([
      {kind: 'text', text: 'a'}, {kind: 'child', id: 'x'}, {kind: 'text', text: 'b'}, {kind: 'child', id: 'y'}, {kind: 'text', text: ''},
    ]);
  });
  it('treats prose without references as one text part', () => {
    expect(parts('')).toEqual([{kind: 'text', text: ''}]);
    expect(parts('plain')).toEqual([{kind: 'text', text: 'plain'}]);
  });
  it('round-trips with reference()', () => {
    expect(parts(`x${reference('abc-1')}y`)[1]).toEqual({kind: 'child', id: 'abc-1'});
  });
});

describe('structure', () => {
  const p = book({Root: 'A {{One}} B {{Two}}', One: 'one {{Deep}}', Two: 'two', Deep: 'deep'});

  it('lists children in order of appearance', () => {
    expect(children(node(p, 'Root'))).toEqual(['One', 'Two']);
  });
  it('lists a subtree parents first', () => {
    expect(subtree(p, 'Root')).toEqual(['Root', 'One', 'Deep', 'Two']);
    expect(subtree(p, 'One')).toEqual(['One', 'Deep']);
  });
  it('composes the full text in book order', () => {
    expect(compose(p)).toBe('A one deep B two');
    expect(compose(p, 'One')).toBe('one deep');
  });
  it('throws for a missing node', () => {
    expect(() => node(p, 'Nope')).toThrow('Missing node Nope');
  });
});

describe('validate', () => {
  it('accepts a proper tree', () => {
    expect(() => validate(book({Root: '{{A}}', A: '{{B}}', B: ''}))).not.toThrow();
  });
  it('rejects a cycle', () => {
    expect(() => validate(book({Root: '{{A}}', A: '{{B}}', B: '{{A}}'}))).toThrow('Repeated node or cycle');
  });
  it('rejects a node referenced twice', () => {
    expect(() => validate(book({Root: '{{A}} {{A}}', A: ''}))).toThrow('Repeated node or cycle');
  });
  it('rejects unreachable nodes', () => {
    expect(() => validate(book({Root: 'text', Orphan: ''}))).toThrow('Unreachable or duplicate nodes');
  });
  it('rejects a reference to a missing node', () => {
    expect(() => validate(book({Root: '{{Ghost}}'}))).toThrow('Missing node Ghost');
  });
});

describe('word counts', () => {
  it('counts words separated by any whitespace', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   ')).toBe(0);
    expect(wordCount('  one  two\nthree\tfour ')).toBe(4);
  });
  it('separates owned and aggregate counts', () => {
    const totals = wordTotals(book({Manuscript: 'one two {{Middle}}', Middle: 'three four five'}));
    expect(totals.get('Manuscript')).toEqual({own: 2, total: 5});
    expect(totals.get('Middle')).toEqual({own: 3, total: 3});
  });
  it('does not join words either side of a child', () => {
    expect(wordTotals(book({Root: 'end{{Child}}start', Child: ''})).get('Root')!.own).toBe(2);
  });
});

describe('separators', () => {
  const slice = (text: string) => (a: number, b: number) => text.slice(a, b);
  const sep = (text: string, at: number) => separators(slice(text), at, 0, text.length);

  it('adds nothing at the edges of an empty container', () => {
    expect(separators(slice(''), 0, 0, 0)).toEqual(['', '']);
  });
  it('adds a paragraph break where text runs on', () => {
    expect(sep('ab', 1)).toEqual(['\n\n', '\n\n']);
  });
  it('completes a single line break to a paragraph break', () => {
    expect(sep('a\nb', 2)).toEqual(['\n', '\n\n']);
    expect(sep('a\nb', 1)).toEqual(['\n\n', '\n']);
  });
  it('adds nothing where there is already a paragraph break', () => {
    expect(sep('a\n\nb', 3)).toEqual(['', '\n\n']);
    expect(sep('a\n\nb', 1)).toEqual(['\n\n', '']);
  });
});

describe('cutWithGap', () => {
  const cut = (text: string, from: number, to: number) => cutWithGap((a, b) => text.slice(a, b), from, to, 0, text.length);

  it('takes the blank lines after a block', () => {
    expect(cut('A\n\nX\n\nB', 3, 4)).toEqual([3, 6]);
  });
  it('takes the blank lines before a block at the end', () => {
    expect(cut('A\n\nX', 3, 4)).toEqual([1, 4]);
  });
  it('takes no spaces within a line', () => {
    expect(cut('one X two', 4, 5)).toEqual([4, 5]);
  });
});

describe('place', () => {
  const start = () => book({Root: '{{A}}\n\n{{B}}\n\n{{C}}', A: 'a', B: 'b {{Inner}}', C: 'c', Inner: 'i'});

  it('moves a node before a sibling', () => {
    const p = start();
    place(p, 'C', 'A', 'before');
    expect(prose(p, 'Root')).toBe('{{C}}\n\n{{A}}\n\n{{B}}');
  });
  it('moves a node after a sibling', () => {
    const p = start();
    place(p, 'A', 'C', 'after');
    expect(prose(p, 'Root')).toBe('{{B}}\n\n{{C}}\n\n{{A}}');
  });
  it('moves a node inside another, at the end', () => {
    const p = start();
    place(p, 'C', 'A', 'inside');
    expect(prose(p, 'Root')).toBe('{{A}}\n\n{{B}}');
    expect(prose(p, 'A')).toBe('a\n\n{{C}}');
  });
  it('moves a node up to a different parent', () => {
    const p = start();
    place(p, 'Inner', 'A', 'after');
    expect(prose(p, 'Root')).toBe('{{A}}\n\n{{Inner}}\n\n{{B}}\n\n{{C}}');
    expect(prose(p, 'B')).toBe('b ');
  });
  it('refuses to move a node inside itself, leaving the project unchanged', () => {
    const p = start(), before = structuredClone(p);
    expect(() => place(p, 'B', 'Inner', 'inside')).toThrow('inside itself');
    expect(p).toEqual(before);
  });
  it('refuses to move the root, or to place anything beside it', () => {
    const p = start(), before = structuredClone(p);
    expect(() => place(p, 'Root', 'A', 'inside')).toThrow();
    expect(() => place(p, 'A', 'Root', 'before')).toThrow();
    expect(p).toEqual(before);
  });
  it('keeps the composed text apart from the moved block', () => {
    const p = start();
    place(p, 'A', 'C', 'after');
    expect(compose(p)).toBe('b i\n\nc\n\na');
  });
});
