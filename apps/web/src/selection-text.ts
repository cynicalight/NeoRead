/** Keep paragraph boundaries after replacing rendered math with its source. */
function fragmentText(root: Node): string {
  let text = "";
  let pendingBreak = 0;
  const append = (value: string, literal = false) => {
    if (pendingBreak && !literal && !value.trim()) return;
    if (text && pendingBreak) {
      const trailing = text.match(/\n*$/)![0].length;
      text += "\n".repeat(Math.max(0, pendingBreak - trailing));
    }
    pendingBreak = 0;
    text += value;
  };
  const visit = (node: Node, inSentence = false, pre = false) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.textContent ?? "", pre);
      return;
    }
    const element = node instanceof Element ? node : undefined;
    if (element?.localName === "br") {
      append("\n", true);
      return;
    }
    const sentence = inSentence || !!element?.matches(".translation-sentence");
    const block =
      !!element &&
      (element.matches(
        "section, article, blockquote, pre, h1, h2, h3, h4, h5, h6, ul, ol, li, tr, .katex-display",
      ) ||
        (!sentence && element.matches("p, div")));
    if (block) pendingBreak = 2;
    for (const child of node.childNodes)
      visit(child, sentence, pre || element?.localName === "pre");
    if (block) pendingBreak = 2;
  };
  visit(root);
  return text;
}

/** Copy KaTeX once: inline math uses $, display formulas use $$. */
export function selectionText(range: Range): string {
  const element = (node: Node) =>
    node instanceof Element ? node : node.parentElement;
  const original = element(range.startContainer)?.closest(
    ".translation-formula-source",
  );
  const originalOnly =
    original &&
    original ===
      element(range.endContainer)?.closest(".translation-formula-source");
  const enclosingMath = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest(".katex");
  const selected = range.cloneRange();
  const startControl = element(selected.startContainer)?.closest(
    "button, summary, [data-copy-ignore]",
  );
  const endControl = element(selected.endContainer)?.closest(
    "button, summary, [data-copy-ignore]",
  );
  if (startControl && startControl === endControl) return "";
  if (startControl) selected.setStartAfter(startControl);
  if (endControl) selected.setEndBefore(endControl);
  const start = enclosingMath(selected.startContainer);
  const end = enclosingMath(selected.endContainer);
  if (start) selected.setStartBefore(start);
  if (end) selected.setEndAfter(end);
  const fragment = selected.cloneContents();
  for (const control of fragment.querySelectorAll(
    "button, summary, [data-copy-ignore]",
  ))
    control.remove();
  if (!originalOnly)
    for (const source of fragment.querySelectorAll(
      ".translation-formula-source",
    ))
      source.remove();
  for (const formula of fragment.querySelectorAll(".katex")) {
    const source = formula.querySelector(
      'annotation[encoding="application/x-tex"]',
    )?.textContent;
    if (source != null) {
      const delimiter = formula.querySelector('math[display="block"]')
        ? "$$"
        : "$";
      formula.replaceWith(
        document.createTextNode(`${delimiter}${source.trim()}${delimiter}`),
      );
    }
  }
  return fragmentText(fragment);
}

export function installFormulaClipboard() {
  const copy = (event: ClipboardEvent) => {
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData)
      return;
    const range = selection.getRangeAt(0);
    const parent =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (
      !parent?.closest(
        ".katex, .translation-formula, .translation-formula-source, [data-copy-ignore]",
      ) &&
      !Array.from(
        parent?.querySelectorAll(
          ".katex, .translation-formula, .translation-formula-source, [data-copy-ignore]",
        ) ?? [],
      ).some((formula) => range.intersectsNode(formula))
    )
      return;
    event.clipboardData.setData("text/plain", selectionText(range));
    event.preventDefault();
  };
  document.addEventListener("copy", copy);
  return () => document.removeEventListener("copy", copy);
}
