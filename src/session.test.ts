import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Backend} from './backend';
import {compose, type Project} from './model';
import {AUTOSAVE_DELAY, Session} from './session';
import {book, prose} from './testing/book';
import {parse} from './testing/editor';

/** A backend that keeps "files" in memory and answers dialogs with whatever the test sets. */
function fakeBackend() {
  const files = new Map<string, Project>(), exported = new Map<string, string>();
  const answers = {saveAs: 'book.strand' as string | null, open: 'other.strand' as string | null, exportTo: 'book.md' as string | null};
  const backend = {
    saveProject: vi.fn(async (path: string, project: Project) => { files.set(path, structuredClone(project)); }),
    loadProject: vi.fn(async (path: string) => structuredClone(files.get(path)!)),
    exportMarkdown: vi.fn(async (path: string, text: string) => { exported.set(path, text); }),
    chooseProjectToOpen: vi.fn(async () => answers.open),
    chooseProjectSaveAs: vi.fn(async () => answers.saveAs),
    chooseMarkdownExport: vi.fn(async () => answers.exportTo),
    spellCheck: vi.fn(), spellSuggest: vi.fn(), grammarCheck: vi.fn(), readClipboard: vi.fn(), writeClipboard: vi.fn(),
  } as unknown as Backend;
  return {backend, files, exported, answers};
}

function setUp(project = book({Root: 'Before {{Middle}} after.', Middle: 'inside'}), path: string | null = null) {
  const fake = fakeBackend(), hooks = {changed: vi.fn(), message: vi.fn()};
  const session = new Session(fake.backend, hooks, project);
  if (path) session.reset(project, path);
  return {session, hooks, ...fake};
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('keeping the project in step with the editor', () => {
  it('writes edited text back into each node', () => {
    const {session} = setUp();
    session.editorText = () => parse('Before [Middle:inside out] after.').doc;
    session.sync();
    expect(prose(session.project, 'Middle')).toBe('inside out');
  });

  it('adds scenes created in the editor, with their titles', () => {
    const {session} = setUp();
    session.titles.set('New', 'Fresh scene');
    session.editorText = () => parse('Before [Middle:inside] after. [New:fresh] [Nameless:]').doc;
    session.sync();
    expect(prose(session.project, 'Root')).toBe('Before {{Middle}} after. {{New}} {{Nameless}}');
    expect(session.project.nodes.find(n => n.id === 'New')?.title).toBe('Fresh scene');
    expect(session.project.nodes.find(n => n.id === 'Nameless')?.title).toBe('Untitled');
  });

  it('drops scenes deleted in the editor, but remembers their titles for undo', () => {
    const {session} = setUp();
    session.editorText = () => 'Before  after.';
    session.sync();
    expect(session.project.nodes.map(n => n.id)).toEqual(['Root']);
    expect(session.titles.get('Middle')).toBe('Middle');
  });

  it('with a scene open, only touches that scene and what’s inside it', () => {
    const {session} = setUp(book({Root: '{{A}} {{B}}', A: 'a', B: 'b'}));
    session.open('A');
    session.editorText = () => 'a changed';
    session.sync();
    expect(prose(session.project, 'A')).toBe('a changed');
    expect(prose(session.project, 'B')).toBe('b');
    expect(prose(session.project, 'Root')).toBe('{{A}} {{B}}');
  });

  it('keeps word counts up to date', () => {
    const {session} = setUp();
    session.editorText = () => parse('one two [Middle:three four five]').doc;
    session.sync();
    expect(session.totals.get('Root')).toEqual({own: 2, total: 5});
  });

  it('refuses an invalid project', () => {
    const {session} = setUp();
    expect(() => session.reset(book({Root: '{{Ghost}}'}), null)).toThrow();
  });
});

describe('saving', () => {
  it('doesn’t autosave a project that has never been saved', async () => {
    const {session, backend} = setUp();
    session.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY * 2);
    expect(backend.saveProject).not.toHaveBeenCalled();
    expect(session.unsaved).toBe(true);
    expect(session.saved).toBe(false);
  });

  it('autosaves shortly after the last change, once', async () => {
    const {session, backend, files} = setUp(undefined, 'book.strand');
    session.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY / 2);
    session.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY / 2);
    expect(backend.saveProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY);
    expect(backend.saveProject).toHaveBeenCalledTimes(1);
    expect(compose(files.get('book.strand')!)).toBe('Before inside after.');
    expect(session.saved).toBe(true);
  });

  it('saves the text as it is in the editor', async () => {
    const {session, files} = setUp(undefined, 'book.strand');
    session.editorText = () => parse('Before [Middle:changed] after.').doc;
    session.changed();
    await session.flush();
    expect(prose(files.get('book.strand')!, 'Middle')).toBe('changed');
  });

  it('includes the dictionary and settings', async () => {
    const {session, files} = setUp(undefined, 'book.strand');
    session.addWord('Anna');
    session.setRule('SentenceCapitalization', false);
    await session.flush();
    expect(files.get('book.strand')).toMatchObject({words: ['Anna'], settings: {grammar: true, grammarOffRules: ['SentenceCapitalization']}});
  });

  it('keeps saves in order', async () => {
    const {session, backend, files} = setUp(undefined, 'book.strand');
    let release!: () => void;
    const order: string[] = [];
    vi.mocked(backend.saveProject).mockImplementationOnce(async (path, project) => {
      await new Promise<void>(r => { release = r; });
      order.push(prose(project, 'Middle'));
      files.set(path, project);
    });
    session.editorText = () => parse('Before [Middle:first] after.').doc;
    session.changed();
    const first = session.flush();
    session.editorText = () => parse('Before [Middle:second] after.').doc;
    session.changed();
    const second = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first']);
    expect(prose(files.get('book.strand')!, 'Middle')).toBe('second');
  });

  it('Save as asks where, then saves there', async () => {
    const {session, files, answers} = setUp();
    answers.saveAs = 'chosen.strand';
    expect(await session.saveAs()).toBe(true);
    expect(session.path).toBe('chosen.strand');
    expect(files.has('chosen.strand')).toBe(true);
    expect(session.saved).toBe(true);
  });

  it('Save as can be cancelled', async () => {
    const {session, files, answers} = setUp();
    answers.saveAs = null;
    expect(await session.saveAs()).toBe(false);
    expect(session.path).toBeNull();
    expect(files.size).toBe(0);
  });

  it('a save that finishes after switching to another file doesn’t mark that file saved', async () => {
    const {session, backend, files} = setUp(undefined, 'a.strand');
    let release!: () => void;
    vi.mocked(backend.saveProject).mockImplementationOnce(async (path, project) => {
      await new Promise<void>(r => { release = r; });
      files.set(path, project);
    });
    session.changed();
    const pending = session.flush(); // slow save to a.strand
    await vi.advanceTimersByTimeAsync(0);
    session.reset(book({Other: 'other text'}), 'b.strand'); // another book opened meanwhile
    session.changed(); // ...and edited
    release();
    await pending;
    expect(session.path).toBe('b.strand');
    expect(session.saved).toBe(false);
    expect(files.has('a.strand')).toBe(true);
  });

  it('Save asks where the first time', async () => {
    const {session, backend, files} = setUp();
    await session.save();
    expect(backend.chooseProjectSaveAs).toHaveBeenCalledTimes(1);
    expect(files.has('book.strand')).toBe(true);
  });

  it('Save asks where only the first time', async () => {
    const {session, backend} = setUp(undefined, 'book.strand');
    session.changed();
    await session.save();
    expect(backend.chooseProjectSaveAs).not.toHaveBeenCalled();
    expect(backend.saveProject).toHaveBeenCalledTimes(1);
  });

  it('tells whether switching projects would lose anything', async () => {
    const unsaved = setUp();
    expect(await unsaved.session.settle()).toBe(true); // nothing changed yet
    unsaved.session.changed();
    expect(await unsaved.session.settle()).toBe(false);
    const saved = setUp(undefined, 'book.strand');
    saved.session.changed();
    expect(await saved.session.settle()).toBe(true);
    expect(saved.backend.saveProject).toHaveBeenCalled();
  });

  it('tells the screen when something changed', async () => {
    const {session, hooks} = setUp(undefined, 'book.strand');
    session.changed();
    expect(hooks.changed).toHaveBeenCalledTimes(1);
    await session.flush();
    expect(hooks.changed).toHaveBeenCalledTimes(2); // now saved
  });

  it('reports a failed autosave', async () => {
    const {session, backend, hooks} = setUp(undefined, 'book.strand');
    vi.mocked(backend.saveProject).mockRejectedValueOnce('disk full');
    session.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY);
    expect(hooks.message).toHaveBeenCalledWith('Save failed: disk full');
  });
});

describe('opening and exporting', () => {
  it('opens a project file and starts afresh with it', async () => {
    const {session, files} = setUp();
    files.set('other.strand', book({Top: 'other {{Scene}}', Scene: 'x'}, {words: ['Zog']}));
    session.titles.set('Old', 'Old title');
    expect(await session.openFile()).toBe(true);
    expect(session.path).toBe('other.strand');
    expect(session.openId).toBe('Top');
    expect(session.titles.has('Old')).toBe(false);
    expect(session.accepts('Zog')).toBe(true);
    expect(session.unsaved).toBe(false);
  });

  it('opening can be cancelled', async () => {
    const {session, answers} = setUp();
    answers.open = null;
    expect(await session.openFile()).toBe(false);
    expect(session.openId).toBe('Root');
  });

  it('exports the whole book as Markdown', async () => {
    const {session, exported} = setUp(book({Root: 'Before {{Middle}} after.', Middle: 'inside'}));
    session.open('Middle');
    session.editorText = () => 'inside, edited';
    await session.exportMarkdown();
    expect(exported.get('book.md')).toBe('Before inside, edited after.');
  });

  it('exporting can be cancelled', async () => {
    const {session, exported, answers, backend} = setUp();
    answers.exportTo = null;
    await session.exportMarkdown();
    expect(backend.exportMarkdown).not.toHaveBeenCalled();
    expect(exported.size).toBe(0);
  });
});

describe('the book’s dictionary and settings', () => {
  it('adds a word once', () => {
    const {session} = setUp();
    expect(session.addWord('cagthrs')).toBe(true);
    expect(session.addWord('cagthrs')).toBe(false);
    expect(session.project.words).toEqual(['cagthrs']);
  });

  it('accepts a dictionary word with a capital, as at the start of a sentence', () => {
    const {session} = setUp();
    session.addWord('cagthrs');
    expect(session.accepts('Cagthrs')).toBe(true);
    expect(session.accepts('other')).toBe(false);
  });

  it('turns grammar rules off and on again', () => {
    const {session} = setUp();
    session.setRule('A', false);
    session.setRule('B', false);
    session.setRule('A', false);
    expect(session.project.settings.grammarOffRules).toEqual(['A', 'B']);
    session.setRule('A', true);
    session.setRule('Unknown', true); // mustn't remove anything else
    expect(session.project.settings.grammarOffRules).toEqual(['B']);
  });

  it('switches grammar for the book', () => {
    const {session} = setUp();
    session.setGrammar(false);
    expect(session.project.settings.grammar).toBe(false);
    expect(session.unsaved).toBe(true);
  });

  it('renames a node', () => {
    const {session} = setUp();
    session.setTitle('Middle', 'The Middle');
    expect(session.project.nodes.find(n => n.id === 'Middle')?.title).toBe('The Middle');
    expect(session.titles.get('Middle')).toBe('The Middle');
  });

  it('moves a node in the stored model', () => {
    const {session} = setUp(book({Root: '{{A}}\n\n{{B}}', A: 'a', B: 'b'}));
    session.move('B', 'A', 'inside');
    expect(prose(session.project, 'A')).toBe('a\n\n{{B}}');
    expect(session.totals.get('A')).toEqual({own: 1, total: 2});
  });
});
