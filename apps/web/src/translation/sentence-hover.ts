import { reducedMotion } from "../motion";
import { formulaHighlightRules, markFormulas } from "./formula-highlight";

// ::highlight() cannot transition, so a fade steps each layer through
// pre-declared opacity levels by re-registering it under another name. That
// only repaints the highlighted text; no reader styles are recalculated.
const levels = 10;
const duration = 160;
const easeOut = (t: number) => 1 - (1 - t) ** 2;

type Layer = {
  key: string;
  slot: 0 | 1;
  highlight: Highlight;
  ranges: Range[];
  /** Registered highlight name; empty while fully transparent. */
  name: string;
  opacity: number;
  from: number;
  to: number;
  start: number;
};

/** Paint live text ranges so hover follows scrolling and text reflow natively. */
export class SentenceHover {
  private current?: Layer;
  private outgoing?: Layer;
  private dirty = false;
  private frame = 0;
  private style = document.createElement("style");

  constructor(
    private host: HTMLElement,
    private name: string,
  ) {
    const background = "var(--sentence-hover-background, rgb(128 128 128 / 22%))";
    const rules: string[] = [];
    for (const slot of [0, 1])
      for (let level = 1; level <= levels; level++) {
        const highlight = this.levelName(slot, level);
        const paint = `color-mix(in srgb, ${background} ${(level * 100) / levels}%, transparent)`;
        rules.push(
          `::highlight(${highlight}) { background-color: ${paint}; }`,
          `.textLayer ::highlight(${highlight}) { color: transparent; }`,
          ...formulaHighlightRules(highlight, { background: paint }),
        );
      }
    this.style.textContent = rules.join("\n");
    host.ownerDocument.head.append(this.style);
  }

  invalidate() {
    this.dirty = true;
  }

  show(key: string, ranges: Range[]) {
    if (key === this.current?.key && !this.dirty) return;
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
    if (this.current && key === this.current.key) {
      // Re-rendered text: swap ranges in place without restarting the fade.
      this.setRanges(this.current, visible);
      this.render(this.current, true);
      return;
    }
    if (this.current) this.retire(this.current);
    const layer: Layer = {
      key,
      slot: this.outgoing?.slot === 0 ? 1 : 0,
      highlight: new Highlight(),
      ranges: [],
      name: "",
      opacity: 0,
      from: 0,
      to: 0,
      start: 0,
    };
    this.setRanges(layer, visible);
    this.current = layer;
    this.fade(layer, 1);
  }

  clear() {
    if (this.current) this.retire(this.current);
    this.current = undefined;
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.drop(this.current);
    this.drop(this.outgoing);
    this.current = this.outgoing = undefined;
    this.style.remove();
  }

  private levelName(slot: number, level: number) {
    return `${this.name}-${slot}-${level}`;
  }

  private setRanges(layer: Layer, ranges: Range[]) {
    layer.ranges = ranges;
    layer.highlight.clear();
    for (const range of ranges) layer.highlight.add(range);
  }

  /** Fade the current layer out; at most one layer fades out at a time. */
  private retire(layer: Layer) {
    this.drop(this.outgoing);
    this.outgoing = layer;
    this.fade(layer, 0);
  }

  private fade(layer: Layer, to: number) {
    layer.from = layer.opacity;
    layer.to = to;
    layer.start = performance.now();
    if (reducedMotion()) {
      this.settle(layer, to);
      return;
    }
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.frame = 0;
    for (const layer of [this.current, this.outgoing]) {
      if (!layer || layer.opacity === layer.to) continue;
      const t = Math.min(1, Math.max(0, (now - layer.start) / duration));
      if (t === 1) this.settle(layer, layer.to);
      else {
        layer.opacity = layer.from + (layer.to - layer.from) * easeOut(t);
        this.render(layer);
      }
    }
    if (
      [this.current, this.outgoing].some((l) => l && l.opacity !== l.to)
    )
      this.frame = requestAnimationFrame(this.tick);
  };

  private settle(layer: Layer, opacity: number) {
    layer.opacity = opacity;
    if (opacity) this.render(layer);
    else {
      this.drop(layer);
      if (this.outgoing === layer) this.outgoing = undefined;
    }
  }

  private render(layer: Layer, ranges = false) {
    const level = Math.round(layer.opacity * levels);
    const name = level ? this.levelName(layer.slot, level) : "";
    if (name === layer.name && !ranges) return;
    if (layer.name && name !== layer.name) {
      CSS.highlights.delete(layer.name);
      markFormulas(this.host, layer.name, []);
    }
    if (name) {
      CSS.highlights.set(name, layer.highlight);
      markFormulas(this.host, name, layer.ranges);
    }
    layer.name = name;
  }

  private drop(layer?: Layer) {
    if (!layer?.name) return;
    CSS.highlights.delete(layer.name);
    markFormulas(this.host, layer.name, []);
    layer.name = "";
    layer.opacity = layer.to = 0;
  }
}
