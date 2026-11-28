import {el} from './dom';

export interface RenameOptions {
  left: number;
  top: number;
  width: number;
  value: string;
  /** Called with the new (trimmed, non-empty) title when the author confirms it. */
  commit(value: string): void;
  /** Called when the box closes. `refocus` is false if focus moved elsewhere (so it shouldn't be pulled back). */
  done(refocus: boolean): void;
}

/** A small text box floating over the screen, for renaming a scene in place. Enter or clicking away keeps the new
 *  title; Escape cancels. */
export function renameBox(o: RenameOptions) {
  const input = el('input', '', 'rename');
  input.setAttribute('aria-label', 'Scene title');
  input.value = o.value;
  Object.assign(input.style, {left: `${o.left}px`, top: `${o.top}px`, width: `${o.width}px`});
  document.body.append(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (keep: boolean, refocus: boolean) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    input.remove();
    if (keep && value) o.commit(value);
    o.done(refocus);
  };
  input.onkeydown = e => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    // Consume the key: focus moves back to the editor during this keypress, and the key would otherwise land
    // there too (an Enter would add a line break to the manuscript).
    e.preventDefault();
    e.stopPropagation();
    finish(e.key === 'Enter', true);
  };
  input.onblur = () => finish(true, false);
}
