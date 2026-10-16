/** Keep context local to the rendered page/chapter and the exact DOM range. */
export function selectionContext(range: Range, root: Node) {
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const after = range.cloneRange();
  after.selectNodeContents(root);
  after.setStart(range.endContainer, range.endOffset);
  return {
    before: nearbyWords(contextText(before), true),
    after: nearbyWords(contextText(after), false),
  };
}

export function nearbyWords(text: string, before: boolean) {
  // Bound punctuation-only input too. Han characters count individually.
  text = before ? text.slice(-4000) : text.slice(0, 4000);
  const words = [
    ...text.matchAll(/\p{Script=Han}|[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu),
  ];
  if (words.length > 30) {
    text = before
      ? text.slice(words[words.length - 30].index)
      : text.slice(0, words[30].index);
  }
  return text.trim();
}

// Range.toString() merges adjacent paragraphs and PDF text spans without spaces.
function contextText(range: Range) {
  const fragment = range.cloneContents();
  for (const element of fragment.querySelectorAll(
    "p,div,li,br,section,h1,h2,h3,h4,h5,h6,span[role=presentation]",
  )) {
    element.append(element.ownerDocument.createTextNode(" "));
  }
  return fragment.textContent ?? "";
}
