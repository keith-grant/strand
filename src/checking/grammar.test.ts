import type {EditorView} from '@codemirror/view';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {backend} from '../backend';
import {parse} from '../testing/editor';
import type {Found} from './checker';
import {Grammar, type GrammarIssue, dialogue, plainMessage, ruleName, sentenceAround} from './grammar';

vi.mock('../backend', () => ({backend: {grammarCheck: vi.fn()}}));

const quoted = (text: string) => dialogue(text).map(([a, b]) => text.slice(a, b));

describe('dialogue', () => {
  it('finds speech in curly and straight double quotes', () => {
    expect(quoted('“Hello,” she said.')).toEqual(['“Hello,”']);
    expect(quoted('"Hello," she said. "Bye."')).toEqual(['"Hello,"', '"Bye."']);
  });
  it('finds speech in curly and straight single quotes', () => {
    expect(quoted('‘Quiet,’ he whispered.')).toEqual(['‘Quiet,’']);
    expect(quoted("'Quiet,' he whispered.")).toEqual(["'Quiet,'"]);
  });
  it('tells apostrophes from quotes', () => {
    expect(quoted('I don’t know. It’s fine.')).toEqual([]);
    expect(quoted("I don't know. It's fine.")).toEqual([]);
    expect(quoted("the neighbours' gardens")).toEqual([]);
  });
  it('keeps quotes inside quotes as one stretch', () => {
    expect(quoted('“She said ‘no’ and left,” he said.')).toEqual(['“She said ‘no’ and left,”']);
  });
  it('runs speech left open to the end of the paragraph', () => {
    expect(quoted('He said, “And then I left')).toEqual(['“And then I left']);
  });
  it('mistakes a leading apostrophe for an opening quote (known limitation)', () => {
    expect(quoted("'cause I said so")).toEqual(["'cause I said so"]);
  });
  it('finds no dialogue in plain narration', () => {
    expect(quoted('A girl lives in the house at the end of our street.')).toEqual([]);
  });
});

describe('sentenceAround', () => {
  const sentence = (text: string, at: number) => text.slice(...sentenceAround(text, at));

  it('finds the sentence around a position', () => {
    const text = 'One. Two three. Four';
    expect(sentence(text, text.indexOf('three'))).toBe(' Two three.');
    expect(sentence(text, 0)).toBe('One.');
    expect(sentence(text, text.length)).toBe(' Four');
  });
  it('right after a full stop, starts a new sentence', () => {
    expect(sentence('Done.', 5)).toBe('');
  });
});

describe('presentation', () => {
  it('turns rule names into words', () => {
    expect(ruleName('SentenceCapitalization')).toBe('Sentence capitalization');
    expect(ruleName('PronounVerbAgreement')).toBe('Pronoun verb agreement');
  });
  it('removes Markdown from messages', () => {
    expect(plainMessage('Use `have` rather than **of**.')).toBe('Use have rather than of.');
  });
});

// ---- The Grammar checker's own logic (the parts that don't need a live editor) ----

class TestGrammar extends Grammar {
  run(paragraphs: string[]) { return this.check(paragraphs); }
  visible(found: Found<GrammarIssue>) { return this.shows(found); }
  typing(found: Found<GrammarIssue>, at: number) { return this.stillTyping(found, at); }
  on() { return this.active(); }
}

const issue = (start: number, length: number, rule = 'AnA'): GrammarIssue =>
  ({start, length, rule, kind: 'Miscellaneous', message: 'Incorrect indefinite article.', fixes: ['an']});

/** A result as the checker sees it: `text` marked in paragraph `line`, which starts at `lineFrom` in the document. */
function found(line: string, text: string, rule = 'AnA', lineFrom = 0): Found<GrammarIssue> {
  const start = line.indexOf(text);
  return {from: lineFrom + start, to: lineFrom + start + text.length, text, issue: issue(start, text.length, rule), line, lineFrom};
}

describe('Grammar', () => {
  const settings = {enabled: true, off: [] as string[]};
  const grammar = () => new TestGrammar({enabled: () => settings.enabled, ruleOff: rule => settings.off.includes(rule), report: vi.fn()});
  const fakeView = {dispatch: vi.fn()} as unknown as EditorView;

  beforeEach(() => {
    settings.enabled = true;
    settings.off = [];
    vi.mocked(backend.grammarCheck).mockReset();
  });

  it('sends paragraphs without scene markers, and maps the results back into the editor text', async () => {
    const line = parse('Before [M:a apple] after').doc;
    vi.mocked(backend.grammarCheck).mockResolvedValue([[issue('Before '.length, 1)]]);
    const [[result]] = await grammar().run([line]);
    expect(backend.grammarCheck).toHaveBeenCalledWith(['Before a apple after']);
    expect(line.slice(result.start, result.start + result.length)).toBe('a');
    expect(result.start).toBe(line.indexOf('a apple'));
  });

  it('follows the book’s grammar switch', () => {
    const g = grammar();
    expect(g.on()).toBe(true);
    settings.enabled = false;
    expect(g.on()).toBe(false);
  });

  it('shows a problem in narration', () => {
    expect(grammar().visible(found('He took a apple.', 'a'))).toBe(true);
  });

  it('hides problems from rules turned off for the book', () => {
    settings.off = ['AnA'];
    expect(grammar().visible(found('He took a apple.', 'a'))).toBe(false);
  });

  it('hides problems inside dialogue, but not the narration around it', () => {
    const line = '“He took a apple,” she said, a odd thing.';
    expect(grammar().visible(found(line, 'a apple'))).toBe(false);
    expect(grammar().visible(found(line, 'a odd'))).toBe(true);
  });

  it('hides an ignored spot until Strand closes, and only that spot', () => {
    const g = grammar(), line = 'He took a apple and a orange.';
    g.ignore(found(line, 'a apple'), fakeView);
    expect(g.visible(found(line, 'a apple'))).toBe(false);
    expect(g.visible(found(line, 'a orange'))).toBe(true);
    expect(fakeView.dispatch).toHaveBeenCalled(); // redrawn
  });

  it('holds back problems in the sentence being typed', () => {
    const g = grammar(), line = 'He took a apple. She took a egg';
    expect(g.typing(found(line, 'a egg'), line.length)).toBe(true);
    expect(g.typing(found(line, 'a apple'), line.length)).toBe(false);
  });

  it('doesn’t hold anything back when typing in another paragraph', () => {
    const line = 'He took a apple.';
    expect(grammar().typing(found(line, 'a', 'AnA', 100), 10)).toBe(false);
    expect(grammar().typing(found(line, 'a', 'AnA', 0), 500)).toBe(false);
  });
});
