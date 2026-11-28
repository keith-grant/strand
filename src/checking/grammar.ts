/*
 * Grammar checking: Harper on the Rust side (src-tauri/src/grammar.rs), with the paragraph-by-paragraph checking and
 * marking shared with spelling (checker.ts). Dialogue is never marked: characters speak ungrammatically on purpose.
 */
import type {EditorView} from '@codemirror/view';
import {backend} from '../backend';
import {withoutMarkers} from '../editor/markers';
import {ParagraphChecker, type Found} from './checker';

export interface GrammarIssue {
  start: number;
  length: number;
  /** Harper's rule name, e.g. "SentenceCapitalization". */
  rule: string;
  kind: string;
  message: string;
  /** Replacements for the marked text, best first; '' means remove it. */
  fixes: string[];
}

export interface GrammarOptions {
  /** Grammar checking switched on for this book. */
  enabled(): boolean;
  /** A rule turned off for this book. */
  ruleOff(rule: string): boolean;
  report(message: string): void;
}

export class Grammar extends ParagraphChecker<GrammarIssue> {
  private ignored = new Set<string>(); // "Ignore": these spots, until Strand closes

  constructor(private readonly options: GrammarOptions) {
    super('cm-grammar', options.report);
  }

  protected active() { return this.options.enabled(); }

  protected async check(paragraphs: string[]) {
    // Markers are removed rather than blanked, so they don't read as extra spaces; positions are mapped back.
    const prepared = paragraphs.map(withoutMarkers);
    const results = await backend.grammarCheck(prepared.map(p => p.text));
    return results.map((issues, i) => issues.map(issue => {
      const start = prepared[i].at(issue.start), end = prepared[i].at(issue.start + issue.length);
      return {...issue, start, length: end - start};
    }));
  }

  protected shows(found: Found<GrammarIssue>) {
    if (this.options.ruleOff(found.issue.rule) || this.ignored.has(ignoreKey(found))) return false;
    const a = found.from - found.lineFrom, b = found.to - found.lineFrom;
    return !dialogue(found.line).some(([s, e]) => a < e && b > s);
  }

  /** Hold back marks in the sentence being typed, not just the word. */
  protected stillTyping(found: Found<GrammarIssue>, typingAt: number) {
    const at = typingAt - found.lineFrom;
    if (at < 0 || at > found.line.length) return false;
    const [s, e] = sentenceAround(found.line, at);
    return found.from - found.lineFrom < e && found.to - found.lineFrom > s;
  }

  ignore(found: Found<GrammarIssue>, view: EditorView) {
    this.ignored.add(ignoreKey(found));
    this.redraw(view);
  }
}

const ignoreKey = (f: Found<GrammarIssue>) => JSON.stringify([f.issue.rule, f.from - f.lineFrom, f.line]);

/** "SentenceCapitalization" → "Sentence capitalization". */
export function ruleName(rule: string) {
  const words = rule.replace(/([a-z])([A-Z])/g, '$1 $2');
  return words[0] + words.slice(1).toLowerCase();
}

/** Harper's messages use a little Markdown; show them as plain text. */
export const plainMessage = (message: string) => message.replace(/\*\*|`/g, '');

/** The sentence around position `at` in a paragraph, as [start, end). */
export function sentenceAround(text: string, at: number): [number, number] {
  let s = at, e = at;
  while (s > 0 && !/[.!?]/.test(text[s - 1])) s--;
  while (e < text.length && !/[.!?]/.test(text[e])) e++;
  return [s, Math.min(text.length, e + 1)];
}

const BEFORE_OPENING = /[\s([{—–-]/, AFTER_CLOSING = /[\s.,;:!?)\]}—–-]/;
let lastLine = '', lastRanges: [number, number][] = [];

/** Stretches of dialogue in a paragraph: “…”, "…", ‘…’ and '…'. A quote left open runs to the end of the paragraph,
 *  as speech continuing into the next paragraph does. Single quotes are told apart from apostrophes by what's
 *  around them (an apostrophe in "don’t" has letters on both sides). */
export function dialogue(text: string): [number, number][] {
  if (text === lastLine) return lastRanges;
  const out: [number, number][] = [];
  let open: {at: number; double: boolean} | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], prev = i > 0 ? text[i - 1] : ' ', next = i + 1 < text.length ? text[i + 1] : ' ';
    if (!open) {
      if (c === '“' || (c === '"' && BEFORE_OPENING.test(prev))) open = {at: i, double: true};
      else if (c === '‘' || (c === "'" && BEFORE_OPENING.test(prev) && !/\s/.test(next))) open = {at: i, double: false};
    } else if (open.double ? c === '”' || c === '"' : (c === '’' || c === "'") && !/\s/.test(prev) && AFTER_CLOSING.test(next)) {
      out.push([open.at, i + 1]);
      open = null;
    }
  }
  if (open) out.push([open.at, text.length]);
  lastLine = text;
  lastRanges = out;
  return out;
}
