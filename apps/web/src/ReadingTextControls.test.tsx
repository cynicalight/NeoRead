// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defaultTheme, type ReaderTheme } from "@neoread/core";
import { ReadingTextControls } from "./ReadingTextControls";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
});
const render = (theme: Partial<ReaderTheme>) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ReadingTextControls
        theme={{ ...defaultTheme, ...theme }}
        setTheme={() => {}}
        docType="pdf"
      />,
    ),
  );
  return host;
};
const labels = (node: HTMLElement) =>
  [...node.querySelectorAll("[aria-label], [data-slot=slider] *")].map((e) =>
    e.getAttribute("aria-label"),
  );

it("gives reflowed PDF source the font, weight, size and column margin controls", () => {
  const node = render({ textReflow: true });
  expect(labels(node)).toEqual(
    expect.arrayContaining(["原文字体", "原文加粗", "译文字体", "边距"]),
  );
  expect(node.textContent).toContain("版面");
  expect(node.textContent).not.toContain("缩放");
  expect(labels(node)).not.toContain("译文边距");
});

it("keeps PDF page zoom and the translation margin without reflow", () => {
  const node = render({ textReflow: false });
  expect(node.textContent).toContain("缩放");
  expect(labels(node)).toContain("译文边距");
  expect(labels(node)).not.toContain("原文字体");
});
