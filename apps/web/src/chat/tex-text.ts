// Rendered formulas keep their TeX on `data-tex` (see MathFormula), so copied
// text writes each formula back as $…$ instead of KaTeX's duplicated glyphs.

const mathOf = (node: Node) =>
  (node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement
  )?.closest("[data-tex]");

/** Text of `range`, each touched formula written whole as its TeX. */
export function texText(range: Range): string {
  // An end inside a formula takes the whole formula, wrapper included.
  const whole = range.cloneRange();
  const start = mathOf(range.startContainer),
    end = mathOf(range.endContainer);
  if (start) whole.setStartBefore(start);
  if (end) whole.setEndAfter(end);
  const copy = whole.cloneContents();
  for (const math of copy.querySelectorAll<HTMLElement>("[data-tex]"))
    math.replaceWith(
      math.classList.contains("display")
        ? `$$${math.dataset.tex}$$`
        : `$${math.dataset.tex}$`,
    );
  // Rendered off screen, innerText keeps the paragraph and line breaks that
  // textContent drops. Inside the selection's own container, CSS that hides
  // part of it (reflow translation-only source) still applies.
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;left:-99999px;top:0";
  box.append(copy);
  const root = whole.commonAncestorContainer;
  (root.nodeType === Node.ELEMENT_NODE
    ? (root as Element)
    : (root.parentElement ?? document.body)
  ).append(box);
  const text = box.innerText ?? box.textContent ?? "";
  box.remove();
  return text;
}

/** Copies selections that touch a formula as text with TeX. */
export function installTeXCopy(document: Document) {
  const copy = (event: ClipboardEvent) => {
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData)
      return;
    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer;
    const element =
      root.nodeType === Node.ELEMENT_NODE
        ? (root as Element)
        : root.parentElement;
    // Selections without formulas keep the browser's own copy.
    if (
      !element?.closest("[data-tex]") &&
      ![...(element?.querySelectorAll("[data-tex]") ?? [])].some((math) =>
        range.intersectsNode(math),
      )
    )
      return;
    event.clipboardData.setData("text/plain", texText(range));
    event.preventDefault();
  };
  document.addEventListener("copy", copy);
  return () => document.removeEventListener("copy", copy);
}
