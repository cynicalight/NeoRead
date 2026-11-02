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
  return fragment.textContent ?? "";
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
