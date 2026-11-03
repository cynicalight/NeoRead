import { memo, type RefObject } from "react";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
import { TranslationText } from "./TranslationText";

export type PDFBlockInteractions = {
  pressed: RefObject<{ id: string; x: number; y: number } | undefined>;
  selecting: RefObject<boolean>;
  focus: (block: PDFBlock) => void;
  hover: (id?: string) => void;
  preview: (block: PDFBlock) => void;
  cite: (id: string, label: string) => void;
  translate: (id: string) => void;
};

/** Scrolling and pointer movement only update the affected blocks, not the article. */
export const PDFTranslationBlock = memo(function PDFTranslationBlock({
  block,
  translation,
  documentId,
  number,
  annotated,
  hovered,
  focused,
  searchHit,
  renderImage,
  releaseImage,
  paused,
  interactions,
}: {
  block: PDFBlock;
  translation?: TranslationBlock;
  documentId: string;
  number?: string;
  annotated: boolean;
  hovered: boolean;
  focused: boolean;
  searchHit: boolean;
  renderImage?: (id: string, width: number, owner?: string) => Promise<string>;
  releaseImage?: (id: string, owner?: string) => void;
  paused: boolean;
  interactions: RefObject<PDFBlockInteractions>;
}) {
  return (
    <section
      data-translation-block={block.id}
      data-block-kind={block.image ? "image" : "text"}
      data-label={block.label}
      data-hovered={hovered || undefined}
      data-focused={focused || undefined}
      data-search-hit={searchHit || undefined}
      aria-current={focused || undefined}
      tabIndex={0}
      onClick={(event) => {
        const action = interactions.current;
        const pressed = action.pressed.current;
        action.pressed.current = undefined;
        if (event.detail > 1) return;
        if (
          (event.target as Element).closest(
            "a, button, input, textarea, select, [role=button], [contenteditable=true]",
          ) ||
          window.getSelection()?.toString().trim() ||
          (event.detail > 0 &&
            (!pressed ||
              pressed.id !== block.id ||
              Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) >
                5))
        )
          return;
        action.focus(block);
      }}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          interactions.current.focus(block);
        }
      }}
      onPointerEnter={(event) => {
        if (!event.buttons && !interactions.current.selecting.current)
          interactions.current.hover(block.id);
      }}
      onPointerMove={(event) => {
        if (!event.buttons && !interactions.current.selecting.current)
          interactions.current.hover(block.id);
      }}
      onPointerLeave={() => interactions.current.hover()}
      className={annotated ? "translation-annotated" : ""}
    >
      <TranslationText
        block={block}
        onCitation={(id, label) => interactions.current.cite(id, label)}
        formulaNumber={number}
        translation={translation}
        documentId={documentId}
        renderImage={renderImage}
        releaseImage={releaseImage}
        onPreview={() => interactions.current.preview(block)}
        retry={() => interactions.current.translate(block.id)}
        paused={paused}
      />
      {annotated && (
        <span
          className="translation-note-indicator"
          title="此段有已保存的标注"
          aria-label="此段有已保存的标注"
        />
      )}
    </section>
  );
});
