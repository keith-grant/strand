/*
 * Step definitions for features/*.feature, following the step vocabulary in features/README.md.
 * Fixture steps build the project directly; actions go through the UI; assertions read the live model.
 */
import {expect} from '@playwright/test';
import {createBdd, type DataTable} from 'playwright-bdd';
import {compose, type Project, validate} from '../../src/model';
import {test} from './fixtures';
import {Strand} from './strand';

const {Given, When, Then, Before, BeforeStep} = createBdd(test);

/** Any scene-marker character (built from character codes, never written literally in source). */
const MARKER = new RegExp(`[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xe002)}]`);

// ---- Hooks ----

Before({tags: '@todo'}, async ({$test}) => {
  $test.fixme(true, 'Not built yet, or behaviour still being decided (@todo)');
});

// "Unchanged" means unchanged since just before the scenario's first action (its first When).
BeforeStep(async ({strand, $bddContext}) => {
  const step = $bddContext.bddTestData.steps[$bddContext.stepIndex];
  if (step?.keywordType === 'Action' && !strand.baseline) await strand.takeBaseline();
});

// ---- Fixtures ----

Given('a project with a root manuscript named {string}', ({strand}, name: string) => strand.newProject(name, false));
Given('a saved project with a root manuscript named {string}', ({strand}, name: string) => strand.newProject(name, true));
Given('{string} contains a child scene {string}', ({strand}, parent: string, child: string) => strand.addChild(parent, child));
Given('{string} contains the prose {string}', ({strand}, node: string, text: string) => strand.addProse(node, text));
Given('{string} contains the prose:', ({strand}, node: string, text: string) => strand.addProse(node, text));
Given('{string} contains the following content in order:', ({strand}, node: string, table: DataTable) => strand.setContent(node, table.hashes()));
Given('{string} is collapsed', ({strand}, node: string) => strand.toggle(node));

// ---- Opening, selecting, placing the caret ----

When('I open {string} in the editor', ({strand}, node: string) => strand.openNode(node));
When('I select the text {string}', ({strand}, text: string) => strand.selectText(text));
When('I select from the text {string} to the text {string}', ({strand}, start: string, end: string) => strand.selectBetween(start, end));
When('I select all prose in the editor', async ({strand}) => {
  await strand.placeCaret(0);
  await strand.press('Control+a');
  strand.remembered.set('selection', 0);
});
When('I clear the selection', async ({strand}) => {
  await strand.placeCaret((await strand.call('selection')).from);
});
When(/^I place the caret at the (start|end) of "(.+)" on the (parent|child) side$/, ({strand}, edge: string, node: string, side: string) =>
  strand.caretAtNode(node, edge as 'start' | 'end', side as 'parent' | 'child'));
When('I place the caret between {string} and {string}', ({strand}, before: string, after: string) => strand.caretBetween(before, after));

// ---- Editing ----

When('I type {string}', ({strand}, text: string) => strand.type(text));
When('I press {string}', ({strand}, key: string) => strand.press(key));
When('I paste text containing reserved editor boundary characters', async ({strand}) => {
  await strand.setFake(`f => { f.clipboard = 'smuggled' + String.fromCharCode(0xE000) + 'Evil' + String.fromCharCode(0xE002) + 'text' + String.fromCharCode(0xE001) + 'Evil' + String.fromCharCode(0xE002); }`);
  await strand.chooseFromMenu('Paste');
});
When('I undo', ({strand}) => strand.press('Control+z'));
When('I redo', ({strand}) => strand.press('Control+y'));

// ---- Structure ----

When('I create a child scene named {string} from the selection', ({strand}, name: string) => strand.newScene(name));
When('I insert an empty child scene named {string} at the caret', ({strand}, name: string) => strand.newScene(name));
When('I split {string} at the caret', ({strand}, _node: string) => strand.split()); // the caret decides which scene
When('I merge {string} into its parent', ({strand}, node: string) => strand.mergeIntoParent(node));
When('I merge {string} into {string}', ({strand}, source: string, destination: string) => strand.merge(source, destination));
When(/^I (collapse|expand) "(.+)"$/, ({strand}, _action: string, node: string) => strand.toggle(node));
When(/^I (?:attempt to )?move "(.+)" into "(.+)" using the manuscript tree$/, ({strand}, node: string, destination: string) =>
  strand.moveInTree(node, destination));
When('I open the editor context menu', ({strand}) => strand.openMenu());

// ---- The project file ----

When('I save the project', async ({strand}) => {
  for (const n of (await strand.project()).nodes) strand.rememberedIds.set(n.title, n.id);
  await strand.save();
  await expect.poll(() => strand.call('saved')).toBe(true);
});
When('I close the project', ({strand}) => strand.close());
When('I reopen the saved project', ({strand}) => strand.reopen());
When('autosave completes', async ({strand}) => {
  await expect.poll(() => strand.call('saved')).toBe(true);
});
When('I export the manuscript as Markdown', async ({strand}) => {
  strand.filesBeforeExport = await strand.savedFiles();
  await strand.exportMarkdown();
});
When('I view the word counts', async ({strand}) => {
  await expect(strand.page.locator('aside .tree-node').first()).toBeVisible();
});

// ---- Assertions: structure and ownership ----

const project = (strand: Strand) => strand.project();

Then('{string} should be a child of {string}', async ({strand}, child: string, parent: string) => {
  expect(Strand.childTitles(await project(strand), parent)).toContain(child);
});
Then('{string} should not contain a child scene {string}', async ({strand}, parent: string, child: string) => {
  expect(Strand.childTitles(await project(strand), parent)).not.toContain(child);
});
Then('{string} should own the prose {string}', async ({strand}, node: string, text: string) => {
  expect(Strand.owned(await project(strand), node)).toContain(text);
});
Then('{string} should own no prose', async ({strand}, node: string) => {
  expect(Strand.owned(await project(strand), node)).toBe('');
});
Then('{string} should contain exactly {int} child scenes', async ({strand}, node: string, count: number) => {
  expect(Strand.childTitles(await project(strand), node)).toHaveLength(count);
});
Then('the two child scenes of {string} should own {string} and {string} in that order', async ({strand}, node: string, first: string, second: string) => {
  const p = await project(strand), children = Strand.childTitles(p, node);
  expect(children).toHaveLength(2);
  expect(Strand.owned(p, children[0])).toBe(first);
  expect(Strand.owned(p, children[1])).toBe(second);
});
Then('the project should contain exactly {int} narrative nodes', async ({strand}, count: number) => {
  expect((await project(strand)).nodes).toHaveLength(count);
});
Then('the project should not contain a scene named {string}', async ({strand}, name: string) => {
  expect((await project(strand)).nodes.map(n => n.title)).not.toContain(name);
});
Then('the project structure should remain valid', async ({strand}) => {
  const p = await project(strand);
  expect(() => validate(p)).not.toThrow();
});

/** Nodes in a comparable form: ids, titles and prose, in id order. */
const shape = (p: Project) => [...p.nodes].sort((a, b) => a.id.localeCompare(b.id));

Then('the assembled manuscript prose should be unchanged', async ({strand}) => {
  expect(compose(await project(strand))).toBe(strand.baseline!.composed);
});
Then(/^the project structure and prose should be unchanged$|^the move should be rejected$/, async ({strand}) => {
  expect(shape(await project(strand))).toEqual(shape(strand.baseline!.project));
});
Then(/^"(.+)" should appear inline at the original (selection|caret) position$/, async ({strand}, node: string, which: string) => {
  const scene = await strand.scene(node);
  expect(await strand.call('composedOffset', scene.innerFrom)).toBe(strand.remembered.get(which));
});
Then(/^"(.+)" should report (\d+) (owned|aggregate) words$/, async ({strand}, node: string, count: string, kind: string) => {
  const totals = await strand.call('totals');
  expect(totals[await strand.id(node)][kind === 'owned' ? 'own' : 'total']).toBe(Number(count));
});
Then('{string} should retain its scene identity', async ({strand}, node: string) => {
  expect(await strand.id(node)).toBe(strand.rememberedIds.get(node));
});

// ---- Assertions: what's on screen ----

/** The editor's visible text with whitespace evened out. */
const visibleText = async (strand: Strand) => (await strand.editor.innerText()).replace(/\s+/g, ' ').trim();

Then('the editor should show the prose {string}', async ({strand}, text: string) => {
  await expect(strand.editor).toContainText(text, {useInnerText: true});
});
Then('the editor should not show the prose {string}', async ({strand}, text: string) => {
  await expect(strand.editor).not.toContainText(text, {useInnerText: true});
});
Then('the editor should show the assembled prose of {string} in order', async ({strand}, node: string) => {
  const p = await project(strand);
  expect(await visibleText(strand)).toBe(compose(p, Strand.node(p, node).id).replace(/\s+/g, ' ').trim());
});
Then('the editor should be a single continuous editing surface', async ({strand}) => {
  await expect(strand.page.locator('[contenteditable="true"]')).toHaveCount(1);
});
Then('{string} should have a visible scene boundary', async ({strand}, node: string) => {
  await expect(await strand.label(node)).toBeVisible();
});
Then('{string} should have a visible collapsed placeholder', async ({strand}, node: string) => {
  await expect(strand.page.locator(`.cm-collapsed[data-scene="${await strand.id(node)}"]`)).toBeVisible();
});
Then('the caret should be outside the collapsed content of {string}', async ({strand}, node: string) => {
  const {from} = await strand.call('selection'), scene = await strand.scene(node);
  expect(from > scene.from && from < scene.to).toBe(false);
});
Then('{string} should be the opened node', async ({strand}, node: string) => {
  expect(await strand.call('openId')).toBe(await strand.id(node));
});
Then('the editor context menu should contain {string}', async ({strand}, label: string) => {
  await expect(strand.menuItem(label)).toBeVisible();
});

// ---- Assertions: export ----

const exported = (strand: Strand) => strand.fake(f => f.exported.get('book.md') ?? null);

Then('the exported Markdown should equal {string}', async ({strand}, text: string) => {
  expect(await exported(strand)).toBe(text);
});
Then('the exported Markdown should contain no scene references or editor markers', async ({strand}) => {
  const text = (await exported(strand))!;
  expect(text).not.toMatch(/\{\{node:/);
  expect(text).not.toMatch(MARKER);
});
Then('export should not change the saved project', async ({strand}) => {
  expect(await strand.savedFiles()).toBe(strand.filesBeforeExport);
});
