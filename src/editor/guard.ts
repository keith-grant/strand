/*
 * The guard: ordinary edits (typing, deleting, cutting, pasting, dropping) keep every boundary token, and the hidden
 * text of collapsed scenes, intact, and can't smuggle tokens in. Only structural commands and undo/redo, which are
 * let through untouched, change the scene structure. Text typed over a selection lands where the kept text starts.
 */
import {EditorSelection, EditorState, Transaction, type ChangeSpec} from '@codemirror/state';
import {MARKER, stripMarkers} from './markers';
import {collapsedField, isStructural, scenesField} from './scenes';

/** The ranges ordinary edits may not touch: every token, and the whole of each collapsed scene. Sorted, merged. */
export function protectedRanges(state: EditorState): [number, number][] {
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

/** The parts of [from,to) outside the given sorted ranges. */
export function subtract(from: number, to: number, ranges: [number, number][]): [number, number][] {
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

export const guard = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || isStructural(tr)) return tr;
  let risky = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => { if (toA > fromA || MARKER.test(inserted.toString())) risky = true; });
  if (!risky) return tr; // plain typing: nothing can be deleted

  const keep = protectedRanges(tr.startState), specs: ChangeSpec[] = [];
  let modified = false, caret = -1, typed = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.toString(), clean = stripMarkers(text);
    const pieces = subtract(fromA, toA, keep);
    const untouched = toA > fromA ? pieces.length === 1 && pieces[0][0] === fromA && pieces[0][1] === toA : pieces.length === 0;
    if (clean !== text || !untouched) modified = true;
    caret = pieces.length ? pieces[0][0] : fromA;
    typed = clean.length;
    if (!pieces.length && clean) specs.push({from: fromA, insert: clean});
    pieces.forEach(([a, b], i) => specs.push({from: a, to: b, insert: i === 0 ? clean : ''}));
  });
  if (!modified) return tr;
  const changes = tr.startState.changes(specs);
  if (changes.empty) return {}; // e.g. Backspace at the very start of a scene: nothing to do
  // The cursor goes after whatever was typed, so typing carries on in order.
  return {changes, selection: EditorSelection.cursor(changes.mapPos(caret, -1) + typed), userEvent: tr.annotation(Transaction.userEvent), scrollIntoView: tr.scrollIntoView};
});
