// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PDFBlock } from "@neoread/core";
import {
  PDFTranslationBlock,
  type PDFBlockInteractions,
} from "./PDFTranslationBlock";
import { TranslationText } from "./TranslationText";

vi.mock("./TranslationText", () => ({
  TranslationText: vi.fn(() => <p>正文</p>),
}));

it("keeps unchanged paragraphs out of scroll and hover renders while using the latest interaction handlers", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"),
    root = createRoot(host);
  const interactions = {
    current: {
      double: false,
      pressed: { current: undefined },
      selecting: { current: false },
      clearSelection: vi.fn(),
      focus: vi.fn(),
      hover: vi.fn(),
      preview: vi.fn(),
      cite: vi.fn(),
      translate: vi.fn(),
    } satisfies PDFBlockInteractions,
  };
  const blocks = Array.from(
    { length: 200 },
    (_, index) =>
      ({
        id: String(index),
        text: "正文",
        page: 1,
        label: "text",
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      }) satisfies PDFBlock,
  );
  const render = (hovered = "") =>
    root.render(
      <>
        {blocks.map((block) => (
          <PDFTranslationBlock
            key={block.id}
            block={block}
            documentId="doc"
            annotated={false}
            hovered={hovered === block.id}
            focused={false}
            searchHit={false}
            imageScale={1}
            paused={false}
            interactions={interactions}
          />
        ))}
      </>,
    );
  try {
    await act(async () => render());
    expect(TranslationText).toHaveBeenCalledTimes(200);
    vi.mocked(TranslationText).mockClear();
    await act(async () => render());
    expect(TranslationText).not.toHaveBeenCalled();
    await act(async () => render("3"));
    expect(TranslationText).toHaveBeenCalledOnce();
    const updated = vi.fn();
    interactions.current.focus = updated;
    await act(async () =>
      host.querySelector<HTMLElement>('[data-translation-block="3"]')!.click(),
    );
    expect(updated).toHaveBeenCalledWith(blocks[3]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
