// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PaperNoteMarkdown } from "./PaperNoteMarkdown";
import { openExternalLink } from "./reading-links";
vi.mock("./reading-links", () => ({ openExternalLink: vi.fn() }));
it("renders Markdown structure while keeping HTML and internal or unsafe links inert", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PaperNoteMarkdown
        body={
          "# Heading\n\n- **strong**\n\n> quote\n\n```js\n<script>alert(1)</script>\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(2)</script>\n<img src=x onerror=alert(3)>\n\n[external](https://example.com) [source](reader://document/p?a=1) [citation](#reader-citation?block=a) [bad](javascript:alert%281%29)\n\n![secret](https://example.com/tracker.png)"
        }
      />,
    ),
  );
  expect(host.querySelector("h1")?.textContent).toBe("Heading");
  expect(host.querySelector("li strong")?.textContent).toBe("strong");
  expect(host.querySelector("table td")?.textContent).toBe("1");
  expect(host.querySelector("pre code")?.textContent).toContain(
    "<script>alert(1)</script>",
  );
  expect(host.querySelector("script, img, iframe")).toBeNull();
  expect(host.querySelectorAll("a")).toHaveLength(1);
  expect(host.textContent).toContain("source");
  expect(host.textContent).toContain("citation");
  host.querySelector("a")!.click();
  expect(openExternalLink).toHaveBeenCalledWith("https://example.com");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
