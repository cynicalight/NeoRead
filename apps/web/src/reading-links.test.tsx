// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageMarkdown } from "./chat/MessageMarkdown";
import type { Root } from "mdast";
import { ReadingLinkNavigation, remarkReadingCitations } from "./reading-links";
import { installPDFExternalLinks } from "./readers/pdf-external-links";
vi.mock("./chat/clipboard", () => ({ copyText: vi.fn(async () => true) }));
const openExternal = vi.fn(async () => {});
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(window, "readerDesktop", {
    configurable: true,
    value: { openExternal },
  });
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  host.remove();
  Object.defineProperty(window, "readerDesktop", {
    configurable: true,
    value: undefined,
  });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("opens translated links in the system browser and routes citations without touching inline code", async () => {
  const navigate = vi.fn();
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ReadingLinkNavigation.Provider value={navigate}>
          <MessageMarkdown
            content="见 [6, 7]。`[8]` [项目](https://example.com/。)"
            citationBlockId="p1-b1"
          />
        </ReadingLinkNavigation.Provider>,
      ),
    );
    const external = host.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com/"]',
    )!;
    expect(external).toBeTruthy();
    external.click();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/",
    );
    const citations = host.querySelectorAll<HTMLAnchorElement>(
      'a[href^="#reader-citation?"]',
    );
    expect(citations).toHaveLength(2);
    citations[0].click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("p1-b1", "6");
    expect(host.querySelector("code")?.textContent).toBe("[8]");
  } finally {
    await act(async () => root.unmount());
  }
});
it("preserves current PDF.js internal links", async () => {
  host.innerHTML =
    '<div class="annotationLayer"><section><a href="https://example.com/">项目</a></section><section data-internal-link><a href="http://127.0.0.1/#cite.six">[6]</a></section></div>';
  let cleanup: (() => void) | undefined;
  try {
    await act(async () => {
      cleanup = installPDFExternalLinks(host);
    });
    host.querySelector<HTMLAnchorElement>("a")!.click();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/",
    );
    const internal = host.querySelector<HTMLAnchorElement>(
      "[data-internal-link] a",
    )!;
    const nativeClick = vi.fn((event: MouseEvent) => {
      expect(event.defaultPrevented).toBe(false);
      event.preventDefault();
    });
    internal.addEventListener("click", nativeClick);
    internal.click();
    expect(nativeClick).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => cleanup?.());
  }
});
it("renders citation-linked text containing inline math", async () => {
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MessageMarkdown
          content="延迟为 $O(n)$，见 [3]。"
          citationBlockId="p1-b1"
        />,
      ),
    );
    // The lazy formula renders its source as a fallback first.
    expect(host.textContent).toContain("O(n)");
    expect(host.querySelectorAll('a[href^="#reader-citation?"]')).toHaveLength(
      1,
    );
  } finally {
    await act(async () => root.unmount());
  }
});

const paragraph = (...children: unknown[]) =>
  ({
    type: "root",
    children: [{ type: "paragraph", children }],
  }) as Root;
const run = (tree: Root) => {
  remarkReadingCitations({ blockId: "p1-b1" })(tree);
  return tree;
};
const plain = (node: unknown): string => {
  const n = node as { value?: string; children?: unknown[] };
  return n.value ?? n.children?.map(plain).join("") ?? "";
};
const citations = (node: unknown): string[] => {
  const n = node as { type: string; url?: string; children?: unknown[] };
  if (n.type === "link" && n.url?.startsWith("#reader-citation?"))
    return [new URLSearchParams(n.url.split("?")[1]).get("label")!];
  return n.children?.flatMap(citations) ?? [];
};
it("expands citation ranges and keeps the written separators", () => {
  const tree = run(
    paragraph({ type: "text", value: "见 [3–5, 8] 与 [1，2]。" }),
  );
  expect(plain(tree)).toBe("见 [3, 4, 5, 8] 与 [1，2]。");
  expect(citations(tree)).toEqual(["3", "4", "5", "8", "1", "2"]);
});
it("links only the ends of descending or very long ranges", () => {
  const tree = run(paragraph({ type: "text", value: "[1-100] [9–7]" }));
  expect(plain(tree)).toBe("[1-100] [9–7]");
  expect(citations(tree)).toEqual(["1", "100", "9", "7"]);
});
it("finds citations inside emphasis but leaves math, code and links alone", () => {
  const math = { type: "inlineMath", value: "x_[1]" };
  const tree = run(
    paragraph(
      { type: "strong", children: [{ type: "text", value: "[2]" }] },
      math,
      { type: "inlineCode", value: "[8]" },
      {
        type: "link",
        url: "https://example.com",
        children: [{ type: "text", value: "[9]" }],
      },
    ),
  );
  expect(citations(tree)).toEqual(["2"]);
  expect(math).toEqual({ type: "inlineMath", value: "x_[1]" });
  expect(plain(tree)).toBe("[2]x_[1][8][9]");
});
it("leaves the tree unchanged without a source block", () => {
  const tree = paragraph({ type: "text", value: "[3]" });
  remarkReadingCitations({})(tree);
  expect(citations(tree)).toEqual([]);
});

it("keeps figure brackets distinct from bibliography citations", () => {
  const value = "如图三，Figure 3、figure[3] 和 Fig. 3(a)，参考文献 [3]。";
  const tree = run(paragraph({ type: "text", value }));
  expect(plain(tree)).toBe(value);
  expect(citations(tree)).toEqual([
    "figure:3",
    "figure:3",
    "figure:3",
    "figure:3",
    "3",
  ]);
});

it("renders bracketed figure references as one keyboard-accessible link", async () => {
  const navigate = vi.fn();
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ReadingLinkNavigation.Provider value={navigate}>
          <MessageMarkdown
            content="如图三，figure[3]，`Figure 4`，见 [3]。"
            citationBlockId="body"
          />
        </ReadingLinkNavigation.Provider>,
      ),
    );
    const links = host.querySelectorAll<HTMLAnchorElement>(
      'a[href^="#reader-citation?"]',
    );
    expect(Array.from(links, (link) => link.textContent)).toEqual([
      "图三",
      "figure[3]",
      "3",
    ]);
    links[1].click();
    expect(navigate).toHaveBeenCalledWith("body", "figure:3");
  } finally {
    await act(async () => root.unmount());
  }
});
