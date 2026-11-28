/*
 * The application: builds the screen and connects the open book (Session), the editor, spelling and grammar
 * checking, and the toolbar, tree, status bar and menus.
 */
import {backend} from './backend';
import {Grammar, ruleName} from './checking/grammar';
import {Spelling} from './checking/spelling';
import {expand, stripMarkers} from './editor/markers';
import {SceneEditor} from './editor/scene-editor';
import {type Place, type Project, newProject, node, subtree} from './model';
import {Session} from './session';
import {button, el} from './ui/dom';
import {showMenu} from './ui/menu';
import {renameBox} from './ui/rename';
import {StatusBar} from './ui/status';
import {attachTextMenu} from './ui/text-menu';
import {renderTree} from './ui/tree';

/** Spelling language. British English for now; could become a per-book setting. */
const LANGUAGE = 'en-GB';

export interface App {
  session: Session;
  editor: SceneEditor;
  /** Switch to a project as if it had just been opened from `path` (or created, if null). */
  load(project: Project, path: string | null): void;
}

export function startApp(root: HTMLElement): App {
  // ---- Layout ----
  const toolbar = el('header'), tree = el('aside'), main = el('main'), footer = el('footer');
  const heading = el('div', '', 'heading'), title = el('input', '', 'title'), host = el('div');
  heading.append(title);
  main.append(heading, host);
  const layout = el('div', '', 'layout');
  layout.append(tree, main);
  root.append(toolbar, layout, footer);

  // ---- The book, the checkers and the editor ----
  const status = new StatusBar(footer, () => {
    const id = editor.activeScene()?.id ?? session.openId, here = session.totals.get(id);
    return [
      session.path ?? 'Unsaved project',
      `${(session.totals.get(session.project.root)?.total ?? 0).toLocaleString()} words in total`,
      here && `In “${session.titles.get(id) ?? 'Untitled'}”: ${here.own.toLocaleString()} words` + (here.total !== here.own ? ` (${here.total.toLocaleString()} with sub-scenes)` : ''),
      session.saved ? 'Saved' : 'Unsaved',
    ];
  });
  const say = (text: string) => status.say(text);
  const session = new Session(backend, {changed: () => status.update(), message: say});
  const spelling = new Spelling({language: LANGUAGE, accepted: word => session.accepts(word), report: say});
  const grammar = new Grammar({
    enabled: () => session.project.settings.grammar,
    ruleOff: rule => session.project.settings.grammarOffRules.includes(rule),
    report: say,
  });
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  const editor = new SceneEditor(host, session.titles, {
    changed: structure => {
      session.changed();
      clearTimeout(syncTimer);
      // Structure changes show in the tree at once; word counts after a pause in typing.
      if (structure) syncNow(); else syncTimer = setTimeout(syncNow, 400);
    },
    selectionChanged: () => { status.update(); updateSceneButtons(); },
    open: id => openNode(id),
    rename: id => renameScene(id),
    message: say,
  }, [spelling.extension, grammar.extension]);
  session.editorText = () => editor.text();

  function syncNow() {
    clearTimeout(syncTimer);
    session.sync();
    showTree();
    status.update();
  }

  function showTree() {
    renderTree(tree, session, {open: openNode, move: moveNode});
  }

  /** Show the open node in the editor, and everything else that depends on it. */
  function loadEditor() {
    title.value = node(session.project, session.openId).title;
    editor.load(expand(session.project, session.openId));
    showTree();
    status.update();
    updateSceneButtons();
    updateGrammarControls();
  }

  function load(project: Project, path: string | null) {
    session.reset(project, path);
    editor.clearCollapsed();
    loadEditor();
  }

  function openNode(id: string) {
    if (id !== session.openId) {
      clearTimeout(syncTimer);
      session.open(id);
      loadEditor();
    }
    editor.focus();
  }

  // ---- Titles ----

  function setTitle(id: string, value: string) {
    session.setTitle(id, value);
    if (id === session.openId) title.value = value;
    editor.refresh();
    showTree();
  }

  /** Show a small text box over a scene's margin title. */
  function renameScene(id: string) {
    const label = host.querySelector<HTMLElement>(`.cm-scene-label[data-id="${id}"] .name`)?.getBoundingClientRect();
    const caret = editor.view.coordsAtPos(editor.view.state.selection.main.head);
    const width = 220;
    renameBox({
      width,
      left: Math.max(8, label ? label.right - width + 8 : (caret?.left ?? 200)),
      top: (label?.top ?? caret?.top ?? 100) - 4,
      value: session.titles.get(id) ?? '',
      commit: value => { if (value !== session.titles.get(id)) setTitle(id, value); },
      done: refocus => { if (refocus) editor.focus(); },
    });
  }

  title.placeholder = 'Untitled';
  title.setAttribute('aria-label', 'Title');
  title.oninput = () => {
    session.setTitle(session.openId, title.value);
    showTree();
  };
  title.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); editor.focus(); } };

  // ---- Moving nodes (from the tree) ----

  /** Move a node before or after another, or to the end of it. Within the open text this is an ordinary, undoable
   *  edit; otherwise it's made in the stored model and the editor reloaded. */
  function moveNode(id: string, target: string, where: Place) {
    const {project} = session;
    if (id === target || id === project.root || (target === project.root && where !== 'inside')) return;
    syncNow();
    if (subtree(project, id).includes(target)) { say('A scene can’t be moved inside itself.'); return; }
    if (editor.place(id, target === session.openId ? null : target, where)) return;
    session.move(id, target, where);
    loadEditor();
    say(`Moved “${session.titles.get(id) ?? 'Untitled'}”. (Moves reaching outside the open text can’t be undone with Ctrl+Z.)`);
  }

  // ---- Grammar switch for this book, and turning rules back on ----

  const grammarSwitch = el('input'), grammarLabel = el('label', '', 'switch');
  const rulesOff = button('', showRulesOff, 'Grammar rules turned off for this book. Click to turn one back on.');
  grammarSwitch.type = 'checkbox';
  grammarSwitch.onchange = () => {
    session.setGrammar(grammarSwitch.checked);
    grammar.redraw(editor.view);
    updateGrammarControls();
  };
  grammarLabel.title = 'Check grammar in this book. Dialogue is never checked.';
  grammarLabel.append(grammarSwitch, ' Grammar');

  function updateGrammarControls() {
    const {grammar: on, grammarOffRules} = session.project.settings, off = grammarOffRules.length;
    grammarSwitch.checked = on;
    rulesOff.hidden = !off || !on;
    rulesOff.textContent = `${off} rule${off === 1 ? '' : 's'} off`;
  }
  function setRule(rule: string, on: boolean) {
    session.setRule(rule, on);
    grammar.redraw(editor.view);
    updateGrammarControls();
  }
  function showRulesOff() {
    const r = rulesOff.getBoundingClientRect();
    showMenu(r.left, r.bottom + 2, session.project.settings.grammarOffRules.map(rule => ({label: `Turn “${ruleName(rule)}” back on`, run: () => setRule(rule, true)})), () => editor.focus());
  }

  // ---- Right-click menu in the text ----

  attachTextMenu({
    editor, spelling, grammar,
    addWord: word => {
      session.addWord(word);
      spelling.redraw(editor.view);
      say(`Added “${word}” to this book’s dictionary.`);
    },
    turnOffRule: rule => {
      setRule(rule, false);
      say(`Turned off “${ruleName(rule)}” for this book. “Rules off” on the toolbar turns it back on.`);
    },
    copy: cut => {
      const view = editor.view, {from, to} = view.state.selection.main;
      if (from === to) return;
      backend.writeClipboard(stripMarkers(view.state.sliceDoc(from, to)))
        .then(() => { if (cut) view.dispatch({changes: {from, to}, userEvent: 'delete.cut'}); })
        .catch(e => say('Couldn’t use the clipboard: ' + String(e)));
    },
    paste: () => {
      backend.readClipboard()
        .then(text => { if (text) editor.view.dispatch({...editor.view.state.replaceSelection(text), userEvent: 'input.paste', scrollIntoView: true}); })
        .catch(() => say('There’s no text on the clipboard to paste.'));
    },
  });

  // ---- Toolbar ----

  /** Scene commands. Only the ones that make sense for the current cursor or selection are shown. */
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

  /** Before switching projects: save what can be saved, and ask before throwing anything away. */
  const canSwitch = async () => await session.settle() || confirm('Discard the unsaved project?');
  const save = () => session.save().catch(e => say('Save failed: ' + String(e)));

  toolbar.append(
    button('New', async () => { if (await canSwitch()) load(newProject(), null); }),
    button('Open', async () => {
      if (!await canSwitch()) return;
      if (await session.openFile()) { editor.clearCollapsed(); loadEditor(); }
    }),
    button('Save', save, 'Save (Ctrl+S)'),
    button('Save as', () => session.saveAs()),
    button('Export Markdown', () => session.exportMarkdown()),
    grammarLabel,
    rulesOff,
    el('span', '', 'spacer'),
    ...Object.values(sceneButtons),
  );

  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  });
  window.addEventListener('beforeunload', e => { if (session.unsaved) { e.preventDefault(); e.returnValue = ''; } });

  loadEditor();
  return {session, editor, load};
}
