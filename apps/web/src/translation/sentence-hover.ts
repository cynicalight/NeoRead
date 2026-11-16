import { formulaHighlightRules, markFormulas } from "./formula-highlight";

/** Paint live text ranges so hover follows scrolling and text reflow natively. */
export class SentenceHover {
  private key = "";
  private dirty = false;
  private highlight = new Highlight();
  private style = document.createElement("style");

  constructor(
    private host: HTMLElement,
    private name: string,
  ) {
    const background = "var(--sentence-hover-background, rgb(128 128 128 / 22%))";
    this.style.textContent = [
      `::highlight(${name}) { background-color: ${background}; }`,
      `.textLayer ::highlight(${name}) { color: transparent; }`,
      ...formulaHighlightRules(name, { background }),
    ].join("\n");
    host.ownerDocument.head.append(this.style);
  }

  invalidate() {
    this.dirty = true;
  }

  show(key: string, ranges: Range[]) {
    if (key === this.key && this.highlight.size && !this.dirty) return;
    this.dirty = false;
    const visible = ranges.filter((range) => {
      const element =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : (range.startContainer as Element);
      return this.host.contains(element) && !element?.closest("[inert]");
    });
    if (!visible.length) {
      this.clear();
      return;
    }
    this.highlight.clear();
    for (const range of visible) this.highlight.add(range);
    CSS.highlights.set(this.name, this.highlight);
    markFormulas(this.host, this.name, visible);
    this.key = key;
  }

  clear() {
    this.key = "";
    this.highlight.clear();
    CSS.highlights.delete(this.name);
    markFormulas(this.host, this.name, []);
  }

  destroy() {
    this.clear();
    this.style.remove();
  }
}
