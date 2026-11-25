/*
 * The scene editor: one continuous CodeMirror document showing an opened node and all its descendants.
 *
 * Each child scene sits in the text between a pair of hidden boundary tokens that carry the scene's id.
 * Because the structure lives in the document itself, mid-line boundaries, mapping through edits and
 * undo/redo of structural changes all come for free. Ordinary typing, deleting and pasting can never
 * create or remove a token (see `guard`); only the explicit structural commands on SceneEditor can.
 */
import {Annotation, EditorSelection, EditorState, StateEffect, StateField, Transaction, type ChangeSpec, type Extension, type Range, type Text, type TransactionSpec} from '@codemirror/state';
import {Decoration, EditorView, RectangleMarker, WidgetType, drawSelection, keymap, layer, placeholder, type DecorationSet, type LayerMarker, type ViewUpdate} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, isolateHistory} from '@codemirror/commands';
import {type Project, node, parts, reference, wordCount} from './model';

// ---------------------------------------------------------------------------------------------
// Boundary tokens, built from private-use characters that never occur in normal text:
// U+E000 <id> U+E002 opens a scene and U+E001 <id> U+E002 closes it.

const OPEN = String.fromCharCode(0xe000), CLOSE = String.fromCharCode(0xe001), STOP = String.fromCharCode(0xe002);
const TOKEN = new RegExp(`([${OPEN}${CLOSE}])([A-Za-z0-9-]+)${STOP}`, 'g');
const MARKER = new RegExp(`[${OPEN}-${STOP}]`);
const MARKERS = new RegExp(`[${OPEN}-${STOP}]`, 'g');
const startToken = (id: string) => OPEN + id + STOP;
const endToken = (id: string) => CLOSE + id + STOP;
export const stripMarkers = (text: string) => text.replace(TOKEN, '').replace(MARKERS, '');

/** Editor text for a node: its prose with every descendant expanded in place between boundary tokens. */
export function expand(p: Project, id: string): string {
  return parts(node(p, id).prose)
    .map(part => part.kind === 'text' ? stripMarkers(part.text) : startToken(part.id) + expand(p, part.id) + endToken(part.id))
    .join('');
}

/** Split editor text back into each node's own prose, with children as {{node:id}} references. */
export function serialize(text: string, openId: string): Map<string, string> {
  const prose = new Map<string, string>();
  const stack = [{id: openId, out: ''}];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const top = stack[stack.length - 1];
    top.out += text.slice(last, m.index);
    last = m.index! + m[0].length;
    if (m[1] === OPEN) {
      top.out += reference(m[2]);
      stack.push({id: m[2], out: ''});
    } else if (stack.length > 1 && top.id === m[2]) {
      stack.pop();
      prose.set(top.id, top.out);
    }
  }
  stack[stack.length - 1].out += text.slice(last);
  for (const s of stack) prose.set(s.id, s.out);
  return prose;
}

// ---------------------------------------------------------------------------------------------
// Scene index, kept in editor state and mapped through every edit.

export interface Scene {
  id: string;
  from: number;      // start of the opening token
  innerFrom: number; // first position inside the scene
  innerTo: number;   // start of the closing token
  to: number;        // end of the closing token
  depth: number;     // 1 = direct child of the opened node
  hue: number;       // colour slot, shared with the scene's top-level ancestor
}
interface SceneState { scenes: readonly Scene[]; byId: ReadonlyMap<string, Scene> }
const HUES = 6;

function scan(doc: Text): Scene[] {
  const scenes: Scene[] = [], open: Scene[] = [];
  let topLevel = 0;
  for (const m of doc.toString().matchAll(TOKEN)) {
    const pos = m.index!, len = m[0].length;
    if (m[1] === OPEN) {
      const parent = open[open.length - 1];
      const scene = {id: m[2], from: pos, innerFrom: pos + len, innerTo: -1, to: -1, depth: open.length + 1, hue: parent ? parent.hue : topLevel++ % HUES};
      scenes.push(scene);
      open.push(scene);
    } else if (open.length && open[open.length - 1].id === m[2]) {
      const scene = open.pop()!;
      scene.innerTo = pos;
      scene.to = pos + len;
    }
  }
  return scenes.filter(s => s.to >= 0);
}

const indexScenes = (scenes: readonly Scene[]): SceneState => ({scenes, byId: new Map(scenes.map(s => [s.id, s]))});

/** Marks transactions made by the structural commands below. */
const structural = Annotation.define<string>();
const isStructural = (tr: Transaction) => tr.annotation(structural) !== undefined || tr.isUserEvent('undo') || tr.isUserEvent('redo');

const scenesField = StateField.define<SceneState>({
  create: state => indexScenes(scan(state.doc)),
  update(value, tr) {
    if (!tr.docChanged) return value;
    let rescan = isStructural(tr);
    if (!rescan) tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (MARKER.test(inserted.toString())) rescan = true;
      else if (toA > fromA && value.scenes.some(s => (fromA < s.innerFrom && toA > s.from) || (fromA < s.to && toA > s.innerTo))) rescan = true;
    });
    if (rescan) return indexScenes(scan(tr.state.doc));
    // Ordinary edits never touch tokens, so token positions just shift. An insertion right before a
    // token belongs to the text before it, hence assoc 1 (the token moves right).
    return indexScenes(value.scenes.map(s => {
      const from = tr.changes.mapPos(s.from, 1), innerTo = tr.changes.mapPos(s.innerTo, 1);
      return {...s, from, innerFrom: from + (s.innerFrom - s.from), innerTo, to: innerTo + (s.to - s.innerTo)};
    }));
  },
});

const toggleCollapse = StateEffect.define<string>();
const refresh = StateEffect.define<null>();
const collapsedField = StateField.define<ReadonlySet<string>>({
  create: () => new Set(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(toggleCollapse)) {
      const next = new Set(value);
      if (!next.delete(e.value)) next.add(e.value);
      value = next;
    }
    return value;
  },
});

/** The innermost scene containing `pos`, i.e. the scene that typing at `pos` goes into. */
function sceneAt(state: EditorState, pos: number): Scene | null {
  let found: Scene | null = null;
  for (const s of state.field(scenesField).scenes) {
    if (s.from > pos) break;
    if (s.innerFrom <= pos && pos <= s.innerTo) found = s;
  }
  return found;
}

/** Scenes that are on screen in some form: everything except the contents of collapsed scenes. */
function shownScenes(state: EditorState): Scene[] {
  const collapsed = state.field(collapsedField), out: Scene[] = [];
  let hiddenUntil = -1;
  for (const s of state.field(scenesField).scenes) {
    if (s.from < hiddenUntil) continue;
    out.push(s);
    if (collapsed.has(s.id)) hiddenUntil = s.to;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Guard: ordinary edits keep every token (and the hidden text of collapsed scenes) intact, and pasted
// or dropped text can't smuggle tokens in. Text typed over a selection lands where the kept text starts.

function protectedRanges(state: EditorState): [number, number][] {
  const collapsed = state.field(collapsedField), ranges: [number, number][] = [];
  for (const s of state.field(scenesField).scenes) {
    if (collapsed.has(s.id)) ranges.push([s.from, s.to]);
    else ranges.push([s.from, s.innerFrom], [s.innerTo, s.to]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

function subtract(from: number, to: number, ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let pos = from;
  for (const [a, b] of ranges) {
    if (b <= pos) continue;
    if (a >= to) break;
    if (a > pos) out.push([pos, a]);
    pos = Math.max(pos, b);
  }
  if (pos < to) out.push([pos, to]);
  return out;
}

const guard = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || isStructural(tr)) return tr;
  let risky = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => { if (toA > fromA || MARKER.test(inserted.toString())) risky = true; });
  if (!risky) return tr; // plain typing: nothing can be deleted

  const keep = protectedRanges(tr.startState), specs: ChangeSpec[] = [];
  let modified = false, caret = -1;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.toString(), clean = stripMarkers(text);
    const pieces = subtract(fromA, toA, keep);
    const untouched = toA > fromA ? pieces.length === 1 && pieces[0][0] === fromA && pieces[0][1] === toA : pieces.length === 0;
    if (clean !== text || !untouched) modified = true;
    caret = pieces.length ? pieces[0][0] : fromA;
    if (!pieces.length && clean) specs.push({from: fromA, insert: clean});
    pieces.forEach(([a, b], i) => specs.push({from: a, to: b, insert: i === 0 ? clean : ''}));
  });
  if (!modified) return tr;
  const changes = tr.startState.changes(specs);
  if (changes.empty) return {}; // e.g. Backspace at the very start of a scene: nothing to do
  return {changes, selection: EditorSelection.cursor(changes.mapPos(caret, 1)), userEvent: tr.annotation(Transaction.userEvent), scrollIntoView: tr.scrollIntoView};
});

// ---------------------------------------------------------------------------------------------
// Widgets: a thin coloured tick at each boundary (so you can see which side the caret is on), and a
// one-line summary in place of a collapsed scene.

class BoundaryWidget extends WidgetType {
  constructor(readonly editor: SceneEditor, readonly id: string, readonly hue: number, readonly emptyTitle: string | null) { super(); }
  eq(o: BoundaryWidget) { return o.id === this.id && o.hue === this.hue && o.emptyTitle === this.emptyTitle; }
  toDOM() {
    const wrap = document.createElement('span');
    const tick = wrap.appendChild(document.createElement('span'));
    tick.className = `cm-boundary h${this.hue}`;
    if (this.emptyTitle !== null) {
      const hint = wrap.appendChild(document.createElement('span'));
      hint.className = 'cm-empty-scene';
      hint.textContent = this.emptyTitle;
      hint.title = 'Empty scene. Click to write in it.';
      hint.addEventListener('mousedown', e => { e.preventDefault(); this.editor.reveal(this.id); });
    }
    return wrap;
  }
}

class CollapsedWidget extends WidgetType {
  constructor(readonly editor: SceneEditor, readonly id: string, readonly title: string, readonly words: number, readonly hue: number) { super(); }
  eq(o: CollapsedWidget) { return o.id === this.id && o.title === this.title && o.words === this.words && o.hue === this.hue; }
  toDOM() {
    const chip = document.createElement('span');
    chip.className = `cm-collapsed h${this.hue}`;
    chip.textContent = `▸ ${this.title} · ${this.words.toLocaleString()} words`;
    chip.title = 'Collapsed scene. Click to expand.';
    chip.addEventListener('mousedown', e => { e.preventDefault(); this.editor.toggle(this.id); });
    return chip;
  }
}

function buildDecorations(state: EditorState, editor: SceneEditor): DecorationSet {
  const collapsed = state.field(collapsedField), ranges: Range<Decoration>[] = [];
  for (const s of shownScenes(state)) {
    if (collapsed.has(s.id)) {
      const words = wordCount(stripMarkers(state.sliceDoc(s.innerFrom, s.innerTo)));
      ranges.push(Decoration.replace({widget: new CollapsedWidget(editor, s.id, editor.title(s.id), words, s.hue)}).range(s.from, s.to));
    } else {
      const empty = s.innerFrom === s.innerTo ? editor.title(s.id) : null;
      ranges.push(Decoration.replace({widget: new BoundaryWidget(editor, s.id, s.hue, empty)}).range(s.from, s.innerFrom));
      ranges.push(Decoration.replace({widget: new BoundaryWidget(editor, s.id, s.hue, null)}).range(s.innerTo, s.to));
    }
  }
  return Decoration.set(ranges, true);
}

// ---------------------------------------------------------------------------------------------
// Layers: tinted bands behind each scene (drawn like a text selection, so a scene that starts or ends
// mid-line changes colour mid-line), and scene titles in the left margin.

function textEdges(view: EditorView) {
  const content = view.contentDOM.getBoundingClientRect(), scroller = view.scrollDOM.getBoundingClientRect();
  const line = view.contentDOM.querySelector('.cm-line'), style = line ? getComputedStyle(line) : null;
  const baseLeft = scroller.left - view.scrollDOM.scrollLeft;
  return {
    left: content.left + (style ? parseInt(style.paddingLeft) : 0) - baseLeft,
    right: content.right - (style ? parseInt(style.paddingRight) : 0) - baseLeft,
    baseTop: scroller.top - view.scrollDOM.scrollTop,
  };
}

/** True when nothing but whitespace or other boundaries follows `pos` on its line. */
function endsLine(state: EditorState, pos: number) {
  return stripMarkers(state.sliceDoc(pos, state.doc.lineAt(pos).to)).trim() === '';
}

function bandMarkers(view: EditorView): LayerMarker[] {
  const {from: top, to: bottom} = view.viewport, edges = textEdges(view);
  const active = sceneAt(view.state, view.state.selection.main.head)?.id;
  const out: LayerMarker[] = [];
  for (const s of shownScenes(view.state)) {
    if (s.to < top || s.from > bottom) continue;
    const cls = `cm-band h${s.hue}${s.id === active ? ' active' : ''}`;
    const rects = [...RectangleMarker.forRange(view, cls, EditorSelection.range(s.from, s.to))];
    if (!rects.length) continue;
    // A scene that ends at the end of a line fills that line, rather than stopping at the last word.
    const last = rects[rects.length - 1];
    if (s.to <= bottom && endsLine(view.state, s.to))
      rects[rects.length - 1] = new RectangleMarker(cls, last.left, last.top, Math.max(0, edges.right - last.left), last.height);
    out.push(...rects);
    if (s.depth > 1) { // nested scenes also get a thin rail in the margin, one step further out per level
      const y0 = Math.min(...rects.map(r => r.top)), y1 = Math.max(...rects.map(r => r.top + r.height));
      out.push(new RectangleMarker(`cm-rail h${s.hue}`, edges.left - 10 - 5 * (s.depth - 2), y0, 2, y1 - y0));
    }
  }
  return out;
}

const LABEL_HEIGHT = 20;

class LabelMarker implements LayerMarker {
  constructor(readonly editor: SceneEditor, readonly scene: Scene, readonly title: string, readonly top: number,
              readonly width: number, readonly collapsed: boolean, readonly active: boolean) {}

  eq(other: LayerMarker) {
    const o = other as LabelMarker;
    return o.scene.id === this.scene.id && o.scene.hue === this.scene.hue && o.scene.depth === this.scene.depth && o.title === this.title
      && o.top === this.top && o.width === this.width && o.collapsed === this.collapsed && o.active === this.active;
  }

  draw() {
    const {editor, scene} = this, id = scene.id;
    const box = document.createElement('div');
    box.dataset.id = id;
    const action = (text: string, hint: string, run: () => void, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.title = hint;
      if (cls) b.className = cls;
      b.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
      b.addEventListener('click', e => { e.stopPropagation(); run(); });
      return b;
    };
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.append(
      action('Open', 'Open this scene on its own', () => editor.hooks.open(id)),
      action('Rename', 'Rename this scene (or double-click its title)', () => editor.hooks.rename(id)),
      action('Merge into parent', 'Remove this scene’s boundary. Its text stays where it is.', () => editor.merge(id)),
      action('Delete', 'Delete this scene and its text (Ctrl+Z to undo)', () => editor.remove(id)),
    );
    const name = document.createElement('span');
    name.className = 'name';
    name.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    name.addEventListener('click', () => editor.reveal(id));
    name.addEventListener('dblclick', () => editor.hooks.rename(id));
    box.append(menu, action('', '', () => editor.toggle(id), 'toggle'), name);
    this.apply(box);
    return box;
  }

  // Update in place rather than redrawing, so the element under the mouse survives (e.g. for double-click).
  update(dom: HTMLElement, prev: LayerMarker) {
    if (!(prev instanceof LabelMarker) || prev.scene.id !== this.scene.id) return false;
    this.apply(dom);
    return true;
  }

  private apply(box: HTMLElement) {
    box.className = `cm-scene-label h${this.scene.hue}${this.scene.depth > 1 ? ' nested' : ''}${this.active ? ' active' : ''}`;
    Object.assign(box.style, {top: `${this.top}px`, left: '6px', width: `${this.width}px`});
    const name = box.querySelector<HTMLElement>('.name')!, toggle = box.querySelector<HTMLElement>('.toggle')!;
    name.textContent = this.title;
    name.title = `${this.title}. Click to go to it, double-click to rename.`;
    toggle.textContent = this.collapsed ? '▸' : '▾';
    toggle.title = this.collapsed ? 'Expand' : 'Collapse';
  }
}

function labelMarkers(view: EditorView, editor: SceneEditor): LayerMarker[] {
  const {from: top, to: bottom} = view.viewport, edges = textEdges(view);
  const collapsed = view.state.field(collapsedField), active = sceneAt(view.state, view.state.selection.main.head)?.id;
  const width = Math.max(60, edges.left - 30), out: LayerMarker[] = [];
  let floor = -Infinity;
  for (const s of shownScenes(view.state)) {
    if (s.from < top || s.from > bottom) continue;
    const isCollapsed = collapsed.has(s.id);
    const c = view.coordsAtPos(isCollapsed ? s.from : s.innerFrom, 1);
    if (!c) continue;
    const y = Math.max(floor, Math.round((c.top + c.bottom) / 2 - LABEL_HEIGHT / 2 - edges.baseTop)); // don't overlap the previous label
    floor = y + LABEL_HEIGHT;
    out.push(new LabelMarker(editor, s, editor.title(s.id), y, width, isCollapsed, s.id === active));
  }
  return out;
}

const layerNeedsUpdate = (u: ViewUpdate) =>
  u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged || u.transactions.some(tr => tr.effects.length > 0);

// ---------------------------------------------------------------------------------------------

/** Nudge selection ends that sit just outside a token to the side that makes sense, e.g. a triple-clicked
 *  paragraph that starts a scene selects the scene's text rather than reaching into the parent. */
function tighten(scenes: readonly Scene[], from: number, to: number) {
  for (let moved = true; moved && from < to;) {
    moved = false;
    for (const s of scenes) {
      if (from === s.from && to < s.to) { from = s.innerFrom; moved = true; }
      else if (from === s.innerTo) { from = s.to; moved = true; }
      if (to === s.to && from > s.from) { to = s.innerTo; moved = true; }
      else if (to === s.innerFrom) { to = s.from; moved = true; }
    }
  }
  return {from: Math.min(from, to), to};
}

const theme = EditorView.theme({
  '&': {backgroundColor: 'transparent'},
  '&.cm-focused': {outline: 'none'},
  '.cm-scroller': {fontFamily: 'inherit'},
  '.cm-content': {fontFamily: 'Georgia, "Times New Roman", serif', fontSize: '17px', lineHeight: '1.65', padding: '4px 0 40vh', caretColor: '#252925'},
  '.cm-line': {padding: '0 40px 0 var(--margin, 180px)'},
  '.cm-placeholder': {color: '#9a9d94', fontStyle: 'italic'},
});

export interface SceneHooks {
  /** The text changed. `structure` is true when scenes may have been added, removed or moved. */
  changed(structure: boolean): void;
  selectionChanged(): void;
  open(id: string): void;
  rename(id: string): void;
  extract(): void;
  message(text: string): void;
}

export class SceneEditor {
  readonly view: EditorView;
  private readonly extensions: Extension;
  private collapsed = new Set<string>();

  /** `titles` is shared with the app and outlives deletions, so undo can restore a scene with its name. */
  constructor(parent: HTMLElement, private readonly titles: Map<string, string>, readonly hooks: SceneHooks) {
    const decorations = StateField.define<DecorationSet>({
      create: state => buildDecorations(state, this),
      update: (deco, tr) => tr.docChanged || tr.effects.length ? buildDecorations(tr.state, this) : deco,
      provide: f => [EditorView.decorations.from(f), EditorView.atomicRanges.of(view => view.state.field(f))],
    });
    this.extensions = [
      scenesField,
      collapsedField.init(() => new Set(this.collapsed)),
      decorations,
      guard,
      history(),
      drawSelection(),
      layer({above: false, class: 'cm-scene-bands', markers: bandMarkers, update: layerNeedsUpdate}),
      layer({above: true, class: 'cm-scene-labels', markers: view => labelMarkers(view, this), update: layerNeedsUpdate}),
      keymap.of([{key: 'Mod-Shift-e', run: () => { hooks.extract(); return true; }}, ...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences'}),
      EditorView.clipboardOutputFilter.of(stripMarkers),
      EditorView.clipboardInputFilter.of(stripMarkers),
      placeholder('Write here…'),
      theme,
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
  activeScene() { return sceneAt(this.view.state, this.view.state.selection.main.head); }
  clearCollapsed() { this.collapsed.clear(); }
  /** Redraw titles after a rename. */
  refresh() { this.view.dispatch({effects: refresh.of(null)}); }
  private scene(id: string) { return this.view.state.field(scenesField).byId.get(id); }

  private structural(kind: string, spec: TransactionSpec) {
    this.view.dispatch({...spec, annotations: [structural.of(kind), isolateHistory.of('full')], userEvent: `structure.${kind}`, scrollIntoView: true});
  }

  /** Make the selection a new child scene where it stands; with no selection, insert an empty one. */
  extract(title: string): {id: string} | {error: string} {
    const state = this.view.state, {scenes} = state.field(scenesField);
    const {from, to} = tighten(scenes, state.selection.main.from, state.selection.main.to);
    for (const s of scenes) {
      const apart = s.to <= from || s.from >= to, around = s.innerFrom <= from && to <= s.innerTo, within = from <= s.from && s.to <= to;
      if (!apart && !around && !within) return {error: 'The selection crosses a scene boundary. Select text inside one scene.'};
    }
    const id = crypto.randomUUID();
    this.titles.set(id, title);
    this.structural('extract', {
      changes: [{from, insert: startToken(id)}, {from: to, insert: endToken(id)}],
      selection: EditorSelection.cursor(from + startToken(id).length),
    });
    return {id};
  }

  /** Delete a scene, its text and its sub-scenes. */
  remove(id: string) {
    const s = this.scene(id);
    if (!s) return;
    this.structural('delete', {changes: {from: s.from, to: s.to}});
    this.hooks.message(`Deleted “${this.title(id)}”. Ctrl+Z brings it back.`);
  }

  /** Remove a scene's boundary, leaving its text (and sub-scenes) in the parent. */
  merge(id: string) {
    const s = this.scene(id);
    if (!s) return;
    this.collapsed.delete(id);
    this.structural('merge', {changes: [{from: s.from, to: s.innerFrom}, {from: s.innerTo, to: s.to}]});
  }

  /** Move a scene to the end of another scene in this document (null = the opened node). False if either isn't here. */
  moveInto(id: string, target: string | null): boolean {
    const s = this.scene(id), t = target === null ? null : this.scene(target);
    if (!s || (target !== null && !t)) return false;
    const at = t ? t.innerTo : this.view.state.doc.length;
    const changes = [{from: s.from, to: s.to}, {from: at, insert: '\n\n' + this.view.state.sliceDoc(s.from, s.to)}].sort((a, b) => a.from - b.from);
    this.structural('move', {changes});
    return true;
  }

  toggle(id: string) {
    const s = this.scene(id);
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
    const s = this.scene(id);
    if (!s) return;
    this.view.dispatch({selection: EditorSelection.cursor(this.collapsed.has(id) ? s.from : s.innerFrom), scrollIntoView: true});
    this.view.focus();
  }
}
