import type { PDFBlock, PDFLocation, ReaderSelection } from "@neoread/core";
import { selectionContext } from "../readers/selection-context";
import { texText } from "../chat/tex-text";
import { clipRange, textOffset } from "./dom-ranges";
import { needsSpace, sentenceNodes } from "./reflow";
import { restoredSelection } from "./reflow-alignment";

/**
 * A selection of reflowed PDF source text. Each touched paragraph becomes a
 * source anchor, which the PDF view also resolves in its text layer.
 */
export function reflowSourceSelection(
  host: HTMLElement,
  range: Range,
  blocks: PDFBlock[],
): ReaderSelection | undefined {
  const anchors: NonNullable<PDFLocation["sourceAnchors"]> = [];
  for (const node of host.querySelectorAll<HTMLElement>(
    "[data-reflow-source]",
  )) {
    if (!range.intersectsNode(node)) continue;
    const block = blocks.find((b) => b.id === node.dataset.reflowSource);
    if (!block) continue;
    const source = selectedSource(node, range).trim();
    if (source) {
      const clipped = clipRange(node, range);
      const start = textOffset(node, clipped);
      anchors.push({
        blockId: block.id,
        source,
        page: block.page,
        bounds: block.bounds,
        start,
        end: start + clipped.toString().length,
        text: node.textContent ?? "",
      });
    }
  }
  // Read text keeps restored formulas as TeX; anchors keep extracted text.
  const text = texText(range).trim();
  if (!anchors.length || !text) return;
  const rect = range.getBoundingClientRect();
  return {
    context: selectionContext(range, host),
    text,
    anchor: {
      x: (rect.left + rect.right) / 2,
      top: rect.top,
      bottom: rect.bottom,
    },
    location: {
      type: "pdf",
      page: anchors[0].page,
      quote: anchors.map((a) => a.source).join(" "),
      sourceAnchors: anchors,
    },
  };
}

const clip = (node: Node, range: Range) => clipRange(node, range).toString();

/**
 * Selected extracted text of one reflowed paragraph; a restored sentence maps
 * its selection back through its alignment.
 */
function selectedSource(node: HTMLElement, range: Range) {
  const sentences = sentenceNodes(node);
  if (!sentences.some((s) => s.dataset.anchor)) return clip(node, range);
  return sentences
    .filter((s) => range.intersectsNode(s))
    .map((s) =>
      s.dataset.anchor ? restoredSelection(s, range) : clip(s, range),
    )
    .reduce(
      (all, next) =>
        all + (all && next && needsSpace(all, next) ? " " : "") + next,
      "",
    );
}
