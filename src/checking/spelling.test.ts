import type {EditorView} from '@codemirror/view';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {backend} from '../backend';
import {MARKER} from '../editor/markers';
import {parse} from '../testing/editor';
import type {Found} from './checker';
import {type SpellIssue, Spelling} from './spelling';

vi.mock('../backend', () => ({backend: {spellCheck: vi.fn(), spellSuggest: vi.fn()}}));

class TestSpelling extends Spelling {
  run(paragraphs: string[]) { return this.check(paragraphs); }
  visible(found: Found<SpellIssue>) { return this.shows(found); }
}

function found(text: string, action: SpellIssue['action'] = 'suggest'): Found<SpellIssue> {
  return {from: 0, to: text.length, text, issue: {start: 0, length: text.length, action, replacement: null}, line: text, lineFrom: 0};
}

describe('Spelling', () => {
  const dictionary = new Set<string>();
  let report: ReturnType<typeof vi.fn<(message: string) => void>>;
  const spelling = () => new TestSpelling({language: 'en-GB', accepted: word => dictionary.has(word), report});
  const fakeView = {dispatch: vi.fn()} as unknown as EditorView;

  beforeEach(() => {
    dictionary.clear();
    report = vi.fn();
    vi.mocked(backend.spellCheck).mockReset();
  });

  it('blanks scene markers before checking, so positions still match the editor text', async () => {
    const line = parse('[M:teh] cat').doc;
    vi.mocked(backend.spellCheck).mockResolvedValue({language: 'en-GB', issues: [[]]});
    await spelling().run([line]);
    const [, [sent]] = vi.mocked(backend.spellCheck).mock.calls[0];
    expect(sent).toHaveLength(line.length);
    expect(sent.indexOf('teh')).toBe(line.indexOf('teh'));
    expect(sent.indexOf('cat')).toBe(line.indexOf('cat'));
    expect(MARKER.test(sent)).toBe(false);
  });

  it('says once when it falls back to another language', async () => {
    vi.mocked(backend.spellCheck).mockResolvedValue({language: 'en-US', issues: [[]]});
    const s = spelling();
    await s.run(['one']);
    await s.run(['two']);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatch(/en-GB isn’t installed.*en-US is being used/);
  });

  it('shows misspellings, but not words in the book’s dictionary', () => {
    dictionary.add('Anna');
    expect(spelling().visible(found('teh'))).toBe(true);
    expect(spelling().visible(found('Anna'))).toBe(false);
  });

  it('hides an ignored word everywhere until Strand closes', () => {
    const s = spelling();
    s.ignore('teh', fakeView);
    expect(s.visible(found('teh'))).toBe(false);
    expect(fakeView.dispatch).toHaveBeenCalled(); // redrawn
  });

  it('always shows a repeated word, even if it’s a dictionary word', () => {
    dictionary.add('the');
    expect(spelling().visible(found('the', 'delete'))).toBe(true);
  });

  it('asks the spell checker for suggestions in the book’s language', async () => {
    vi.mocked(backend.spellSuggest).mockResolvedValue(['the']);
    expect(await spelling().suggestions('teh')).toEqual(['the']);
    expect(backend.spellSuggest).toHaveBeenCalledWith('en-GB', 'teh');
  });
});
