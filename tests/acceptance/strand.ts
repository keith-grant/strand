/*
 * Drives the app for the acceptance tests. Fixture steps build a project here and load it into the app; actions go
 * through the real UI (keyboard, right-click menu, margin titles, tree); assertions read the live model through the
 * app's test hooks (window.__strand, see src/testing/hooks.ts).
 */
import {expect, type Locator, type Page} from '@playwright/test';
import {compose, type NarrativeNode, type Project, reference} from '../../src/model';
import type {StrandHooks} from '../../src/testing/hooks';

type Hooks = StrandHooks;
type HookName = {[K in keyof Hooks]: Hooks[K] extends (...args: never[]) => unknown ? K : never}[keyof Hooks];

/** Menu wording in the feature files, where it names an action rather than the app's own label. */
const MENU_LABELS: Record<string, string> = {
  'Create child from selection': 'New scene',
  'Insert child here': 'New scene',
};

export class Strand {
  /** The project being built by fixture steps, and the file it's saved in (null = never saved). */
  private draft: Project | null = null;
  private path: string | null = null;
  /** The state just before the scenario's first action, for "unchanged" checks. */
  baseline: {composed: string; project: Project} | null = null;
  /** Positions in the composed manuscript remembered by steps, e.g. where a selection was. */
  readonly remembered = new Map<string, number>();
  /** Node ids remembered by title, e.g. to check identity survives a save. */
  readonly rememberedIds = new Map<string, string>();

  constructor(readonly page: Page) {}

  async start() {
    await this.page.goto('/');
    await this.page.waitForFunction(() => '__strand' in window);
  }

  /** Call one of the app's test hooks. */
  call<K extends HookName>(name: K, ...args: Parameters<Extract<Hooks[K], (...a: never[]) => unknown>>): Promise<ReturnType<Extract<Hooks[K], (...a: never[]) => unknown>>> {
    return this.page.evaluate(([n, a]) => {
      const hooks = (window as unknown as {__strand: Record<string, (...x: unknown[]) => unknown>}).__strand;
      return hooks[n](...a);
    }, [name, args] as [string, unknown[]]) as never;
  }

  /** Read the fake desktop side's state. */
  fake<T>(read: (fake: Hooks['fake']) => T): Promise<T> {
    return this.page.evaluate(`(${read.toString()})(window.__strand.fake)`) as Promise<T>;
  }

  // ---- Fixtures ----

  async newProject(rootTitle: string, saved: boolean) {
    const root = {id: crypto.randomUUID(), title: rootTitle, prose: ''};
    this.draft = {root: root.id, nodes: [root], words: [], settings: {grammar: true, grammarOffRules: []}};
    this.path = saved ? 'book.strand' : null;
    await this.reload();
  }

  private draftNode(title: string): NarrativeNode {
    const n = this.draft?.nodes.find(n => n.title === title);
    if (!n) throw Error(`The fixture has no node “${title}”`);
    return n;
  }

  private newChild(title: string) {
    const child = {id: crypto.randomUUID(), title, prose: ''};
    this.draft!.nodes.push(child);
    return reference(child.id);
  }

  async addChild(parent: string, child: string) {
    this.draftNode(parent).prose += this.newChild(child);
    await this.reload();
  }

  async addProse(title: string, text: string) {
    this.draftNode(title).prose += text;
    await this.reload();
  }

  /** Rows of kind | title | text: prose rows hold JSON-quoted text, scene rows a new empty child's title. */
  async setContent(title: string, rows: Record<string, string>[]) {
    this.draftNode(title).prose = rows.map(r => r.kind === 'prose' ? JSON.parse(r.text) as string : this.newChild(r.title)).join('');
    await this.reload();
  }

  private async reload() {
    await this.call('load', this.draft!, this.path);
  }

  // ---- Inspecting the model ----

  project() { return this.call('project'); }

  static node(project: Project, title: string): NarrativeNode {
    const n = project.nodes.find(n => n.title === title);
    if (!n) throw Error(`The project has no node “${title}”`);
    return n;
  }

  /** A node's own text: its prose without child references. */
  static owned(project: Project, title: string) {
    return Strand.node(project, title).prose.replace(/\{\{node:[A-Za-z0-9-]+\}\}/g, '');
  }

  static childTitles(project: Project, title: string) {
    return [...Strand.node(project, title).prose.matchAll(/\{\{node:([A-Za-z0-9-]+)\}\}/g)]
      .map(m => project.nodes.find(n => n.id === m[1])!.title);
  }

  async id(title: string) { return Strand.node(await this.project(), title).id; }

  async takeBaseline() {
    const project = await this.project();
    this.baseline = {composed: compose(project), project};
  }

  async scene(title: string) {
    const scene = await this.call('scene', await this.id(title));
    if (!scene) throw Error(`“${title}” isn’t in the open text`);
    return scene;
  }

  // ---- Editor positions (set-up; allowed to bypass the UI) ----

  private async textPosition(text: string, end = false) {
    const doc = await this.call('text'), i = doc.indexOf(text);
    if (i < 0) throw Error(`The editor doesn’t contain “${text}”`);
    return end ? i + text.length : i;
  }

  async select(from: number, to: number) {
    await this.call('select', from, to);
    this.remembered.set('selection', await this.call('composedOffset', from));
  }

  async selectText(text: string) {
    const from = await this.textPosition(text);
    await this.select(from, from + text.length);
  }

  async selectBetween(start: string, end: string) {
    await this.select(await this.textPosition(start), await this.textPosition(end, true));
  }

  async placeCaret(pos: number) {
    await this.call('select', pos);
    this.remembered.set('caret', await this.call('composedOffset', pos));
  }

  async caretAtNode(title: string, edge: 'start' | 'end', side: 'parent' | 'child') {
    if (await this.id(title) === await this.call('openId')) {
      return this.placeCaret(edge === 'start' ? 0 : (await this.call('text')).length);
    }
    const s = await this.scene(title);
    await this.placeCaret(edge === 'start' ? (side === 'parent' ? s.from : s.innerFrom) : (side === 'parent' ? s.to : s.innerTo));
  }

  async caretBetween(before: string, after: string) {
    const pos = await this.textPosition(before, true), doc = await this.call('text');
    if (!doc.slice(pos).trimStart().startsWith(after.trimStart())) throw Error(`“${after}” doesn’t follow “${before}”`);
    await this.placeCaret(pos);
  }

  // ---- Actions through the UI ----

  get editor(): Locator { return this.page.locator('.cm-content'); }

  treeRow(title: string): Locator {
    return this.page.locator('aside .tree-node').filter({has: this.page.locator('.name').getByText(title, {exact: true})});
  }

  async openNode(title: string) {
    await this.treeRow(title).click();
    await expect(this.page.getByLabel('Title', {exact: true})).toHaveValue(title);
  }

  async type(text: string) { await this.page.keyboard.type(text); }
  async press(key: string) { await this.page.keyboard.press(key); }

  /** Answer the naming box that appears for a new scene. */
  private async name(title?: string) {
    const box = this.page.locator('input.rename');
    await expect(box).toBeVisible();
    if (title !== undefined) await box.fill(title);
    await box.press('Enter');
    await expect(box).toHaveCount(0);
  }

  async newScene(title: string) {
    await this.press('Control+Shift+E');
    await this.name(title);
  }

  async split() {
    await this.press('Control+Shift+Enter');
    await this.name();
  }

  /** Right-click at the cursor, or inside the selection. */
  async openMenu() {
    if (await this.page.locator('.popup-menu').count()) await this.press('Escape');
    const {from, to} = await this.call('selection');
    const at = await this.call('coords', to > from ? from + 1 : from);
    if (!at) throw Error('The cursor isn’t on screen');
    await this.page.mouse.click(at.x, at.y, {button: 'right'});
    await expect(this.page.locator('.popup-menu')).toBeVisible();
  }

  menuItem(label: string): Locator {
    return this.page.locator('.popup-menu').getByRole('menuitem', {name: MENU_LABELS[label] ?? label, exact: true});
  }

  async chooseFromMenu(label: string) {
    await this.openMenu();
    await this.menuItem(label).click();
  }

  /** Merge `source` into `destination`, which must be the scene just before it. */
  async merge(source: string, destination: string) {
    const project = await this.project(), parent = project.nodes.find(n => Strand.childTitles(project, n.title).includes(source));
    const siblings = parent ? Strand.childTitles(project, parent.title) : [];
    if (siblings[siblings.indexOf(source) - 1] !== destination) throw Error(`Can only merge a scene into the one just before it`);
    await this.caretAtNode(source, 'start', 'child');
    await this.chooseFromMenu('Merge with previous');
  }

  async mergeIntoParent(title: string) {
    await this.caretAtNode(title, 'start', 'child');
    await this.chooseFromMenu('Merge with parent');
  }

  /** A scene's title in the margin. */
  async label(title: string): Promise<Locator> {
    return this.page.locator(`.cm-scene-label[data-id="${await this.id(title)}"]`);
  }

  /** Collapse or expand a scene with the toggle beside its margin title. */
  async toggle(title: string) {
    await (await this.label(title)).locator('.toggle').click();
  }

  async moveInTree(title: string, destination: string) {
    await this.treeRow(title).dragTo(this.treeRow(destination));
  }

  async setFake(change: string) {
    await this.page.evaluate(`(${change})(window.__strand.fake)`);
  }

  async save() { await this.press('Control+s'); }

  async close() { await this.page.getByRole('button', {name: 'New', exact: true}).click(); }

  async reopen() {
    await this.setFake(`f => { f.dialogs.open = 'book.strand'; }`);
    await this.page.getByRole('button', {name: 'Open', exact: true}).click();
    await expect(this.page.getByRole('status')).toContainText('book.strand');
  }

  /** The fake disk's project files, as text, to compare before and after something. */
  filesBeforeExport = '';
  savedFiles(): Promise<string> {
    return this.fake(f => JSON.stringify([...f.files]));
  }

  async exportMarkdown() {
    await this.page.getByRole('button', {name: 'Export Markdown', exact: true}).click();
    await expect.poll(() => this.fake(f => f.exported.has('book.md'))).toBe(true);
  }
}
