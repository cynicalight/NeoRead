/** The part of `range` that lies inside `node`. */
export function clipRange(node: Node, range: Range): Range {
  const clipped = document.createRange();
  clipped.selectNodeContents(node);
  if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0)
    clipped.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0)
    clipped.setEnd(range.endContainer, range.endOffset);
  return clipped;
}

/** UTF-16 offset of the start of `range` in the text of `node`. */
export function textOffset(node: Node, range: Range): number {
  const before = document.createRange();
  before.selectNodeContents(node);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}
