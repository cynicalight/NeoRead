import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { MessageMarkdown, safeMarkdownURL } from "./MessageMarkdown";
import { markdownFixture } from "./fixtures";
import { nearBottom } from "./useChatScroll";
function render(content: string, generating = false) {
  return renderToStaticMarkup(
    <MessageMarkdown
      content={content}
      generating={generating}
      animated={false}
    />,
  );
}
describe("Markdown received source vs display", () => {
  it("renders external links as navigable anchors", () => {
    const dom = new JSDOM(render("[项目](https://example.com)"));
    const link = dom.window.document.querySelector<HTMLAnchorElement>("a");
    expect(link?.href).toBe("https://example.com/");
    expect(link?.target).toBe("_blank");
    dom.window.close();
  });
  it("renders incomplete delimiters without throwing", () => {
    for (const cut of [3, 49, 99, 512, 800])
      expect(() => render(markdownFixture.slice(0, cut), true)).not.toThrow();
  });
  it("resolves cross-block definitions, omits active HTML and never fetches model images", () => {
    const dom = new JSDOM(render(markdownFixture));
    expect(dom.window.document.querySelector("script,img,iframe")).toBeNull();
    expect(
      dom.window.document.querySelector(
        '[aria-label="复制链接 https://example.com"]',
      ),
    ).not.toBeNull();
    expect(
      dom.window.document.querySelector("[data-footnotes]"),
    ).not.toBeNull();
    dom.window.close();
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "//evil.com",
    "/api/private",
  ])("rejects unsafe URL %s", (url) => expect(safeMarkdownURL(url)).toBe(""));
  it("uses the sidebar bottom threshold", () => {
    expect(nearBottom(70, 200, 100)).toBe(false);
    expect(nearBottom(80, 200, 100)).toBe(true);
  });
});
