/** Small DOM helpers shared by the UI. */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') {
  const e = document.createElement(tag);
  e.textContent = text;
  e.className = cls;
  return e;
}

/** A button that runs `fn` when clicked; any failure is shown to the user. */
export function button(text: string, fn: () => unknown, hint = '') {
  const b = el('button', text);
  if (hint) b.title = hint;
  b.onclick = () => { Promise.resolve().then(fn).catch(e => alert(String(e))); };
  return b;
}
