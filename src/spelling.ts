/*
 * Spell checking for the editor. Text is checked by the operating system's spell checker on the Rust side; this
 * module decides what to check and draws the underlines.
 *
 * Each paragraph (editor line) is checked as a whole and the result cached by its text, so unchanged paragraphs are
 * never checked twice and scrolling back is free. Only the part of the document CodeMirror has laid out (what's on
 * screen plus a margin) is checked; the rest gets checked as it scrolls into view.
 */
import {invoke} from '@tauri-apps/api/core';
import {StateEffect, type EditorState, type Range} from '@codemirror/state';
import {Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate} from '@codemirror/view';
import {blankMarkers} from './scenes';

export interface Issue {
  start: number;
  length: number;
  /** suggest: misspelt. replace: a known slip with one fix ("teh" → "the"). delete: a repeated word. */
  action: 'suggest' | 'replace' | 'delete';
  replacement: string | null;
}
export interface Found { from: number; to: number; word: string; issue: Issue }

export interface SpellingOptions {
  language: string;
  /** Words the author has accepted (the book's dictionary). */
  accepted(word: string): boolean;
  report(message: string): void;
}

const resultsArrived = StateEffect.define<null>();
const underline = Decoration.mark({class: 'cm-misspelt'});
const BATCH = 200, CACHE_LIMIT = 20000;

export class Spelling {
  private cache = new Map<string, Issue[]>(); // paragraph text (markers blanked) → issues
  private pending = new Set<string>();
  private ignored = new Set<string>();       // "Ignore": this session only
  private reported = '';
  readonly extension;

  constructor(private readonly options: SpellingOptions) {
    const spelling = this;
    this.extension = ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      /** Where the author is typing: the word there isn't underlined until the cursor moves away. */
      typingAt = -1;
      timer: number | undefined;

      constructor(readonly view: EditorView) {
        this.decorations = spelling.underlines(view, -1);
        this.schedule(0);
      }

      update(u: ViewUpdate) {
        if (u.transactions.some(tr => tr.isUserEvent('input.type') || tr.isUserEvent('delete'))) this.typingAt = u.state.selection.main.head;
        else if (u.selectionSet) this.typingAt = -1;
        else if (u.docChanged && this.typingAt >= 0) this.typingAt = u.changes.mapPos(this.typingAt);
        const arrived = u.transactions.some(tr => tr.effects.some(e => e.is(resultsArrived)));
        if (u.docChanged || u.viewportChanged || u.selectionSet || arrived)
          // Paragraphs being edited keep their old underlines (shifted) until their new text has been checked.
          this.decorations = spelling.underlines(u.view, this.typingAt, this.decorations.map(u.changes));
        if (u.docChanged || u.viewportChanged) this.schedule(u.docChanged ? 400 : 100);
      }

      schedule(delay: number) {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => spelling.checkVisible(this.view), delay);
      }

      destroy() { window.clearTimeout(this.timer); }
    }, {decorations: v => v.decorations});
  }

  /** Words to leave alone: the book's dictionary plus anything ignored this session. */
  private accepted(word: string) {
    return this.ignored.has(word) || this.options.accepted(word);
  }

  private issuesFor(state: EditorState, lineFrom: number): Found[] | undefined {
    const line = state.doc.lineAt(lineFrom), issues = this.cache.get(blankMarkers(line.text));
    if (!issues) return undefined;
    return issues
      .map(issue => {
        const from = line.from + issue.start, to = from + issue.length;
        return {from, to, word: state.sliceDoc(from, to), issue};
      })
      .filter(f => f.issue.action === 'delete' || !this.accepted(f.word));
  }

  private underlines(view: EditorView, typingAt: number, previous?: DecorationSet): DecorationSet {
    const ranges: Range<Decoration>[] = [], {from, to} = view.viewport, doc = view.state.doc;
    const keep = (a: number, b: number) => !(typingAt >= a && typingAt <= b);
    for (let pos = from; pos <= to && pos <= doc.length;) {
      const line = doc.lineAt(pos), found = this.issuesFor(view.state, line.from);
      if (found) {
        for (const f of found) if (keep(f.from, f.to)) ranges.push(underline.range(f.from, f.to));
      } else {
        previous?.between(line.from, line.to, (a, b) => { if (b > a && keep(a, b)) ranges.push(underline.range(a, b)); });
      }
      pos = line.to + 1;
    }
    return Decoration.set(ranges, true);
  }

  /** Check every laid-out paragraph that hasn't been checked in its current form. */
  private async checkVisible(view: EditorView) {
    const texts: string[] = [], {from, to} = view.viewport, doc = view.state.doc;
    for (let pos = from; pos <= to && pos <= doc.length;) {
      const line = doc.lineAt(pos), text = blankMarkers(line.text);
      if (text.trim() && !this.cache.has(text) && !this.pending.has(text)) texts.push(text);
      pos = line.to + 1;
    }
    if (!texts.length) return;
    if (this.cache.size > CACHE_LIMIT) this.cache.clear();
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      batch.forEach(t => this.pending.add(t));
      try {
        const result = await invoke<{language: string; issues: Issue[][]}>('spell_check', {language: this.options.language, texts: batch});
        batch.forEach((t, j) => this.cache.set(t, result.issues[j]));
        if (result.language !== this.options.language)
          this.reportOnce(`The spell checker for ${this.options.language} isn’t installed in Windows, so ${result.language} is being used.`);
      } catch (e) {
        this.reportOnce('Spell checking isn’t working: ' + String(e));
      } finally {
        batch.forEach(t => this.pending.delete(t));
      }
      view.dispatch({effects: resultsArrived.of(null)});
    }
  }

  private reportOnce(message: string) {
    if (message === this.reported) return;
    this.reported = message;
    this.options.report(message);
  }

  /** The spelling problem at a position, if any (whether or not it's currently underlined). */
  issueAt(state: EditorState, pos: number): Found | null {
    return this.issuesFor(state, pos)?.find(f => f.from <= pos && pos <= f.to) ?? null;
  }

  async suggestions(word: string): Promise<string[]> {
    return invoke<string[]>('spell_suggest', {language: this.options.language, word});
  }

  ignore(word: string, view: EditorView) {
    this.ignored.add(word);
    this.redraw(view);
  }

  /** Redraw the underlines, e.g. after a word was added to the dictionary. */
  redraw(view: EditorView) {
    view.dispatch({effects: resultsArrived.of(null)});
  }
}
