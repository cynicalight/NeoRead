/**
 * Where each renderer currently shows the end of a noted annotation, so
 * annotation cards can sit at a remembered offset from it. A source returns an
 * anchor only while that end is visible inside its own scroll pane.
 */
/** A live annotation end that positioning reads on every update. */
export interface NoteAnchorElement {
  getBoundingClientRect(): DOMRect;
  /** Scroll and resize of this element's ancestors reposition the card. */
  contextElement: Element;
}
export interface NoteAnchor {
  rect: DOMRect;
  /**
   * CSS px per card unit: the PDF zoom, so cards scale with the page as if
   * embedded in it; 1 where the document does not zoom.
   */
  scale: number;
  /**
   * The PDF annotation end, read live. Cards anchor to it so positioning
   * tracks the PDF scroll container in the same frame.
   */
  element?: NoteAnchorElement;
  /** Cards render here, clipped to the reader viewport, instead of the body. */
  container?: HTMLElement;
}
export type NoteAnchorSource = (id: string) => NoteAnchor | undefined;

const sources = new Set<NoteAnchorSource>();
const listeners = new Set<() => void>();

export function noteAnchorsChanged() {
  listeners.forEach((listener) => listener());
}

export function addNoteAnchorSource(source: NoteAnchorSource) {
  sources.add(source);
  noteAnchorsChanged();
  return () => {
    sources.delete(source);
    noteAnchorsChanged();
  };
}

export function subscribeNoteAnchors(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function noteAnchor(id: string) {
  for (const source of sources) {
    const anchor = source(id);
    if (anchor) return anchor;
  }
}

/** `rect` when it has size and overlaps the visible part of `pane`. */
export function visibleIn(pane: Element, rect: DOMRect | undefined) {
  if (!rect || (!rect.width && !rect.height)) return;
  const view = pane.getBoundingClientRect();
  return rect.bottom > view.top &&
    rect.top < view.bottom &&
    rect.right > view.left &&
    rect.left < view.right
    ? rect
    : undefined;
}
