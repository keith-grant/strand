/*
 * Scene boundary markers. In the editor, each child scene sits between a pair of hidden tokens built from
 * private-use characters that never occur in normal text:
 *
 *   U+E000 <id> U+E002   opens a scene
 *   U+E001 <id> U+E002   closes it
 *
 * The tokens exist only in the editor. `expand` turns stored prose (with {{node:id}} references) into editor text,
 * and `serialize` turns it back.
 */
import {type Project, node, parts, reference} from '../model';

export const OPEN = String.fromCharCode(0xe000), CLOSE = String.fromCharCode(0xe001), STOP = String.fromCharCode(0xe002);
/** A whole token; group 1 is OPEN or CLOSE, group 2 the scene id. Global, so use with matchAll/replace only. */
export const TOKEN = new RegExp(`([${OPEN}${CLOSE}])([A-Za-z0-9-]+)${STOP}`, 'g');
/** Any marker character (not global, so safe for `test`). */
export const MARKER = new RegExp(`[${OPEN}-${STOP}]`);
const MARKERS = new RegExp(`[${OPEN}-${STOP}]`, 'g');

export const startToken = (id: string) => OPEN + id + STOP;
export const endToken = (id: string) => CLOSE + id + STOP;

/** Remove every token and stray marker character. */
export const stripMarkers = (text: string) => text.replace(TOKEN, '').replace(MARKERS, '');

/** Replace every token with spaces of the same length, so positions in the result still match the text. */
export const blankMarkers = (text: string) => MARKER.test(text) ? text.replace(TOKEN, m => ' '.repeat(m.length)).replace(MARKERS, ' ') : text;

/** Remove tokens, with a way to map a position in the result back to a position in `text`. */
export function withoutMarkers(text: string): {text: string; at: (pos: number) => number} {
  if (!MARKER.test(text)) return {text, at: pos => pos};
  const runs: {from: number; origin: number}[] = []; // where each kept stretch starts in the result, and in `text`
  let out = '', last = 0;
  const keep = (a: number, b: number) => {
    if (b > a) { runs.push({from: out.length, origin: a}); out += text.slice(a, b); }
  };
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

/** Editor text for a node: its prose with every descendant expanded in place between tokens. */
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
