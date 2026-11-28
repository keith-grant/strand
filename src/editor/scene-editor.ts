/*
 * The scene editor: one continuous CodeMirror document showing an opened node and all its descendants, with each
 * child scene between hidden boundary tokens (markers.ts). This class puts the pieces together and applies the
 * structural commands (commands.ts), handling focus, messages and naming new scenes.
 */
import {EditorSelection, EditorState, type Extension, type TransactionSpec} from '@codemirror/state';
import {EditorView, drawSelection, keymap, placeholder} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import type {Place} from '../model';
import * as commands from './commands';
import {guard} from './guard';
import {stripMarkers} from './markers';
import {type Scene, collapsedField, isStructural, refresh, sceneAt, sceneById, scenesField, toggleCollapse} from './scenes';
import {type SceneActions, sceneTheme, sceneView} from './view';

export interface SceneHooks {
  /** The text changed. `structure` is true when scenes may have been added, removed or moved. */
  changed(structure: boolean): void;
  selectionChanged(): void;
  open(id: string): void;
  rename(id: string): void;
  message(text: string): void;
}

export class SceneEditor implements SceneActions {
  readonly view: EditorView;
  private readonly extensions: Extension;
  /** Collapsed scenes, remembered across opening other nodes. */
  private collapsed = new Set<string>();

  /** `titles` is shared with the app and outlives deletions, so undo can restore a scene with its name. */
  constructor(parent: HTMLElement, private readonly titles: Map<string, string>, readonly hooks: SceneHooks, extra: Extension = []) {
    this.extensions = [
      scenesField,
      collapsedField.init(() => new Set(this.collapsed)),
      guard,
      history(),
      drawSelection(), // before sceneView, so the selection is drawn above the scene bands
      sceneView(this),
      keymap.of([
        {key: 'Mod-Shift-e', run: () => { this.newScene(); return true; }},
        {key: 'Mod-Shift-Enter', run: () => { this.split(); return true; }},
        {key: 'Mod-Shift-m', run: () => { this.mergeSelection(); return true; }},
        ...defaultKeymap, ...historyKeymap,
      ]),
      EditorView.lineWrapping,
      // Spelling is checked by Strand itself (see checking/), so the browser's own checker stays off.
      EditorView.contentAttributes.of({spellcheck: 'false', autocapitalize: 'sentences', 'aria-label': 'Manuscript text'}),
      extra,
      EditorView.clipboardOutputFilter.of(stripMarkers),
      EditorView.clipboardInputFilter.of(stripMarkers),
      placeholder('Write here…'),
      sceneTheme,
      EditorView.updateListener.of(u => {
        if (u.docChanged) hooks.changed(u.transactions.some(isStructural));
        if (u.docChanged || u.selectionSet) hooks.selectionChanged();
      }),
    ];
    this.view = new EditorView({parent, state: EditorState.create({extensions: this.extensions})});
  }

  /** Replace the document (this also resets undo history). */
  load(doc: string) { this.view.setState(EditorState.create({doc, extensions: this.extensions})); }
  text() { return this.view.state.doc.toString(); }
  focus() { this.view.focus(); }
  title(id: string) { return this.titles.get(id) ?? 'Untitled'; }
  activeScene(): Scene | null { return sceneAt(this.view.state, this.view.state.selection.main.head); }
  available() { return commands.available(this.view.state); }
  clearCollapsed() { this.collapsed.clear(); }
  /** Redraw titles after a rename. */
  refresh() { this.view.dispatch({effects: refresh.of(null)}); }
  open(id: string) { this.hooks.open(id); }
  rename(id: string) { this.hooks.rename(id); }

  private fail(message: string) { this.hooks.message(message); this.view.focus(); }
  /** Let the new scene's margin title get drawn, then ask for its name. */
  private askName(id: string) { requestAnimationFrame(() => requestAnimationFrame(() => this.hooks.rename(id))); }
  /** Apply a command's result: report why it couldn't run, or make the edit. True if it ran. */
  private apply(result: {spec: TransactionSpec} | {error: string}) {
    if ('error' in result) { this.fail(result.error); return false; }
    this.view.dispatch(result.spec);
    return true;
  }

  /** Make the selection a new child scene where it stands; with no selection, insert an empty one. */
  newScene() {
    const id = crypto.randomUUID(), result = commands.newScene(this.view.state, id);
    if ('error' in result) return this.fail(result.error);
    this.titles.set(id, 'New scene');
    this.apply(result);
    this.askName(id);
  }

  /** Split the scene the cursor is in: everything after the cursor becomes a new scene straight after it. */
  split() {
    const id = crypto.randomUUID(), result = commands.split(this.view.state, id);
    if ('error' in result) return this.fail(result.error);
    this.titles.set(id, commands.nextTitle(this.title(result.scene.id)));
    this.apply(result);
    this.askName(id);
  }

  /** Merge a scene (default: the one the cursor is in) with the touching scene before (-1) or after (1) it. */
  mergeWith(direction: -1 | 1, id?: string) { this.merged(commands.mergeWith(this.view.state, direction, id)); }

  /** Merge every scene the selection runs across. */
  mergeSelection() { this.merged(commands.mergeSelection(this.view.state)); }

  private merged(result: commands.Result<{group: Scene[]}>) {
    if ('error' in result) return this.fail(result.error);
    const [first, ...rest] = result.group;
    for (const s of rest) this.collapsed.delete(s.id);
    this.apply(result);
    this.hooks.message(`Merged ${rest.map(s => `“${this.title(s.id)}”`).join(', ')} into “${this.title(first.id)}”.`);
    this.view.focus();
  }

  /** Delete a scene, its text and its sub-scenes. */
  remove(id: string) {
    if (this.apply(commands.remove(this.view.state, id))) this.hooks.message(`Deleted “${this.title(id)}”. Ctrl+Z brings it back.`);
  }

  /** Remove a scene's boundary, leaving its text (and sub-scenes) in the parent. */
  mergeIntoParent(id: string) {
    this.collapsed.delete(id);
    this.apply(commands.mergeIntoParent(this.view.state, id));
  }

  /** Move a scene before or after another scene, or to the end of one (target null = the opened node, 'inside'
   *  only). Returns false if either isn't in this document, so the caller can move it in the stored model instead. */
  place(id: string, target: string | null, where: Place): boolean {
    const result = commands.place(this.view.state, id, target, where);
    if (!result) return false;
    if (result.spec.changes) this.view.dispatch(result.spec);
    return true;
  }

  toggle(id: string) {
    const s = sceneById(this.view.state, id);
    if (!s) return;
    const head = this.view.state.selection.main.head, hiding = !this.collapsed.has(id);
    if (hiding) this.collapsed.add(id); else this.collapsed.delete(id);
    this.view.dispatch({
      effects: toggleCollapse.of(id),
      // Don't leave the caret inside text that is about to be hidden.
      selection: hiding && head > s.from && head < s.to ? EditorSelection.cursor(s.to) : undefined,
    });
  }

  /** Put the caret at the start of a scene and scroll to it. */
  reveal(id: string) {
    const s = sceneById(this.view.state, id);
    if (!s) return;
    this.view.dispatch({selection: EditorSelection.cursor(this.collapsed.has(id) ? s.from : s.innerFrom), scrollIntoView: true});
    this.view.focus();
  }
}
