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
 * Translation-pane hover, kept out of React state so a hover never re-renders
 * the paragraph list. It marks the hovered paragraph with data-hovered and
 * moves one shared toolbar into it. As the paragraph's child the toolbar keeps
 * the pointer inside the paragraph while it travels to the buttons, and
 * paragraph clicks ignore it.
 */
export class TranslationHover<B extends Block> {
  private host = document.createElement("div");
  private root = createRoot(this.host);
  private block?: B;
  private id?: string;
  private marked?: HTMLElement;

  constructor(private onAction: (block: B, action: PDFBlockAction) => void) {
    this.host.className = "translation-block-actions";
  }

  /** Marks the paragraph of `blockId`; `actions` also shows the toolbar in it. */
  set(
    pane: HTMLElement | null | undefined,
    blockId: string | undefined,
    blocks: readonly B[],
    actions: boolean,
  ) {
    // Pointer moves repeat the same paragraph; skip the lookup for them.
    const paragraph =
      blockId && blockId === this.id && this.marked?.isConnected
        ? this.marked
        : blockId
          ? (pane?.querySelector<HTMLElement>(
              `section[data-translation-block=${JSON.stringify(blockId)}]`,
            ) ?? undefined)
          : undefined;
    this.id = blockId;
    if (paragraph !== this.marked) {
      this.marked?.removeAttribute("data-hovered");
      paragraph?.setAttribute("data-hovered", "true");
      this.marked = paragraph;
    }
    if (!actions || !paragraph) {
      this.hideActions();
      return;
    }
    if (this.host.parentElement === paragraph) return;
    const block = blocks.find((b) => b.id === blockId);
    if (!block) {
      this.hideActions();
      return;
    }
    if (this.block !== block) {
      this.block = block;
      this.root.render(
        createElement(BlockActions<B>, { block, onAction: this.onAction }),
      );
    }
    paragraph.append(this.host);
  }

  clear() {
    this.set(undefined, undefined, [], false);
  }

  /** Hides the toolbar but keeps the hovered paragraph marked. */
  hideActions() {
    this.host.remove();
  }

  destroy() {
    this.clear();
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
