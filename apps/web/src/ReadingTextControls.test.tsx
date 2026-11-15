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

it("gives reflowed PDF source the font, weight and size controls", () => {
  const node = render({ textReflow: true });
  expect(labels(node)).toEqual(
    expect.arrayContaining(["原文字体", "原文加粗", "译文字体"]),
  );
  expect(node.textContent).not.toContain("缩放");
});

it.each([true, false])(
  "keeps margin and line height in the layout section (reflow=%s)",
  (textReflow) => {
    const node = render({ textReflow });
    const layout = [...node.querySelectorAll("section")].find(
      (section) => section.querySelector("h4")?.textContent === "版面",
    )!;
    expect(labels(layout)).toEqual(["减小边距", "边距", "增大边距", "减小行距", "行距", "增大行距"]);
  },
);

it("keeps PDF page zoom without reflow", () => {
  const node = render({ textReflow: false });
  expect(node.textContent).toContain("缩放");
  expect(labels(node)).not.toContain("原文字体");
});
