/*
 * Spell checking: the operating system's spell checker on the Rust side (src-tauri/src/spelling.rs), with the
 * paragraph-by-paragraph checking and marking shared with grammar (checker.ts).
 */
import type {EditorView} from '@codemirror/view';
import {backend} from '../backend';
import {blankMarkers} from '../editor/markers';
import {ParagraphChecker, type Found} from './checker';

export interface SpellIssue {
  start: number;
  length: number;
  /** suggest: misspelt. replace: a known slip with one fix ("teh" → "the"). delete: a repeated word. */
  action: 'suggest' | 'replace' | 'delete';
  replacement: string | null;
}

export interface SpellingOptions {
  language: string;
  /** Words the author has accepted (the book's dictionary). */
  accepted(word: string): boolean;
  report(message: string): void;
}

export class Spelling extends ParagraphChecker<SpellIssue> {
  private ignored = new Set<string>(); // "Ignore": until Strand closes

  constructor(private readonly options: SpellingOptions) {
    super('cm-misspelt', options.report);
  }

  protected async check(paragraphs: string[]) {
    // Markers are blanked rather than removed, so positions in the results still match the editor text.
    const result = await backend.spellCheck(this.options.language, paragraphs.map(blankMarkers));
    if (result.language !== this.options.language)
      this.report(`The spell checker for ${this.options.language} isn’t installed in Windows, so ${result.language} is being used.`);
    return result.issues;
  }

  protected shows(found: Found<SpellIssue>) {
    return found.issue.action === 'delete' || !(this.ignored.has(found.text) || this.options.accepted(found.text));
  }

  async suggestions(word: string): Promise<string[]> {
    return backend.spellSuggest(this.options.language, word);
  }

  ignore(word: string, view: EditorView) {
    this.ignored.add(word);
    this.redraw(view);
  }
}
