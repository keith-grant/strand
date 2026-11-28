/*
 * How scenes are drawn: a thin coloured tick at each boundary, a one-line summary in place of a collapsed scene,
 * tinted bands behind each scene (drawn like a text selection, so a scene that starts or ends mid-line changes
 * colour mid-line), and scene titles in the left margin with their menus.
 */
import {EditorSelection, StateField, type EditorState, type Extension, type Range} from '@codemirror/state';
import {Decoration, EditorView, RectangleMarker, WidgetType, layer, type DecorationSet, type LayerMarker, type ViewUpdate} from '@codemirror/view';
import {wordCount} from '../model';
import {stripMarkers} from './markers';
import {type Scene, collapsedField, mergeableNeighbours, sceneAt, shownScenes} from './scenes';

/** What the drawn parts need from the editor. */
export interface SceneActions {
  title(id: string): string;
  reveal(id: string): void;
  toggle(id: string): void;
  open(id: string): void;
  rename(id: string): void;
  split(): void;
  mergeWith(direction: -1 | 1, id: string): void;
  mergeIntoParent(id: string): void;
  remove(id: string): void;
}

// ---- Widgets ----

class BoundaryWidget extends WidgetType {
  constructor(readonly actions: SceneActions, readonly id: string, readonly hue: number, readonly emptyTitle: string | null) { super(); }
  eq(o: BoundaryWidget) { return o.id === this.id && o.hue === this.hue && o.emptyTitle === this.emptyTitle; }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.dataset.scene = this.id;
    const tick = wrap.appendChild(document.createElement('span'));
    tick.className = `cm-boundary h${this.hue}`;
    if (this.emptyTitle !== null) {
      const hint = wrap.appendChild(document.createElement('span'));
      hint.className = 'cm-empty-scene';
      hint.textContent = this.emptyTitle;
      hint.title = 'Empty scene. Click to write in it.';
      hint.addEventListener('mousedown', e => { e.preventDefault(); this.actions.reveal(this.id); });
    }
    return wrap;
  }
}

class CollapsedWidget extends WidgetType {
  constructor(readonly actions: SceneActions, readonly id: string, readonly title: string, readonly words: number, readonly hue: number) { super(); }
  eq(o: CollapsedWidget) { return o.id === this.id && o.title === this.title && o.words === this.words && o.hue === this.hue; }
  toDOM() {
    const chip = document.createElement('span');
    chip.className = `cm-collapsed h${this.hue}`;
    chip.dataset.scene = this.id;
    chip.textContent = `▸ ${this.title} · ${this.words.toLocaleString()} words`;
    chip.title = 'Collapsed scene. Click to expand.';
    chip.addEventListener('mousedown', e => { e.preventDefault(); this.actions.toggle(this.id); });
    return chip;
  }
}

function buildDecorations(state: EditorState, actions: SceneActions): DecorationSet {
  const collapsed = state.field(collapsedField), ranges: Range<Decoration>[] = [];
  for (const s of shownScenes(state)) {
    if (collapsed.has(s.id)) {
      const words = wordCount(stripMarkers(state.sliceDoc(s.innerFrom, s.innerTo)));
      ranges.push(Decoration.replace({widget: new CollapsedWidget(actions, s.id, actions.title(s.id), words, s.hue)}).range(s.from, s.to));
    } else {
      const empty = s.innerFrom === s.innerTo ? actions.title(s.id) : null;
      ranges.push(Decoration.replace({widget: new BoundaryWidget(actions, s.id, s.hue, empty)}).range(s.from, s.innerFrom));
      ranges.push(Decoration.replace({widget: new BoundaryWidget(actions, s.id, s.hue, null)}).range(s.innerTo, s.to));
    }
  }
  return Decoration.set(ranges, true);
}

// ---- Bands and margin titles ----

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
  constructor(readonly actions: SceneActions, readonly scene: Scene, readonly title: string, readonly top: number,
              readonly width: number, readonly flags: LabelFlags) {}

  eq(other: LayerMarker) {
    const o = other as LabelMarker;
    return o.scene.id === this.scene.id && o.scene.hue === this.scene.hue && o.scene.depth === this.scene.depth && o.title === this.title
      && o.top === this.top && o.width === this.width && (Object.keys(this.flags) as (keyof LabelFlags)[]).every(k => o.flags[k] === this.flags[k]);
  }

  draw() {
    const {actions, scene} = this, id = scene.id;
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
      action('Open', 'Open this scene on its own', () => actions.open(id)),
      action('Rename', 'Rename this scene (or double-click its title)', () => actions.rename(id)),
      action('Split here', 'Split this scene at the cursor (Ctrl+Shift+Enter)', () => actions.split(), 'split'),
      action('Merge with previous', 'Join this scene onto the end of the scene before it, which keeps its title', () => actions.mergeWith(-1, id), 'merge-previous'),
      action('Merge with next', 'Join the next scene onto the end of this one', () => actions.mergeWith(1, id), 'merge-next'),
      action('Merge with parent', 'Remove this scene’s boundary. Its text stays where it is, as part of the scene around it.', () => actions.mergeIntoParent(id)),
      action('Delete', 'Delete this scene and its text (Ctrl+Z to undo)', () => actions.remove(id)),
    );
    const name = document.createElement('span');
    name.className = 'name';
    name.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    name.addEventListener('click', () => actions.reveal(id));
    name.addEventListener('dblclick', () => actions.rename(id));
    box.append(menu, action('', '', () => actions.toggle(id), 'toggle'), name);
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

function labelMarkers(view: EditorView, actions: SceneActions): LayerMarker[] {
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
    out.push(new LabelMarker(actions, s, actions.title(s.id), y, width,
      {collapsed: isCollapsed, active: s.id === active, split: s.id === active && sel.empty, mergePrevious: n.previous, mergeNext: n.next}));
  }
  return out;
}

const layerNeedsUpdate = (u: ViewUpdate) =>
  u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged || u.transactions.some(tr => tr.effects.length > 0);

/** Everything that draws scenes: boundary and collapsed-scene widgets (which the cursor steps over as a unit),
 *  the coloured bands, and the margin titles. */
export function sceneView(actions: SceneActions): Extension {
  const decorations = StateField.define<DecorationSet>({
    create: state => buildDecorations(state, actions),
    update: (deco, tr) => tr.docChanged || tr.effects.length ? buildDecorations(tr.state, actions) : deco,
    provide: f => [EditorView.decorations.from(f), EditorView.atomicRanges.of(view => view.state.field(f))],
  });
  return [
    decorations,
    layer({above: false, class: 'cm-scene-bands', markers: bandMarkers, update: layerNeedsUpdate}),
    layer({above: true, class: 'cm-scene-labels', markers: view => labelMarkers(view, actions), update: layerNeedsUpdate}),
  ];
}

export const sceneTheme = EditorView.theme({
  '&': {backgroundColor: 'transparent'},
  '&.cm-focused': {outline: 'none'},
  '.cm-scroller': {fontFamily: 'inherit'},
  '.cm-content': {fontFamily: 'Georgia, "Times New Roman", serif', fontSize: '17px', lineHeight: '1.65', padding: '4px 0 40vh', caretColor: '#252925'},
  '.cm-line': {padding: '0 40px 0 var(--margin, 180px)'},
  '.cm-placeholder': {color: '#9a9d94', fontStyle: 'italic'},
});
