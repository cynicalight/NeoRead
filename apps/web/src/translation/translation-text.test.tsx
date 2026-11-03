// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslationText } from "./TranslationText";
import type { PDFBlock } from "@neoread/core";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const algorithm: PDFBlock = {
  id: "p7-b9",
  page: 7,
  label: "algorithm",
  text: "Algorithm 1: Read phase\n1 Function read(txn, record)\n2 latch(record)",
  bounds: { x: 0.5182, y: 0.1071, width: 0.3943, height: 0.2771 },
};
async function renderAlgorithm(
  block = algorithm,
  renderImage?: (id: string, width: number) => Promise<string>,
) {
  await act(async () =>
    root.render(
      <TranslationText
        block={block}
        documentId="doc"
        retry={() => {}}
        renderImage={renderImage}
        translation={{
          blockId: block.id,
          sourceHash: "old",
          status: "complete",
          sentences: [{ source: block.text, target: "不应显示的旧算法译文" }],
        }}
      />,
    ),
  );
}

it("displays the original algorithm crop without extracted code or stale translation", async () => {
  await renderAlgorithm({ ...algorithm, image: "assets/p7-b9.png" });
  expect(host.querySelector("img")?.getAttribute("src")).toContain(
    "assets/p7-b9.png",
  );
  expect(host.querySelector("pre")).toBeNull();
  expect(host.textContent).not.toContain("latch(record)");
  expect(host.textContent).not.toContain("旧算法译文");
});
