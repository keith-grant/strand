import {invoke} from '@tauri-apps/api/core';
import {open, save} from '@tauri-apps/plugin-dialog';
import {type Project, newProject, node, children, compose, validate, move, subtree, wordTotals} from './model';
import {SceneEditor, expand, serialize} from './scenes';
import './style.css';

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

const editor = new SceneEditor(host, titles, {
  changed: structure => { dirty(); if (structure) syncNow(); else scheduleSync(); },
  selectionChanged: () => { updateStatus(); updateSceneButtons(); },
  open: id => openNode(id),
  rename: id => renameScene(id),
  message: text => say(text),
});

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
}
function reset(p: Project, dest: string | null) {
  validate(p);
  project = p; path = dest; openId = p.root; revision = 0; savedRevision = 0;
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

/** Move a node to the end of another. Inside the open text this is an ordinary, undoable edit. */
function moveNode(id: string, target: string) {
  if (id === target || id === project.root) return;
  syncFromEditor();
  if (subtree(project, id).includes(target)) { say('A scene can’t be moved inside itself.'); return; }
  if (editor.moveInto(id, target === openId ? null : target)) return;
  move(project, id, target);
  dirty();
  loadEditor();
  say(`Moved “${titles.get(id) ?? 'Untitled'}”. (This move can’t be undone with Ctrl+Z.)`);
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
    const b = button('', () => openNode(id), id === project.root ? 'Open' : 'Open. Drag onto another node to move it to the end of that node.');
    b.className = 'tree-node' + (id === openId ? ' open' : '') + (t && t.own === 0 ? ' no-prose' : '');
    b.style.paddingLeft = `${8 + depth * 14}px`;
    b.append(el('span', n.title || 'Untitled', 'name'), el('span', t ? t.total.toLocaleString() : '', 'count'));
    if (id !== project.root) {
      b.draggable = true;
      b.ondragstart = e => e.dataTransfer?.setData(DRAG, id);
    }
    b.ondragover = e => { if (e.dataTransfer?.types.includes(DRAG)) { e.preventDefault(); b.classList.add('drop'); } };
    b.ondragleave = () => b.classList.remove('drop');
    b.ondrop = e => {
      e.preventDefault();
      b.classList.remove('drop');
      const src = e.dataTransfer?.getData(DRAG);
      if (src) moveNode(src, id);
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
