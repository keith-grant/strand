/*
 * The book tree in the sidebar: every node with its word count, the open node highlighted, nodes without prose of
 * their own in grey. Drag a node onto the top or bottom edge of another to place it before or after it, or onto the
 * middle to put it inside.
 */
import {type Place, type Project, type WordTotals, children, node, subtree} from '../model';
import {button, el} from './dom';

export interface TreeHooks {
  open(id: string): void;
  move(id: string, target: string, where: Place): void;
}

const DRAG = 'application/x-strand-node';
/** The node being dragged, and everything under it (which it can't be dropped onto). */
let dragging: {id: string; subtree: Set<string>} | null = null;

/** Which part of a row the pointer is over: top quarter = before, bottom quarter = after, otherwise inside. */
function dropPlace(e: DragEvent, row: HTMLElement, id: string, root: string): Place | null {
  if (!dragging || dragging.subtree.has(id)) return null;
  if (id === root) return 'inside';
  const r = row.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
  return y < .25 ? 'before' : y > .75 ? 'after' : 'inside';
}

export function renderTree(container: HTMLElement, book: {project: Project; totals: WordTotals; openId: string}, hooks: TreeHooks) {
  const {project, totals, openId} = book;
  container.setAttribute('aria-label', 'Book');
  container.replaceChildren(el('h2', 'Manuscript'));
  const branch = (id: string, depth: number) => {
    const n = node(project, id), t = totals.get(id);
    const row = button('', () => hooks.open(id), id === project.root ? 'Open' : 'Open. Drag to move: drop on the top or bottom edge of another node to place it before or after, or on the middle to put it inside.');
    row.className = 'tree-node' + (id === openId ? ' open' : '') + (t && t.own === 0 ? ' no-prose' : '');
    row.dataset.node = id;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.append(el('span', n.title || 'Untitled', 'name'), el('span', t ? t.total.toLocaleString() : '', 'count'));
    if (id === openId) row.setAttribute('aria-current', 'true');
    if (id !== project.root) {
      row.draggable = true;
      row.ondragstart = e => { dragging = {id, subtree: new Set(subtree(project, id))}; e.dataTransfer?.setData(DRAG, id); };
      row.ondragend = () => { dragging = null; };
    }
    const clear = () => row.classList.remove('drop-before', 'drop-after', 'drop-inside');
    row.ondragover = e => {
      const where = dropPlace(e, row, id, project.root);
      clear();
      if (!where) return;
      e.preventDefault();
      row.classList.add(`drop-${where}`);
    };
    row.ondragleave = clear;
    row.ondrop = e => {
      const where = dropPlace(e, row, id, project.root), src = dragging?.id;
      clear();
      if (!where || !src) return;
      e.preventDefault();
      hooks.move(src, id, where);
    };
    container.append(row);
    children(n).forEach(c => branch(c, depth + 1));
  };
  branch(project.root, 0);
}
