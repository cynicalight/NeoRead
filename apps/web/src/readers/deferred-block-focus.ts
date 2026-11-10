// Leave time for a second click to select text before moving the document.
export class DeferredBlockFocus {
  private timer?: ReturnType<typeof setTimeout>;

  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  schedule(detail: number, action: () => void) {
    this.cancel();
    if (detail > 1) return;
    if (detail === 0) {
      action();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!window.getSelection()?.toString().trim()) action();
    }, 150);
  }
}
