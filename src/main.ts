import {invoke} from '@tauri-apps/api/core';
import {open, save} from '@tauri-apps/plugin-dialog';
import {readText, writeText} from '@tauri-apps/plugin-clipboard-manager';
import {type Place, type Project, newProject, node, children, compose, validate, place, subtree, wordTotals} from './model';
import {SceneEditor, expand, serialize, stripMarkers} from './scenes';
import {Spelling} from './spelling';
import {Grammar, plainMessage, ruleName} from './grammar';
import {type MenuItem, showMenu} from './menu';
import './style.css';

/** Spelling language. British English for now; could become a per-book setting. */
const LANGUAGE = 'en-GB';

let project = newProject(), openId = project.root, path: string | null = null;
let revision = 0, savedRevision = 0, saveTimer: number | undefined, syncTimer: number | undefined, writes = Promise.resolve();
let totals = wordTotals(project), note = '', noteTimer: number | undefined;
/** Titles of every node seen this session. Deleted scenes stay here so undo can bring them back with their names. */
const titles = new Map<string, string>(project.nodes.map(n => [n.id, n.title]));
const DRAG = 'application/x-strand-node';

const app = document.querySelector<HTMLDivElement>('#app')!;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') { const e = document.createElement(tag); e.textContent = text; e.className = cls; return e; }
function button(text: string, fn: () => void | Promise<void>, hint = '') {
  const b = el('button', text);
  if (hint) b.title = hint;
  b.onclick = () => { Promise.resolve().then(fn).catch(e => alert(String(e))); };
  return b;
}

const toolbar = el('header'), tree = el('aside'), main = el('main'), status = el('footer');
const heading = el('div', '', 'heading'), title = el('input', '', 'title'), host = el('div');
heading.append(title);
main.append(heading, host);
const layout = el('div', '', 'layout');
layout.append(tree, main);
app.append(toolbar, layout, status);

/** The book's spelling dictionary, as a set for quick lookups. Kept in step with `project.words`. */
let dictionary = new Set(project.words);
const spelling = new Spelling({
  language: LANGUAGE,
  accepted: word => dictionary.has(word) || dictionary.has(word.toLowerCase()),
  report: text => say(text),
});
const grammar = new Grammar({
  enabled: () => project.settings.grammar,
  ruleOff: rule => project.settings.grammarOffRules.includes(rule),
  report: text => say(text),
});

const editor = new SceneEditor(host, titles, {
  changed: structure => { dirty(); if (structure) syncNow(); else scheduleSync(); },
  selectionChanged: () => { updateStatus(); updateSceneButtons(); },
  open: id => openNode(id),
  rename: id => renameScene(id),
  message: text => say(text),
}, [spelling.extension, grammar.extension]);

/** Grammar switch for this book, plus a way to turn back on rules that were turned off. */
const grammarSwitch = el('input'), rulesOff = button('', () => showRulesOff(), 'Grammar rules turned off for this book. Click to turn one back on.');
grammarSwitch.type = 'checkbox';
grammarSwitch.onchange = () => {
  project.settings.grammar = grammarSwitch.checked;
  dirty();
  grammar.redraw(editor.view);
  updateGrammarControls();
};
const grammarLabel = el('label', '', 'switch');
grammarLabel.title = 'Check grammar in this book. Dialogue is never checked.';
grammarLabel.append(grammarSwitch, ' Grammar');
function updateGrammarControls() {
  const off = project.settings.grammarOffRules.length;
  grammarSwitch.checked = project.settings.grammar;
  rulesOff.hidden = !off || !project.settings.grammar;
  rulesOff.textContent = `${off} rule${off === 1 ? '' : 's'} off`;
}
function setRule(rule: string, on: boolean) {
  const rules = project.settings.grammarOffRules;
  if (on) rules.splice(rules.indexOf(rule), 1); else if (!rules.includes(rule)) rules.push(rule);
  dirty();
  grammar.redraw(editor.view);
  updateGrammarControls();
}
function showRulesOff() {
  const r = rulesOff.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, project.settings.grammarOffRules.map(rule => ({label: `Turn “${ruleName(rule)}” back on`, run: () => setRule(rule, true)})), () => editor.focus());
}

/** Scene commands on the toolbar. Only the ones that make sense for the current cursor or selection are shown. */
const sceneButtons = {
  newScene: button('New scene', () => editor.newScene(), 'Make the selected text a scene, or insert an empty scene at the cursor (Ctrl+Shift+E)'),
  split: button('Split', () => editor.split(), 'Split this scene at the cursor (Ctrl+Shift+Enter)'),
  mergePrevious: button('Merge with previous', () => editor.mergeWith(-1), 'Join this scene onto the end of the scene before it, which keeps its title'),
  mergeNext: button('Merge with next', () => editor.mergeWith(1), 'Join the next scene onto the end of this one'),
  merge: button('Merge', () => editor.mergeSelection(), 'Merge the scenes the selection runs across into the first of them (Ctrl+Shift+M)'),
};
function updateSceneButtons() {
  const available = editor.available();
  for (const [key, b] of Object.entries(sceneButtons)) b.hidden = !available[key as keyof typeof sceneButtons];
}

// ---- Keeping the stored project in step with the editor ----

/** Write the editor's text back into the project: the opened node's prose plus every scene inside it. */
function syncFromEditor() {
  window.clearTimeout(syncTimer);
  const prose = serialize(editor.text(), openId);
  const replaced = new Set(subtree(project, openId));
  replaced.delete(openId);
  const nodes = project.nodes.filter(n => !replaced.has(n.id));
  node(project, openId).prose = prose.get(openId) ?? '';
  for (const [id, text] of prose) if (id !== openId) nodes.push({id, title: titles.get(id) ?? 'Untitled', prose: text});
  project.nodes = nodes;
  totals = wordTotals(project);
}
function syncNow() { syncFromEditor(); renderTree(); updateStatus(); }
function scheduleSync() { window.clearTimeout(syncTimer); syncTimer = window.setTimeout(syncNow, 400); }

function dirty() {
  revision++;
  updateStatus();
  window.clearTimeout(saveTimer);
  if (path) saveTimer = window.setTimeout(() => { flush().catch(e => say('Save failed: ' + String(e))); }, 800);
}
async function flush() {
  window.clearTimeout(saveTimer);
  if (!path || revision === savedRevision) return;
  syncFromEditor();
  const snapshot = structuredClone(project), dest = path, rev = revision;
  const task = writes.catch(() => {}).then(() => invoke<void>('save_project', {path: dest, project: snapshot}));
  writes = task;
  await task;
  if (path === dest) { savedRevision = rev; updateStatus(); }
}
async function saveAs() {
  const dest = await save({filters: [{name: 'Strand project', extensions: ['strand']}]});
  if (!dest) return;
  await writes.catch(() => {});
  path = dest;
  revision++;
  await flush();
}
async function canSwitch() { if (path) await flush(); return path || revision === savedRevision || confirm('Discard the unsaved project?'); }

// ---- Opening ----

function loadEditor() {
  title.value = node(project, openId).title;
  editor.load(expand(project, openId));
  totals = wordTotals(project);
  renderTree();
  updateStatus();
  updateSceneButtons();
  updateGrammarControls();
}
function reset(p: Project, dest: string | null) {
  validate(p);
  project = p; path = dest; openId = p.root; revision = 0; savedRevision = 0;
  dictionary = new Set(p.words);
  titles.clear();
  for (const n of p.nodes) titles.set(n.id, n.title);
  editor.clearCollapsed();
  loadEditor();
}
function openNode(id: string) {
  if (id !== openId) {
    syncFromEditor();
    openId = id;
    loadEditor();
  }
  editor.focus();
}

// ---- Scene commands that need the app (titles, the tree, the stored project) ----

function setTitle(id: string, value: string) {
  titles.set(id, value);
  const n = project.nodes.find(n => n.id === id);
  if (n) n.title = value;
  if (id === openId) title.value = value;
  editor.refresh();
  dirty();
  renderTree();
}

/** Show a small text box over a scene's margin title. */
function renameScene(id: string) {
  const label = host.querySelector<HTMLElement>(`.cm-scene-label[data-id="${id}"] .name`)?.getBoundingClientRect();
  const caret = editor.view.coordsAtPos(editor.view.state.selection.main.head);
  const width = 220, input = el('input', '', 'rename');
  input.value = titles.get(id) ?? '';
  input.style.width = `${width}px`;
  input.style.left = `${Math.max(8, label ? label.right - width + 8 : (caret?.left ?? 200))}px`;
  input.style.top = `${(label?.top ?? caret?.top ?? 100) - 4}px`;
  document.body.append(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep: boolean, refocus: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.remove();
    if (keep && value && value !== titles.get(id)) setTitle(id, value);
    if (refocus) editor.focus();
  };
  input.onkeydown = e => {
    if (e.key === 'Enter') finish(true, true);
    else if (e.key === 'Escape') finish(false, true);
  };
  input.onblur = () => finish(true, false);
}

/** Move a node before or after another, or to the end of it. Within the open text this is an ordinary, undoable edit. */
function moveNode(id: string, target: string, where: Place) {
  if (id === target || id === project.root || (target === project.root && where !== 'inside')) return;
  syncFromEditor();
  if (subtree(project, id).includes(target)) { say('A scene can’t be moved inside itself.'); return; }
  if (editor.place(id, target === openId ? null : target, where)) return;
  place(project, id, target, where);
  dirty();
  loadEditor();
  say(`Moved “${titles.get(id) ?? 'Untitled'}”. (Moves reaching outside the open text can’t be undone with Ctrl+Z.)`);
}

/** Which part of a tree row the pointer is over: top quarter = before, bottom quarter = after, otherwise inside. */
function dropPlace(e: DragEvent, row: HTMLElement, id: string): Place | null {
  if (!dragging || dragging.subtree.has(id)) return null;
  if (id === project.root) return 'inside';
  const r = row.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
  return y < .25 ? 'before' : y > .75 ? 'after' : 'inside';
}
/** The node being dragged in the tree, and everything under it (which it can't be dropped onto). */
let dragging: {id: string; subtree: Set<string>} | null = null;

// ---- Right-click menu in the text: spelling, clipboard and scene commands ----

editor.view.contentDOM.addEventListener('contextmenu', e => {
  e.preventDefault();
  const view = editor.view, sel = view.state.selection.main;
  let x = e.clientX, y = e.clientY, pos = view.posAtCoords({x, y});
  if (pos === null || (x === 0 && y === 0)) { // opened from the keyboard: use the cursor
    pos = sel.head;
    const c = view.coordsAtPos(pos);
    if (c) { x = c.left; y = c.bottom; }
  } else if (sel.empty || pos < sel.from || pos > sel.to) {
    view.dispatch({selection: {anchor: pos}}); // right-clicking outside the selection moves the cursor there
  }
  openTextMenu(x, y, pos);
});

function openTextMenu(x: number, y: number, pos: number) {
  const view = editor.view, state = view.state, sel = state.selection.main, items: MenuItem[] = [];
  const found = spelling.issueAt(state, pos);
  if (found) {
    const replace = (from: number, text: string) => view.dispatch({changes: {from, to: found.to, insert: text}, userEvent: 'input.spelling'});
    if (found.issue.action === 'delete') {
      let from = found.from; // also remove the space before the repeated word
      while (from > state.doc.lineAt(found.from).from && /[ \t]/.test(state.sliceDoc(from - 1, from))) from--;
      items.push({label: 'Delete repeated word', strong: true, run: () => replace(from, '')});
    } else if (found.issue.action === 'replace' && found.issue.replacement) {
      const fix = found.issue.replacement;
      items.push({label: fix, strong: true, run: () => replace(found.from, fix)});
    } else {
      items.push({
        placeholder: 'Looking for suggestions…',
        load: spelling.suggestions(found.text).then(list => list.length
          ? list.slice(0, 6).map(s => ({label: s, strong: true, run: () => replace(found.from, s)}))
          : [{label: 'No suggestions', disabled: true as const}]),
      });
    }
    if (found.issue.action !== 'delete') items.push(
      {label: 'Add to dictionary', hint: 'Accept this word everywhere in this book', run: () => addToDictionary(found.text)},
      {label: 'Ignore', hint: 'Accept this word until Strand is closed', run: () => spelling.ignore(found.text, view)},
    );
    items.push('separator');
  }
  const problem = grammar.issueAt(state, pos);
  if (problem) {
    const fix = (text: string) => view.dispatch({changes: {from: problem.from, to: problem.to, insert: text}, userEvent: 'input.grammar'});
    items.push({note: plainMessage(problem.issue.message)});
    for (const text of problem.issue.fixes.slice(0, 4))
      items.push({label: text === '' ? `Remove “${problem.text}”` : text, strong: true, run: () => fix(text)});
    items.push(
      {label: 'Ignore', hint: 'Hide this one until Strand is closed', run: () => grammar.ignore(problem, view)},
      {label: `Turn off “${ruleName(problem.issue.rule)}” for this book`, run: () => {
        setRule(problem.issue.rule, false);
        say(`Turned off “${ruleName(problem.issue.rule)}” for this book. “Rules off” on the toolbar turns it back on.`);
      }},
      'separator',
    );
  }
  items.push(
    {label: 'Cut', disabled: sel.empty, run: () => copySelection(true)},
    {label: 'Copy', disabled: sel.empty, run: () => copySelection(false)},
    {label: 'Paste', run: () => paste()},
    'separator',
  );
  const can = editor.available(), scene = editor.activeScene();
  if (can.newScene) items.push({label: 'New scene', hint: 'Ctrl+Shift+E', run: () => editor.newScene()});
  if (can.split) items.push({label: 'Split scene here', hint: 'Ctrl+Shift+Enter', run: () => editor.split()});
  if (can.merge) items.push({label: 'Merge selected scenes', hint: 'Ctrl+Shift+M', run: () => editor.mergeSelection()});
  if (can.mergePrevious) items.push({label: 'Merge with previous', run: () => editor.mergeWith(-1)});
  if (can.mergeNext) items.push({label: 'Merge with next', run: () => editor.mergeWith(1)});
  if (scene && sel.empty) items.push({label: 'Merge with parent', run: () => editor.mergeIntoParent(scene.id)});
  showMenu(x, y, items, () => editor.focus());
}

function addToDictionary(word: string) {
  if (!dictionary.has(word)) {
    dictionary.add(word);
    project.words.push(word);
    dirty();
  }
  spelling.redraw(editor.view);
  say(`Added “${word}” to this book’s dictionary.`);
}

function copySelection(cut: boolean) {
  const view = editor.view, {from, to} = view.state.selection.main;
  if (from === to) return;
  writeText(stripMarkers(view.state.sliceDoc(from, to)))
    .then(() => { if (cut) view.dispatch({changes: {from, to}, userEvent: 'delete.cut'}); })
    .catch(e => say('Couldn’t use the clipboard: ' + String(e)));
}

function paste() {
  readText()
    .then(text => { if (text) editor.view.dispatch({...editor.view.state.replaceSelection(text), userEvent: 'input.paste', scrollIntoView: true}); })
    .catch(() => say('There’s no text on the clipboard to paste.'));
}

// ---- Chrome: toolbar, tree, status ----

function say(text: string) {
  note = text;
  window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => { note = ''; updateStatus(); }, 6000);
  updateStatus();
}

function updateStatus() {
  const id = editor.activeScene()?.id ?? openId, here = totals.get(id);
  const words = here && `In “${titles.get(id) ?? 'Untitled'}”: ${here.own.toLocaleString()} words` + (here.total !== here.own ? ` (${here.total.toLocaleString()} with sub-scenes)` : '');
  status.textContent = [
    path ?? 'Unsaved project',
    `${(totals.get(project.root)?.total ?? 0).toLocaleString()} words in total`,
    words,
    revision === savedRevision && path ? 'Saved' : 'Unsaved',
    note,
  ].filter(Boolean).join('  •  ');
}

function renderTree() {
  tree.replaceChildren(el('h2', 'Manuscript'));
  const branch = (id: string, depth: number) => {
    const n = node(project, id), t = totals.get(id);
    const b = button('', () => openNode(id), id === project.root ? 'Open' : 'Open. Drag to move: drop on the top or bottom edge of another node to place it before or after, or on the middle to put it inside.');
    b.className = 'tree-node' + (id === openId ? ' open' : '') + (t && t.own === 0 ? ' no-prose' : '');
    b.style.paddingLeft = `${8 + depth * 14}px`;
    b.append(el('span', n.title || 'Untitled', 'name'), el('span', t ? t.total.toLocaleString() : '', 'count'));
    if (id !== project.root) {
      b.draggable = true;
      b.ondragstart = e => { dragging = {id, subtree: new Set(subtree(project, id))}; e.dataTransfer?.setData(DRAG, id); };
      b.ondragend = () => { dragging = null; };
    }
    const clear = () => b.classList.remove('drop-before', 'drop-after', 'drop-inside');
    b.ondragover = e => {
      const where = dropPlace(e, b, id);
      clear();
      if (!where) return;
      e.preventDefault();
      b.classList.add(`drop-${where}`);
    };
    b.ondragleave = clear;
    b.ondrop = e => {
      const where = dropPlace(e, b, id), src = dragging?.id;
      clear();
      if (!where || !src) return;
      e.preventDefault();
      moveNode(src, id, where);
    };
    tree.append(b);
    children(n).forEach(c => branch(c, depth + 1));
  };
  branch(project.root, 0);
}

title.placeholder = 'Untitled';
title.setAttribute('aria-label', 'Title');
title.oninput = () => {
  titles.set(openId, title.value);
  node(project, openId).title = title.value;
  dirty();
  renderTree();
};
title.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); editor.focus(); } };

toolbar.append(
  button('New', async () => { if (await canSwitch()) reset(newProject(), null); }),
  button('Open', async () => {
    if (!await canSwitch()) return;
    const dest = await open({multiple: false, filters: [{name: 'Strand project', extensions: ['strand']}]});
    if (typeof dest === 'string') reset(await invoke<Project>('load_project', {path: dest}), dest);
  }),
  button('Save', async () => { if (!path) await saveAs(); else await flush(); }, 'Save (Ctrl+S)'),
  button('Save as', saveAs),
  button('Export Markdown', async () => {
    syncFromEditor();
    const dest = await save({filters: [{name: 'Markdown', extensions: ['md']}]});
    if (dest) await invoke('export_markdown', {path: dest, prose: compose(project)});
  }),
  grammarLabel,
  rulesOff,
  el('span', '', 'spacer'),
  ...Object.values(sceneButtons),
);

window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    (path ? flush() : saveAs()).catch(err => say('Save failed: ' + String(err)));
  }
});
window.addEventListener('beforeunload', e => { if (revision !== savedRevision) { e.preventDefault(); e.returnValue = ''; } });
loadEditor();
