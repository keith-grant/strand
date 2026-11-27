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
import {type Place, type Project, cutWithGap, node, parts, reference, separators, wordCount} from './model';

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
/** Remove boundary tokens, with a way to map a position in the result back to a position in `text`. */
export function withoutMarkers(text: string): {text: string; at: (pos: number) => number} {
  if (!MARKER.test(text)) return {text, at: pos => pos};
  const runs: {from: number; origin: number}[] = []; // where each kept stretch starts in the result, and in `text`
  let out = '', last = 0;
  const keep = (a: number, b: number) => { if (b > a) { runs.push({from: out.length, origin: a}); out += text.slice(a, b); } };
  for (const m of text.matchAll(TOKEN)) { keep(last, m.index!); last = m.index! + m[0].length; }
  keep(last, text.length);
  return {
    text: out,
    at: pos => {
      let run = runs[0];
      for (const r of runs) { if (r.from > pos) break; run = r; }
      return run ? run.origin + (pos - run.from) : pos;
    },
  };
}
/** Replace every boundary token with spaces of the same length, so positions in the result still match the text. */
export const blankMarkers = (text: string) => MARKER.test(text) ? text.replace(TOKEN, m => ' '.repeat(m.length)).replace(MARKERS, ' ') : text;

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
  parent: string | null; // null = the opened node
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
      const scene = {id: m[2], from: pos, innerFrom: pos + len, innerTo: -1, to: -1, depth: open.length + 1, parent: parent ? parent.id : null, hue: parent ? parent.hue : topLevel++ % HUES};
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

/** Two scenes in the same parent touch when only blank space (or nothing) lies between them. */
const touching = (state: EditorState, a: Scene, b: Scene) => state.sliceDoc(a.to, b.from).trim() === '';

const siblingsOf = (state: EditorState, parent: string | null) => state.field(scenesField).scenes.filter(s => s.parent === parent);

/** For each scene, whether it touches the scene before / after it in the same parent (so can merge with it). */
function mergeableNeighbours(state: EditorState): Map<string, {previous: boolean; next: boolean}> {
  const out = new Map<string, {previous: boolean; next: boolean}>(), lastInParent = new Map<string | null, Scene>();
  for (const s of state.field(scenesField).scenes) {
    const flags = {previous: false, next: false}, before = lastInParent.get(s.parent);
    out.set(s.id, flags);
    if (before && touching(state, before, s)) { flags.previous = true; out.get(before.id)!.next = true; }
    lastInParent.set(s.parent, s);
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

interface LabelFlags { collapsed: boolean; active: boolean; split: boolean; mergePrevious: boolean; mergeNext: boolean }

class LabelMarker implements LayerMarker {
  constructor(readonly editor: SceneEditor, readonly scene: Scene, readonly title: string, readonly top: number,
              readonly width: number, readonly flags: LabelFlags) {}

  eq(other: LayerMarker) {
    const o = other as LabelMarker;
    return o.scene.id === this.scene.id && o.scene.hue === this.scene.hue && o.scene.depth === this.scene.depth && o.title === this.title
      && o.top === this.top && o.width === this.width && (Object.keys(this.flags) as (keyof LabelFlags)[]).every(k => o.flags[k] === this.flags[k]);
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
      action('Split here', 'Split this scene at the cursor (Ctrl+Shift+Enter)', () => editor.split(), 'split'),
      action('Merge with previous', 'Join this scene onto the end of the scene before it, which keeps its title', () => editor.mergeWith(-1, id), 'merge-previous'),
      action('Merge with next', 'Join the next scene onto the end of this one', () => editor.mergeWith(1, id), 'merge-next'),
      action('Merge with parent', 'Remove this scene’s boundary. Its text stays where it is, as part of the scene around it.', () => editor.mergeIntoParent(id)),
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
    const {collapsed, active, split, mergePrevious, mergeNext} = this.flags;
    box.className = `cm-scene-label h${this.scene.hue}${this.scene.depth > 1 ? ' nested' : ''}${active ? ' active' : ''}`;
    Object.assign(box.style, {top: `${this.top}px`, left: '6px', width: `${this.width}px`});
    const part = (cls: string) => box.querySelector<HTMLElement>(`.${cls}`)!;
    part('name').textContent = this.title;
    part('name').title = `${this.title}. Click to go to it, double-click to rename.`;
    part('toggle').textContent = collapsed ? '▸' : '▾';
    part('toggle').title = collapsed ? 'Expand' : 'Collapse';
    part('split').hidden = !split;
    part('merge-previous').hidden = !mergePrevious;
    part('merge-next').hidden = !mergeNext;
  }
}

function labelMarkers(view: EditorView, editor: SceneEditor): LayerMarker[] {
  const {from: top, to: bottom} = view.viewport, edges = textEdges(view);
  const collapsed = view.state.field(collapsedField), sel = view.state.selection.main, active = sceneAt(view.state, sel.head)?.id;
  const neighbours = mergeableNeighbours(view.state), width = Math.max(60, edges.left - 30), out: LayerMarker[] = [];
  let floor = -Infinity;
  for (const s of shownScenes(view.state)) {
    if (s.from < top || s.from > bottom) continue;
    const isCollapsed = collapsed.has(s.id);
    const c = view.coordsAtPos(isCollapsed ? s.from : s.innerFrom, 1);
    if (!c) continue;
    const y = Math.max(floor, Math.round((c.top + c.bottom) / 2 - LABEL_HEIGHT / 2 - edges.baseTop)); // don't overlap the previous label
    floor = y + LABEL_HEIGHT;
    const n = neighbours.get(s.id)!;
    out.push(new LabelMarker(editor, s, editor.title(s.id), y, width,
      {collapsed: isCollapsed, active: s.id === active, split: s.id === active && sel.empty, mergePrevious: n.previous, mergeNext: n.next}));
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
  message(text: string): void;
}

/** "Ending" → "Ending (2)", "Ending (2)" → "Ending (3)". */
function nextTitle(title: string) {
  const m = /^(.*) \((\d+)\)$/.exec(title);
  return m ? `${m[1]} (${Number(m[2]) + 1})` : `${title} (2)`;
}

export class SceneEditor {
  readonly view: EditorView;
  private readonly extensions: Extension;
  private collapsed = new Set<string>();

  /** `titles` is shared with the app and outlives deletions, so undo can restore a scene with its name. */
  constructor(parent: HTMLElement, private readonly titles: Map<string, string>, readonly hooks: SceneHooks, extra: Extension = []) {
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
      keymap.of([
        {key: 'Mod-Shift-e', run: () => { this.newScene(); return true; }},
        {key: 'Mod-Shift-Enter', run: () => { this.split(); return true; }},
        {key: 'Mod-Shift-m', run: () => { this.mergeSelection(); return true; }},
        ...defaultKeymap, ...historyKeymap,
      ]),
      EditorView.lineWrapping,
      // Spelling is checked by Strand itself (see spelling.ts), so the browser's own checker stays off.
      EditorView.contentAttributes.of({spellcheck: 'false', autocapitalize: 'sentences'}),
      extra,
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

  private fail(message: string) { this.hooks.message(message); this.view.focus(); }
  /** Let the new scene's margin title get drawn, then ask for its name. */
  private askName(id: string) { requestAnimationFrame(() => requestAnimationFrame(() => this.hooks.rename(id))); }

  /** Which scene commands make sense for the current cursor or selection. */
  available() {
    const state = this.view.state, sel = state.selection.main, scene = sceneAt(state, sel.head);
    const neighbours = scene && sel.empty ? mergeableNeighbours(state).get(scene.id) : undefined;
    return {
      newScene: typeof this.newSceneRange() !== 'string',
      split: !!scene && sel.empty,
      mergePrevious: !!neighbours?.previous,
      mergeNext: !!neighbours?.next,
      merge: !sel.empty && typeof this.selectionGroup() !== 'string',
    };
  }

  /** The text New scene would wrap, or why it can't. */
  private newSceneRange(): {from: number; to: number} | string {
    const state = this.view.state, {scenes} = state.field(scenesField);
    const {from, to} = tighten(scenes, state.selection.main.from, state.selection.main.to);
    for (const s of scenes) {
      const apart = s.to <= from || s.from >= to, around = s.innerFrom <= from && to <= s.innerTo, within = from <= s.from && s.to <= to;
      if (!apart && !around && !within) return 'The selection crosses a scene boundary. Select text inside one scene.';
    }
    return {from, to};
  }

  /** Make the selection a new child scene where it stands; with no selection, insert an empty one. */
  newScene() {
    const range = this.newSceneRange();
    if (typeof range === 'string') return this.fail(range);
    const id = crypto.randomUUID();
    this.titles.set(id, 'New scene');
    this.structural('new', {
      changes: [{from: range.from, insert: startToken(id)}, {from: range.to, insert: endToken(id)}],
      selection: EditorSelection.cursor(range.from + startToken(id).length),
    });
    this.askName(id);
  }

  /** Split the scene the cursor is in: everything after the cursor becomes a new scene straight after it. */
  split() {
    const state = this.view.state, sel = state.selection.main, s = sceneAt(state, sel.head);
    if (!sel.empty) return this.fail('Split works at the cursor. Clear the selection first.');
    if (!s) return this.fail('Put the cursor inside a scene to split it. (To split the node you have open, open its parent.)');
    const id = crypto.randomUUID(), pos = sel.head, middle = endToken(s.id) + startToken(id);
    this.titles.set(id, nextTitle(this.title(s.id)));
    // The old closing token now closes the new scene; the cursor gets the old scene's closing token plus the new opening one.
    const changes = pos === s.innerTo
      ? [{from: s.innerTo, to: s.to, insert: middle + endToken(id)}]
      : [{from: pos, insert: middle}, {from: s.innerTo, to: s.to, insert: endToken(id)}];
    this.structural('split', {changes, selection: EditorSelection.cursor(pos + middle.length)});
    this.askName(id);
  }

  /** Merge a scene (default: the one the cursor is in) with the touching scene before (-1) or after (1) it. */
  mergeWith(direction: -1 | 1, id?: string) {
    const state = this.view.state, s = id ? this.scene(id) : sceneAt(state, state.selection.main.head);
    if (!s) return this.fail('Put the cursor inside a scene first.');
    const siblings = siblingsOf(state, s.parent), other = siblings[siblings.indexOf(s) + direction];
    const pair = other && (direction < 0 ? [other, s] : [s, other]);
    if (!pair || !touching(state, pair[0], pair[1])) return this.fail(`There’s no scene directly ${direction < 0 ? 'before' : 'after'} this one to merge with.`);
    this.mergeScenes(pair);
  }

  /** Merge every scene the selection runs across. */
  mergeSelection() {
    const group = this.selectionGroup();
    if (typeof group === 'string') return this.fail(group);
    this.mergeScenes(group);
  }

  /** The scenes a selection would merge: from the scene it starts in to the scene it ends in, which must
   *  share a parent and all touch. Scenes nested inside them simply come along. */
  private selectionGroup(): Scene[] | string {
    const state = this.view.state, {from, to} = state.selection.main, {scenes} = state.field(scenesField);
    let start: Scene | null = null, end: Scene | null = null;
    for (const s of scenes) { // later matches are nested deeper, so the last match is the innermost
      if (s.from <= from && from < s.to) start = s;
      if (s.from < to && to <= s.to) end = s;
    }
    if (!start || !end || start === end) return 'To merge, select from inside one scene into another.';
    if (start.parent !== end.parent) return 'To merge, the selection must start and end in scenes at the same level.';
    const siblings = siblingsOf(state, start.parent), group = siblings.slice(siblings.indexOf(start), siblings.indexOf(end) + 1);
    for (let i = 1; i < group.length; i++)
      if (!touching(state, group[i - 1], group[i])) return 'Only touching scenes can be merged. There’s other text between these.';
    return group;
  }

  /** Join touching sibling scenes into the first, which keeps its title. Blank space between them is kept. */
  private mergeScenes(group: readonly Scene[]) {
    const first = group[0], last = group[group.length - 1], changes: ChangeSpec[] = [];
    for (let i = 0; i + 1 < group.length; i++)
      changes.push({from: group[i].innerTo, to: group[i].to}, {from: group[i + 1].from, to: group[i + 1].innerFrom});
    changes.push({from: last.innerTo, to: last.to, insert: endToken(first.id)});
    const merged = group.slice(1).map(s => `“${this.title(s.id)}”`).join(', ');
    for (const s of group.slice(1)) this.collapsed.delete(s.id);
    this.structural('merge', {changes});
    this.hooks.message(`Merged ${merged} into “${this.title(first.id)}”.`);
    this.view.focus();
  }

  /** Delete a scene, its text and its sub-scenes. */
  remove(id: string) {
    const s = this.scene(id);
    if (!s) return;
    this.structural('delete', {changes: {from: s.from, to: s.to}});
    this.hooks.message(`Deleted “${this.title(id)}”. Ctrl+Z brings it back.`);
  }

  /** Remove a scene's boundary, leaving its text (and sub-scenes) in the parent. */
  mergeIntoParent(id: string) {
    const s = this.scene(id);
    if (!s) return;
    this.collapsed.delete(id);
    this.structural('merge', {changes: [{from: s.from, to: s.innerFrom}, {from: s.innerTo, to: s.to}]});
  }

  /** Move a scene before or after another scene, or to the end of one (target null = the opened node, 'inside'
   *  only). Returns false if either isn't in this document, so the caller can move it in the stored model instead. */
  place(id: string, target: string | null, where: Place): boolean {
    const state = this.view.state, s = this.scene(id), t = target === null ? null : this.scene(target);
    if (!s || (target === null ? where !== 'inside' : !t)) return false;
    const slice = (a: number, b: number) => state.sliceDoc(a, b);
    const inner = (scene: Scene | null | undefined): [number, number] => scene ? [scene.innerFrom, scene.innerTo] : [0, state.doc.length];
    const [start, end] = where === 'inside' ? inner(t) : inner(t!.parent === null ? null : this.scene(t!.parent));
    const at = where === 'inside' ? end : where === 'before' ? t!.from : t!.to;
    const [cutFrom, cutTo] = cutWithGap(slice, s.from, s.to, ...inner(s.parent === null ? null : this.scene(s.parent)));
    if (at >= cutFrom && at <= cutTo) return true; // already there
    const [lead, trail] = separators(slice, at, start, end);
    const changes = [{from: cutFrom, to: cutTo}, {from: at, insert: lead + slice(s.from, s.to) + trail}].sort((a, b) => a.from - b.from);
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
