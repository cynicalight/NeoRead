import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type {
  EPUBReadingBlock,
  PDFBlock,
  PDFBlockAction,
  ReaderSelection,
  TranslationBlock,
} from "@neoread/core";
import { BlockActions } from "../BlockActions";
import { copyText } from "../chat/clipboard";
import { restoredSource, translatedText } from "./reflow";

type Block = PDFBlock | EPUBReadingBlock;

/**
 * One toolbar for the whole translation pane, moved into the hovered
 * paragraph. As the paragraph's child it keeps the pointer inside the
 * paragraph while it travels to the buttons, and paragraph clicks ignore it.
 */
export class TranslationBlockActions<B extends Block> {
  private host = document.createElement("div");
  private root = createRoot(this.host);
  private block?: B;

  constructor(private onAction: (block: B, action: PDFBlockAction) => void) {
    this.host.className = "translation-block-actions";
  }

  /** Moves into the paragraph of `blockId`, or hides without one. */
  hover(
    pane: HTMLElement | null | undefined,
    blockId: string | undefined,
    blocks: readonly B[],
  ) {
    const paragraph = blockId
      ? pane?.querySelector<HTMLElement>(
          `section[data-translation-block=${JSON.stringify(blockId)}]`,
        )
      : undefined;
    const block = paragraph && blocks.find((b) => b.id === blockId);
    if (!paragraph || !block) {
      this.hide();
      return;
    }
    if (this.block !== block) {
      this.block = block;
      this.root.render(
        createElement(BlockActions<B>, { block, onAction: this.onAction }),
      );
    }
    if (this.host.parentElement !== paragraph) paragraph.append(this.host);
  }

  hide() {
    this.host.remove();
  }

  destroy() {
    this.host.remove();
    // Unmounting during a React commit warns; the root is ours alone.
    queueMicrotask(() => this.root.unmount());
  }
}

/** A paragraph's complete translation as a quote anchored to the translation. */
export function blockTranslationQuote(
  block: Block,
  translation?: TranslationBlock,
): ReaderSelection | undefined {
  const text = translatedText(translation);
  if (!translation || !text) return;
  const mark = {
    blockId: block.id,
    sourceHash: translation.sourceHash,
    sentenceIndexes: translation.sentences.map((_, index) => index),
    start: 0,
    end: text.length,
  };
  return {
    text,
    location:
      "location" in block
        ? { ...block.location, translation: mark }
        : {
            type: "pdf",
            page: block.page,
            rects: [block.bounds],
            translation: mark,
          },
  };
}

/**
 * Translation-pane actions: copy gives the translation, ask-AI quotes the
 * source and translation together. Images keep their source actions.
 */
export function translationBlockAction<B extends Block>(
  block: B,
  action: PDFBlockAction,
  translation: TranslationBlock | undefined,
  forward: (
    block: B,
    action: PDFBlockAction,
    translation?: ReaderSelection,
  ) => void,
) {
  if (block.image) {
    forward(block, action);
    return;
  }
  if (action === "copy") {
    // Formulas, references and unfinished paragraphs copy their source.
    void copyText(
      translatedText(translation) || restoredSource(block.text, translation),
    );
    return;
  }
  forward(block, action, blockTranslationQuote(block, translation));
}
