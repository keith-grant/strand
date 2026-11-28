/** The status bar: a line of facts about the book, plus a short-lived message. */
export class StatusBar {
  private note = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `describe` gives the facts to show, in order; empty ones are skipped. */
  constructor(readonly element: HTMLElement, private readonly describe: () => (string | false | null | undefined)[]) {
    element.setAttribute('role', 'status');
  }

  /** Show a message for a few seconds. */
  say(text: string) {
    this.note = text;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.note = ''; this.update(); }, 6000);
    this.update();
  }

  update() {
    this.element.textContent = [...this.describe(), this.note].filter(Boolean).join('  •  ');
  }
}
