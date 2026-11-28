import {describe, expect, it} from 'vitest';
import {compose} from '../model';
import {book} from '../testing/book';
import {parse} from '../testing/editor';
import {MARKER, blankMarkers, endToken, expand, serialize, startToken, stripMarkers, withoutMarkers} from './markers';

const doc = (spec: string) => parse(spec).doc;

describe('expand', () => {
  it('writes children out in place between tokens', () => {
    const p = book({Root: 'Before {{Middle}} after.', Middle: 'inside'});
    expect(expand(p, 'Root')).toBe(doc('Before [Middle:inside] after.'));
  });
  it('nests to any depth, and shows only the opened node’s part', () => {
    const p = book({Root: '{{A}}', A: 'a {{B}}', B: 'b {{C}}', C: 'c'});
    expect(expand(p, 'Root')).toBe(doc('[A:a [B:b [C:c]]]'));
    expect(expand(p, 'B')).toBe(doc('b [C:c]'));
  });
  it('keeps empty children', () => {
    expect(expand(book({Root: 'x{{E}}y', E: ''}), 'Root')).toBe(doc('x[E:]y'));
  });
  it('removes stray marker characters from stored prose', () => {
    const p = book({Root: `bad${startToken('Fake')}text`});
    expect(MARKER.test(expand(p, 'Root'))).toBe(false);
  });
});

describe('serialize', () => {
  it('is the inverse of expand', () => {
    const p = book({Root: 'Start {{A}}{{B}}\n\n{{C}} end', A: 'a {{Deep}} a', B: '', C: 'c', Deep: 'deep'});
    const prose = serialize(expand(p, 'Root'), 'Root');
    for (const n of p.nodes) expect(prose.get(n.id)).toBe(n.prose);
    expect(prose.size).toBe(p.nodes.length);
  });
  it('gives the opened node its own text, with children as references', () => {
    const prose = serialize(doc('Before [Middle:inside] after.'), 'Root');
    expect(prose.get('Root')).toBe('Before {{node:Middle}} after.');
    expect(prose.get('Middle')).toBe('inside');
  });
  it('closes a scene left open', () => {
    const prose = serialize(`a${startToken('X')}x`, 'Root');
    expect(prose.get('Root')).toBe('a{{node:X}}');
    expect(prose.get('X')).toBe('x');
  });
  it('ignores a stray closing token', () => {
    expect(serialize(`a${endToken('X')}b`, 'Root').get('Root')).toBe('ab');
  });
});

describe('stripping and blanking', () => {
  const text = doc('Before [Middle:inside] after.');

  it('strips markers, leaving the composed text', () => {
    const p = book({Root: 'Before {{Middle}} after.', Middle: 'inside'});
    expect(stripMarkers(text)).toBe(compose(p));
  });
  it('blanks markers without moving anything', () => {
    const blanked = blankMarkers(text);
    expect(blanked).toHaveLength(text.length);
    expect(MARKER.test(blanked)).toBe(false);
    expect(blanked.indexOf('inside')).toBe(text.indexOf('inside'));
  });
  it('leaves text without markers alone', () => {
    expect(blankMarkers('plain')).toBe('plain');
    expect(withoutMarkers('plain').at(3)).toBe(3);
  });
  it('maps positions in stripped text back to the original', () => {
    const {text: clean, at} = withoutMarkers(text);
    expect(clean).toBe('Before inside after.');
    for (const word of ['Before', 'inside', 'after']) expect(at(clean.indexOf(word))).toBe(text.indexOf(word));
  });
  it('maps positions when the text starts with a token', () => {
    const t = doc('[A:Hello] world');
    const {text: clean, at} = withoutMarkers(t);
    expect(clean).toBe('Hello world');
    expect(at(clean.indexOf('Hello'))).toBe(t.indexOf('Hello'));
    expect(at(clean.indexOf('world'))).toBe(t.indexOf('world'));
  });
});
