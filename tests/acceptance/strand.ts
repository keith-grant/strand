/*
 * Drives the app for the acceptance tests. Fixture steps build a project here and load it into the app. Actions are
 * real mouse and keyboard input: clicks and drags at points found on screen from the editor's visible text and scene
 * boundary marks, key presses, menus, margin titles and the tree. The app's test hooks (window.__strand, see
 * src/testing/hooks.ts) are only used to look: to check the outcome of a step, and for assertions.
 */
import {expect, type Locator, type Page} from '@playwright/test';
import {compose, type NarrativeNode, type Project, reference} from '../../src/model';
import type {StrandHooks} from '../../src/testing/hooks';

type Hooks = StrandHooks;
type HookName = {[K in keyof Hooks]: Hooks[K] extends (...args: never[]) => unknown ? K : never}[keyof Hooks];

type Point = {x: number; y: number};

/** Somewhere in the editor's visible text: its first character; the stretch from the start of `from` to the end of
 *  the next `to`; or just inside a scene's opening or closing boundary mark. */
type Spot = {first: true} | {from: string; to: string} | {scene: string; edge: 'start' | 'end'};

/**
 * Runs in the page. Screen points for clicking just before or just after characters of the editor's visible text, or
 * why there aren't any. Each point is a quarter of the way into its character, so the nearest gap between characters
 * is the intended one.
 */
function pointsOnScreen(spot: Spot): Point[] | string {
  const content = document.querySelector('.cm-content');
  if (!content) return 'There’s no editor';
  // The visible text, line by line, and the text nodes it's in. Widgets (boundary marks, collapsed scenes,
  // placeholders) aren't part of it.
  const pieces: {node: Text; start: number}[] = [];
  let text = '';
  content.querySelectorAll('.cm-line').forEach((line, i) => {
    if (i) text += '\n';
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
      if (!n.data || n.parentElement!.closest('[contenteditable="false"]')) continue;
      pieces.push({node: n, start: text.length});
      text += n.data;
    }
  });
  const point = (node: Text, offset: number, side: 'before' | 'after') => {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const r = range.getBoundingClientRect();
    return {x: side === 'before' ? r.left + r.width / 4 : r.right - r.width / 4, y: r.top + r.height / 2};
  };
  const at = (i: number, side: 'before' | 'after') => {
    const p = pieces.find(p => p.start <= i && i < p.start + p.node.data.length);
    return p && point(p.node, i - p.start, side);
  };

  if ('first' in spot) return pieces.length ? [point(pieces[0].node, 0, 'before')] : 'The editor shows no text';

  if ('from' in spot) {
    const i = text.indexOf(spot.from), j = i < 0 ? -1 : text.indexOf(spot.to, i);
    if (i < 0 || j < 0) return `The editor doesn’t show “${i < 0 ? spot.from : spot.to}”`;
    const start = at(i, 'before'), end = at(j + spot.to.length - 1, 'after');
    return start && end ? [start, end] : 'The text starts or ends with a line break';
  }

  const marks = content.querySelectorAll(`[data-scene="${CSS.escape(spot.scene)}"]`);
  if (marks.length !== 2) return 'The scene isn’t showing its boundary marks (is it collapsed?)';
  const mark = marks[spot.edge === 'start' ? 0 : 1], line = mark.closest('.cm-line')!;
  const beside = pieces.filter(p => line.contains(p.node));
  const piece = spot.edge === 'start'
    ? beside.find(p => mark.compareDocumentPosition(p.node) & Node.DOCUMENT_POSITION_FOLLOWING)
    : beside.findLast(p => mark.compareDocumentPosition(p.node) & Node.DOCUMENT_POSITION_PRECEDING);
  if (!piece) return `No text ${spot.edge === 'start' ? 'follows' : 'comes before'} the scene’s boundary mark on its line`;
  return [spot.edge === 'start' ? point(piece.node, 0, 'before') : point(piece.node, piece.node.data.length - 1, 'after')];
}

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

  // ---- Placing the caret and selecting, with the mouse and keyboard ----
  // Each of these checks afterwards that the caret or selection landed where the step meant, so a click that lands
  // in the wrong place fails here, clearly, rather than as a puzzling assertion later.

  get editor(): Locator { return this.page.locator('.cm-content'); }

  private async points(spot: Spot): Promise<Point[]> {
    const found = await this.page.evaluate(pointsOnScreen, spot);
    if (typeof found === 'string') throw Error(found);
    return found;
  }

  private async click(at: Point) { await this.page.mouse.click(at.x, at.y); }

  /** Click into the text, so the editor has the keyboard. */
  private async clickIntoText() { await this.click((await this.points({first: true}))[0]); }

  /** Let the editor redraw its cursor and selection, which it does on the next animation frame. */
  private async nextFrame() {
    await this.page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  }

  private async caretShouldBe(pos: number, where: string) {
    expect(await this.call('selection'), `The caret should be ${where}`).toEqual({from: pos, to: pos});
    this.remembered.set('caret', await this.call('composedOffset', pos));
  }

  /**
   * The child side of a scene's start: click just before its first word. The parent side: from there, one press of
   * the left arrow steps back over the boundary. Likewise at the end, after the last word and right arrow. An empty
   * scene shows its title as a placeholder, and clicking that puts the caret inside it. The opened node's own start
   * and end are Ctrl+Home and Ctrl+End.
   */
  async caretAtNode(title: string, edge: 'start' | 'end', side: 'parent' | 'child') {
    const id = await this.id(title), where = `at the ${edge} of “${title}” on the ${side} side`;
    if (id === await this.call('openId')) {
      await this.clickIntoText();
      await this.press(edge === 'start' ? 'Control+Home' : 'Control+End');
      return this.caretShouldBe(edge === 'start' ? 0 : (await this.call('text')).length, where);
    }
    const s = await this.scene(title), placeholder = this.editor.locator(`[data-scene="${id}"] .cm-empty-scene`);
    if (await placeholder.count()) await placeholder.click();
    else await this.click((await this.points({scene: id, edge}))[0]);
    if (side === 'parent') await this.press(edge === 'start' ? 'ArrowLeft' : 'ArrowRight');
    await this.caretShouldBe(edge === 'start' ? (side === 'parent' ? s.from : s.innerFrom) : (side === 'parent' ? s.to : s.innerTo), where);
  }

  /** Click just after the last character of `before`. */
  async caretBetween(before: string, after: string) {
    await this.click((await this.points({from: before, to: before}))[1]);
    const doc = await this.call('text'), pos = doc.indexOf(before) + before.length;
    if (!doc.slice(pos).trimStart().startsWith(after.trimStart())) throw Error(`“${after}” doesn’t follow “${before}”`);
    await this.caretShouldBe(pos, `between “${before}” and “${after}”`);
  }

  /** Drag from just before the first character of `start` to just after the last character of `end`. */
  async selectBetween(start: string, end: string) {
    const [from, to] = await this.points({from: start, to: end});
    await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down();
    await this.page.mouse.move(to.x, to.y, {steps: 5});
    await this.page.mouse.up();
    const doc = await this.call('text'), a = doc.indexOf(start), b = doc.indexOf(end, a) + end.length;
    expect(await this.call('selection'), `The selection should run from “${start}” to “${end}”`).toEqual({from: a, to: b});
    this.remembered.set('selection', await this.call('composedOffset', a));
  }

  selectText(text: string) { return this.selectBetween(text, text); }

  async selectAll() {
    await this.clickIntoText();
    await this.press('Control+a');
    expect(await this.call('selection'), 'Everything should be selected').toEqual({from: 0, to: (await this.call('text')).length});
    this.remembered.set('selection', 0);
  }

  /** Close the right-click menu if it's open, then press the left arrow. */
  async clearSelection() {
    if (await this.menu.count()) await this.press('Escape');
    await this.press('ArrowLeft');
    const {from, to} = await this.call('selection');
    expect(to, 'The selection should be cleared').toBe(from);
  }

  // ---- Other actions through the UI ----

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

  get menu(): Locator { return this.page.locator('.popup-menu'); }

  /** Right-click on the selection, or on the cursor. */
  async openMenu() {
    await this.nextFrame();
    const selection = this.page.locator('.cm-selectionBackground');
    const target = await selection.count() ? selection.first() : this.page.locator('.cm-cursor-primary');
    const box = await target.boundingBox();
    if (!box) throw Error('Neither the cursor nor a selection is showing');
    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {button: 'right'});
    await expect(this.menu).toBeVisible();
  }

  menuItem(label: string): Locator {
    return this.menu.getByRole('menuitem', {name: MENU_LABELS[label] ?? label, exact: true});
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
