// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { MessageMarkdown } from "./MessageMarkdown";
import { ChatCitationNavigation } from "./citations";

vi.mock("./MathFormula", () => ({
  default: ({ value, display }: { value: string; display: boolean }) => (
    <span data-math={display ? "display" : "inline"}>{value}</span>
  ),
}));
vi.mock("./CodeBlock", () => ({
  default: ({ content }: { content: string }) => <pre>{content}</pre>,
}));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
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
const render = (content: string, generating = false) =>
  act(async () =>
    root.render(
      <MessageMarkdown
        content={content}
        generating={generating}
        animated={false}
      />,
    ),
  );

it("recognizes Codex math without interpreting code, literal brackets or escaped delimiters", async () => {
  await render(
    String.raw`行内 \(T_i\)，独立 \[\operatorname{VG}(a)>\operatorname{VG}(c_{\mathrm{canonical}})\]，美元 $x$。

\[
\begin{matrix}a & b \\ c & d\end{matrix}
\]

普通 [a+b]，转义 \\(not math\\)。` +
      "\n`\\(code\\)`\n\n```text\n\\[code\\]\n```",
  );
  expect(
    [...host.querySelectorAll("[data-math]")].map((e) => [
      e.getAttribute("data-math"),
      e.textContent,
    ]),
  ).toEqual([
    ["inline", "T_i"],
    [
      "display",
      String.raw`\operatorname{VG}(a)>\operatorname{VG}(c_{\mathrm{canonical}})`,
    ],
    ["inline", "x"],
    ["display", String.raw`\begin{matrix}a & b \\ c & d\end{matrix}`],
  ]);
  expect(host.textContent).toContain("普通 [a+b]");
  expect(host.querySelector("code")?.textContent).toBe(String.raw`\(code\)`);
  expect(host.querySelector("pre")?.textContent).toContain(
    String.raw`\[code\]`,
  );
});

it("renders completed delimiters after arbitrary streaming cuts, including long answers", async () => {
  const text = String.raw`公式 \[a_1 + \frac{b}{c}\] 和 \(x\)`;
  for (let i = 1; i <= text.length; i++) await render(text.slice(0, i), true);
  expect(host.querySelectorAll("[data-math]")).toHaveLength(2);
  await render("前文。".repeat(12000) + "\n\n" + text);
  expect(host.querySelectorAll("[data-math]")).toHaveLength(2);
});

it("uses the same formula and citation rules in the animated streaming renderer", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  await act(async () =>
    root.render(
      <MessageMarkdown content={String.raw`\(x_1\) citeS64`} generating />,
    ),
  );
  expect(host.querySelector('[data-animated="true"]')).not.toBeNull();
  expect(host.querySelector('[data-math="inline"]')?.textContent).toBe("x_1");
  expect(host.textContent).toContain("[S64]");
});

it.each(["x\n- y", "x\n> y", "x\n\n+ y", "x\n# y"])(
  "protects display math from Markdown block syntax: %s",
  async (value) => {
    await render("\\[\n" + value + "\n\\]\n\n正常段落");
    expect(host.querySelector('[data-math="display"]')?.textContent).toBe(
      value,
    );
    expect(host.querySelector("ul,blockquote,h1")).toBeNull();
    expect(host.textContent).toContain("正常段落");
  },
);

it.each(["", "ci", "cite", "filecite", "cite", "citeS999citeS64"])(
  "does not expose damaged citation markers: %s",
  async (marker) => {
    await render("结论 " + marker, true);
    expect(host.textContent).not.toContain("");
    expect(host.querySelector('a[href^="#reader-evidence?"]')).toBeNull();
  },
);

it("shows readable citation labels in a stream and only links saved known sources", async () => {
  const content = "结论 citeS64S65，另见 [S64]。`citeS64`";
  for (const part of ["结论 citeS", "结论 citeS64", content])
    await render(part, true);
  expect(host.querySelectorAll('a[href^="#reader-evidence?"]')).toHaveLength(0);
  expect(host.textContent).toContain("结论 [S64][S65]");
  const navigate = vi.fn();
  await act(async () =>
    root.render(
      <ChatCitationNavigation.Provider value={{ sourceIds: ["S64"], navigate }}>
        <MessageMarkdown
          content={content + " [伪造](#reader-evidence?source=S999)"}
        />
      </ChatCitationNavigation.Provider>,
    ),
  );
  const links = host.querySelectorAll<HTMLAnchorElement>(
    'a[href^="#reader-evidence?"]',
  );
  expect(links).toHaveLength(2);
  links[0].click();
  expect(navigate).toHaveBeenCalledExactlyOnceWith("S64");
  expect(host.querySelector("code")?.textContent).toBe("citeS64");
});
