// Rendered KaTeX splits a formula into many small, offset text runs. Painting
// those runs one by one leaves gaps and uneven heights, so every highlight
// treats a formula as one unit and paints its whole box instead.

const attribute = "data-formula-highlight";

/** The rendered formula containing `node`, if any. */
export function formulaOf(node: Node | null): HTMLElement | null {
  const element =
    node?.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : (node?.parentElement ?? null);
  return element?.closest<HTMLElement>(".katex") ?? null;
}

/** Every rendered formula a range touches, even partially. */
export function rangeFormulas(range: Range): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const node of [range.startContainer, range.endContainer]) {
    const formula = formulaOf(node);
    if (formula) found.add(formula);
  }
  const root = range.commonAncestorContainer;
  const element =
    root.nodeType === Node.ELEMENT_NODE
      ? (root as Element)
      : root.parentElement;
  element?.querySelectorAll<HTMLElement>(".katex").forEach((formula) => {
    if (range.intersectsNode(formula)) found.add(formula);
  });
  return [...found];
}

/**
 * Client rects of `ranges`, with each touched formula contributing its whole
 * box once instead of the rects of its text runs.
 */
export function formulaAwareRects(
  ranges: Range[],
  seen = new Set<HTMLElement>(),
): DOMRect[] {
  const rects: DOMRect[] = [];
  for (const range of ranges) {
    const formulas = rangeFormulas(range);
    if (!formulas.length) {
      rects.push(...Array.from(range.getClientRects()));
      continue;
    }
    for (const rect of textRects(range)) rects.push(rect);
    for (const formula of formulas) {
      if (seen.has(formula)) continue;
      seen.add(formula);
      rects.push(...Array.from(formula.getClientRects()));
    }
  }
  return rects;
}

// Rects of the text a range covers outside any formula.
function textRects(range: Range): DOMRect[] {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE)
    return formulaOf(root) ? [] : Array.from(range.getClientRects());
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!range.intersectsNode(node) || formulaOf(node)) continue;
    const part = document.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    rects.push(...Array.from(part.getClientRects()));
  }
  return rects;
}

/**
 * Marks the formulas `ranges` touch with highlight `name`, replacing the
 * formulas it marked before under `root`. CSS paints a marked formula's whole
 * box; see `formulaHighlightRules`.
 */
export function markFormulas(root: ParentNode, name: string, ranges: Range[]) {
  for (const formula of root.querySelectorAll<HTMLElement>(
    `.katex[${attribute}]`,
  ))
    setToken(formula, name, false);
  for (const range of ranges)
    for (const formula of rangeFormulas(range)) setToken(formula, name, true);
}

/** Removes every highlight name starting with `prefix` from formulas. */
export function clearFormulaMarks(root: ParentNode, prefix: string) {
  for (const formula of root.querySelectorAll<HTMLElement>(
    `.katex[${attribute}]`,
  )) {
    const tokens = formula.getAttribute(attribute)!.split(" ");
    const kept = tokens.filter((t) => !t.startsWith(prefix));
    if (kept.length === tokens.length) continue;
    if (kept.length) formula.setAttribute(attribute, kept.join(" "));
    else formula.removeAttribute(attribute);
  }
}

function setToken(formula: HTMLElement, name: string, on: boolean) {
  const tokens = new Set(
    (formula.getAttribute(attribute) ?? "").split(" ").filter(Boolean),
  );
  if (on === tokens.has(name)) return;
  if (on) tokens.add(name);
  else tokens.delete(name);
  if (tokens.size) formula.setAttribute(attribute, [...tokens].join(" "));
  else formula.removeAttribute(attribute);
}

/**
 * CSS for highlight `name`: the marked formula box takes the paint, and the
 * custom highlight no longer paints the formula's scattered text runs.
 */
export function formulaHighlightRules(
  name: string,
  paint: { background?: string; underline?: string },
  scope = "",
) {
  const prefix = scope ? `${scope} ` : "";
  const box = paint.underline
    ? `box-shadow: inset 0 -2px ${paint.underline};`
    : `background-color: ${paint.background}; border-radius: 2px;`;
  return [
    `${prefix}.katex[${attribute}~="${name}"] { ${box} }`,
    `${prefix}.katex ::highlight(${name}) { background-color: transparent; text-decoration: none; }`,
  ];
}
