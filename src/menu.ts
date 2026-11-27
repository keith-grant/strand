/*
 * A small popup menu, used for the editor's right-click menu. Items can also arrive later (`load`), e.g. spelling
 * suggestions, which are fetched while the menu is already showing.
 */
export type MenuItem =
  | {label: string; run: () => void; disabled?: boolean; hint?: string; strong?: boolean}
  | {label: string; disabled: true}
  | {load: Promise<MenuItem[]>; placeholder: string}
  | 'separator';

let current: {close(): void} | null = null;

export function showMenu(x: number, y: number, items: MenuItem[], onClose: () => void) {
  current?.close();
  const menu = document.createElement('div');
  menu.className = 'popup-menu';
  menu.setAttribute('role', 'menu');

  const render = (item: MenuItem): HTMLElement[] => {
    if (item === 'separator') {
      const hr = document.createElement('div');
      hr.className = 'separator';
      return [hr];
    }
    if ('load' in item) {
      const slot = document.createElement('div');
      slot.className = 'pending';
      slot.textContent = item.placeholder;
      item.load
        .then(loaded => { if (slot.isConnected) { slot.replaceWith(...loaded.flatMap(render)); place(); } })
        .catch(() => { slot.textContent = 'Couldn’t get suggestions'; });
      return [slot];
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = item.label;
    b.setAttribute('role', 'menuitem');
    b.disabled = !('run' in item) || !!item.disabled;
    if ('run' in item) {
      if (item.hint) b.title = item.hint;
      if (item.strong) b.classList.add('strong');
      b.addEventListener('mousedown', e => e.preventDefault()); // keep the editor's selection
      b.addEventListener('click', () => { close(); item.run(); });
    }
    return [b];
  };
  menu.append(...items.flatMap(render));
  // Drop separators that would sit at the top, bottom or next to each other.
  [...menu.children].forEach((child, i, all) => {
    if (child.className === 'separator' && (i === 0 || i === all.length - 1 || all[i - 1].className === 'separator')) child.remove();
  });
  document.body.append(menu);

  /** Keep the menu on screen. */
  function place() {
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, y + r.height > innerHeight - 4 ? y - r.height : y)}px`;
  }
  place();

  const buttons = () => [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = buttons(), i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  };
  const onPointer = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) close(); };
  const onBlur = () => close();

  function close() {
    if (current !== handle) return;
    current = null;
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onPointer, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
    document.removeEventListener('wheel', onBlur, true);
    onClose();
  }
  const handle = {close};
  current = handle;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onPointer, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  document.addEventListener('wheel', onBlur, true);
}
