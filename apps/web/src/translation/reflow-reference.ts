const name = "neoread-reference-flash";
const normalize = (value: string) =>
  value.toLowerCase().replace(/[\s\u00ad]/g, "");

/**
 * The range of `quote` inside `element`, compared without whitespace or soft
 * hyphens like the PDF location highlight; undefined when it is not present.
 */
export function quoteRange(element: Element, quote: string) {
  const needle = normalize(quote);
  if (!needle) return;
  const positions: { node: Text; offset: number }[] = [];
  let text = "";
  const walker = element.ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent ?? "";
    for (let offset = 0; offset < value.length; offset++) {
      const kept = normalize(value[offset]);
      if (!kept) continue;
      text += kept;
      positions.push({ node: node as Text, offset });
    }
  }
  const start = text.indexOf(needle);
  if (start < 0) return;
  const first = positions[start],
    last = positions[start + needle.length - 1];
  const range = element.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

let clearCurrent: (() => void) | undefined;

/**
 * Briefly marks a followed chat reference in reflowed text, matching the PDF
 * pane's transient navigation highlight: the quoted text when found, otherwise
 * the whole source paragraph.
 */
export function flashReflowReference(
  host: HTMLElement,
  blockId: string,
  quote: string,
) {
  clearCurrent?.();
  const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  if (!registry || typeof Highlight === "undefined") return;
  const id = CSS.escape(blockId);
  const element =
    host.querySelector(`[data-reflow-source="${id}"]`) ??
    host.querySelector(`[data-reflow-block="${id}"]`);
  if (!element) return;
  let range = quoteRange(element, quote);
  if (!range) {
    range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
  }
  const highlight = new Highlight(range);
  registry.set(name, highlight);
  const clear = () => {
    clearTimeout(timer);
    if (registry.get(name) === highlight) registry.delete(name);
    if (clearCurrent === clear) clearCurrent = undefined;
  };
  const timer = setTimeout(clear, 3000);
  clearCurrent = clear;
}
