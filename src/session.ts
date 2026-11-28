/*
 * The open book: the stored project, which node is open, autosave, and the book's titles, dictionary and settings.
 * Keeps the project in step with the editor's text. No DOM here, so it can be unit-tested with a fake backend.
 */
import type {Backend} from './backend';
import {expand, serialize} from './editor/markers';
import {type Place, type Project, type WordTotals, compose, newProject, node, place, subtree, validate, wordTotals} from './model';

export interface SessionHooks {
  /** Something the screen shows changed: structure, titles, word counts or saved state. */
  changed(): void;
  message(text: string): void;
}

export const AUTOSAVE_DELAY = 800;

export class Session {
  project!: Project;
  path: string | null = null;
  openId!: string;
  /** Titles of every node seen this session. Deleted scenes stay here so undo can bring them back with their names. */
  readonly titles = new Map<string, string>();
  /** The book's spelling dictionary, as a set for quick lookups. Kept in step with `project.words`. */
  dictionary = new Set<string>();
  totals!: WordTotals;
  /** Where the open node's current text comes from: the editor, once there is one. */
  editorText: () => string = () => expand(this.project, this.openId);

  private revision = 0;
  private savedRevision = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly backend: Backend, private readonly hooks: SessionHooks, project = newProject()) {
    this.reset(project, null);
  }

  /** Saved to a file, with nothing changed since. */
  get saved() { return this.revision === this.savedRevision && !!this.path; }
  /** Changes that aren't in any file yet. */
  get unsaved() { return this.revision !== this.savedRevision; }

  /** Switch to another project (already loaded from `path`, or new if path is null). */
  reset(project: Project, path: string | null) {
    validate(project);
    clearTimeout(this.saveTimer);
    this.project = project;
    this.path = path;
    this.openId = project.root;
    this.revision = this.savedRevision = 0;
    this.dictionary = new Set(project.words);
    this.titles.clear();
    for (const n of project.nodes) this.titles.set(n.id, n.title);
    this.totals = wordTotals(project);
  }

  /** Write the editor's text back into the project: the opened node's prose plus every scene inside it. */
  sync() {
    const prose = serialize(this.editorText(), this.openId);
    const replaced = new Set(subtree(this.project, this.openId));
    replaced.delete(this.openId);
    const nodes = this.project.nodes.filter(n => !replaced.has(n.id));
    node(this.project, this.openId).prose = prose.get(this.openId) ?? '';
    for (const [id, text] of prose) if (id !== this.openId) nodes.push({id, title: this.titles.get(id) ?? 'Untitled', prose: text});
    this.project.nodes = nodes;
    this.totals = wordTotals(this.project);
  }

  /** Make another node the one the editor shows. The caller then loads its text into the editor. */
  open(id: string) {
    this.sync();
    this.openId = id;
  }

  /** Record a change, and autosave shortly if the book has a file. */
  changed() {
    this.revision++;
    clearTimeout(this.saveTimer);
    if (this.path) this.saveTimer = setTimeout(() => { this.flush().catch(e => this.hooks.message('Save failed: ' + String(e))); }, AUTOSAVE_DELAY);
    this.hooks.changed();
  }

  /** Save now, if there's a file and anything to save. Saves are queued so they reach the file in order. */
  async flush() {
    clearTimeout(this.saveTimer);
    if (!this.path || this.revision === this.savedRevision) return;
    this.sync();
    const snapshot = structuredClone(this.project), dest = this.path, rev = this.revision;
    const task = this.writes.catch(() => {}).then(() => this.backend.saveProject(dest, snapshot));
    this.writes = task;
    await task;
    if (this.path === dest) {
      this.savedRevision = rev;
      this.hooks.changed();
    }
  }

  /** Ask for a file and save there. False if cancelled. */
  async saveAs() {
    const dest = await this.backend.chooseProjectSaveAs();
    if (!dest) return false;
    await this.writes.catch(() => {});
    this.path = dest;
    this.revision++;
    await this.flush();
    return true;
  }

  save() { return this.path ? this.flush().then(() => true) : this.saveAs(); }

  /** Save what can be saved. True if nothing would be lost by switching to another project. */
  async settle() {
    if (this.path) await this.flush();
    return !!this.path || !this.unsaved;
  }

  /** Ask for a project file and load it. False if cancelled. */
  async openFile() {
    const path = await this.backend.chooseProjectToOpen();
    if (!path) return false;
    this.reset(await this.backend.loadProject(path), path);
    return true;
  }

  /** Ask for a file and export the whole book there as Markdown. */
  async exportMarkdown() {
    this.sync();
    const dest = await this.backend.chooseMarkdownExport();
    if (dest) await this.backend.exportMarkdown(dest, compose(this.project));
  }

  setTitle(id: string, value: string) {
    this.titles.set(id, value);
    const n = this.project.nodes.find(n => n.id === id);
    if (n) n.title = value;
    this.changed();
  }

  /** Add a word to the book's dictionary. False if it was already there. */
  addWord(word: string) {
    if (this.dictionary.has(word)) return false;
    this.dictionary.add(word);
    this.project.words.push(word);
    this.changed();
    return true;
  }

  accepts(word: string) { return this.dictionary.has(word) || this.dictionary.has(word.toLowerCase()); }

  setGrammar(on: boolean) {
    this.project.settings.grammar = on;
    this.changed();
  }

  /** Turn a grammar rule on or off for this book. */
  setRule(rule: string, on: boolean) {
    const rules = this.project.settings.grammarOffRules;
    if (on) { if (rules.includes(rule)) rules.splice(rules.indexOf(rule), 1); }
    else if (!rules.includes(rule)) rules.push(rule);
    this.changed();
  }

  /** Move a node in the stored model, for moves the editor can't make itself. Throws if the move is impossible. */
  move(id: string, target: string, where: Place) {
    this.sync();
    place(this.project, id, target, where);
    this.totals = wordTotals(this.project);
    this.changed();
  }
}
