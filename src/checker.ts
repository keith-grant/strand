/*
 * Shared machinery for checks that run paragraph by paragraph (spelling, grammar).
 *
 * Each paragraph (editor line) is checked as a whole and the result cached by its text, so unchanged paragraphs are
 * never checked twice and scrolling back is free. Only the part of the document CodeMirror has laid out (what's on
 * screen plus a margin) is checked; the rest gets checked as it scrolls into view. While the author is typing, marks
 * near the cursor are held back until the cursor moves away.
 *
 * Subclasses say how to check a batch of paragraphs and which results to show.
 */
import {StateEffect, type EditorState, type Extension, type Range} from '@codemirror/state';
import {Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate} from '@codemirror/view';

export interface Span { start: number; length: number }
export interface Found<I extends Span> {
  from: number;
  to: number;
  /** The marked text. */
  text: string;
  issue: I;
  /** The whole paragraph the issue is in, and where it starts in the document. */
  line: string;
  lineFrom: number;
}

/** Tells every checker to redraw and check anything new, e.g. after results arrive or a setting changes. */
const recheck = StateEffect.define<null>();
const BATCH = 200, CACHE_LIMIT = 20000;

export abstract class ParagraphChecker<I extends Span> {
  private cache = new Map<string, I[]>(); // paragraph text, exactly as in the editor → issues
  private pending = new Set<string>();
  private reported = '';
  readonly extension: Extension;

  constructor(markClass: string, private readonly reportMessage: (text: string) => void) {
    const checker = this, mark = Decoration.mark({class: markClass});
    this.extension = ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      /** Where the author is typing. */
      typingAt = -1;
      timer: number | undefined;

      constructor(readonly view: EditorView) {
        this.decorations = checker.marks(view, mark, -1);
        this.schedule(0);
      }

      update(u: ViewUpdate) {
        if (u.transactions.some(tr => tr.isUserEvent('input.type') || tr.isUserEvent('delete'))) this.typingAt = u.state.selection.main.head;
        else if (u.selectionSet) this.typingAt = -1;
        else if (u.docChanged && this.typingAt >= 0) this.typingAt = u.changes.mapPos(this.typingAt);
        const asked = u.transactions.some(tr => tr.effects.some(e => e.is(recheck)));
        if (u.docChanged || u.viewportChanged || u.selectionSet || asked)
          // Paragraphs being edited keep their old marks (shifted) until their new text has been checked.
          this.decorations = checker.marks(u.view, mark, this.typingAt, this.decorations.map(u.changes));
        if (u.docChanged || u.viewportChanged || asked) this.schedule(u.docChanged ? 400 : asked ? 0 : 100);
      }

      schedule(delay: number) {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => checker.checkVisible(this.view), delay);
      }

      destroy() { window.clearTimeout(this.timer); }
    }, {decorations: v => v.decorations});
  }

  /** Check a batch of paragraphs (editor text, which may contain scene markers): one result list per paragraph. */
  protected abstract check(paragraphs: string[]): Promise<I[][]>;
  /** Whether this check is switched on. */
  protected active() { return true; }
  /** Whether to show a result, e.g. not a dictionary word. */
  protected shows(_found: Found<I>) { return true; }
  /** Whether a result is held back because the author is still typing at `typingAt`. */
  protected stillTyping(found: Found<I>, typingAt: number) { return found.from <= typingAt && typingAt <= found.to; }

  private foundIn(state: EditorState, pos: number): Found<I>[] | undefined {
    const line = state.doc.lineAt(pos), issues = this.cache.get(line.text);
    if (!issues) return undefined;
    return issues
      .map(issue => {
        const from = line.from + issue.start, to = from + Math.max(1, issue.length);
        return {from, to: Math.min(to, line.to), text: state.sliceDoc(from, to), issue, line: line.text, lineFrom: line.from};
      })
      .filter(f => this.shows(f));
  }

  private marks(view: EditorView, mark: Decoration, typingAt: number, previous?: DecorationSet): DecorationSet {
    if (!this.active()) return Decoration.none;
    const ranges: Range<Decoration>[] = [], {from, to} = view.viewport, doc = view.state.doc;
    for (let pos = from; pos <= to && pos <= doc.length;) {
      const line = doc.lineAt(pos), found = this.foundIn(view.state, line.from);
      if (found) {
        for (const f of found) if (f.to > f.from && !this.stillTyping(f, typingAt)) ranges.push(mark.range(f.from, f.to));
      } else {
        previous?.between(line.from, line.to, (a, b) => { if (b > a && !(a <= typingAt && typingAt <= b)) ranges.push(mark.range(a, b)); });
      }
      pos = line.to + 1;
    }
    return Decoration.set(ranges, true);
  }

  /** Check every laid-out paragraph that hasn't been checked in its current form. */
  private async checkVisible(view: EditorView) {
    if (!this.active()) return;
    const texts: string[] = [], {from, to} = view.viewport, doc = view.state.doc;
    for (let pos = from; pos <= to && pos <= doc.length;) {
      const text = doc.lineAt(pos).text;
      if (text.trim() && !this.cache.has(text) && !this.pending.has(text)) texts.push(text);
      pos = doc.lineAt(pos).to + 1;
    }
    if (!texts.length) return;
    if (this.cache.size > CACHE_LIMIT) this.cache.clear();
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      batch.forEach(t => this.pending.add(t));
      try {
        const results = await this.check(batch);
        batch.forEach((t, j) => this.cache.set(t, results[j] ?? []));
      } catch (e) {
        this.report(String(e));
      } finally {
        batch.forEach(t => this.pending.delete(t));
      }
      view.dispatch({effects: recheck.of(null)});
    }
  }

  /** Show a message in the status bar, but not the same one over and over. */
  protected report(message: string) {
    if (message === this.reported) return;
    this.reported = message;
    this.reportMessage(message);
  }

  /** The problem at a position, if any (whether or not it's currently marked). */
  issueAt(state: EditorState, pos: number): Found<I> | null {
    if (!this.active()) return null;
    return this.foundIn(state, pos)?.find(f => f.from <= pos && pos <= f.to) ?? null;
  }

  /** Redraw the marks, e.g. after a setting changed. */
  redraw(view: EditorView) {
    view.dispatch({effects: recheck.of(null)});
  }
}
