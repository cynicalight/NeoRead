// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { paper } from "../papers/fixtures";
import { CitationEditor, searchPapers } from "./CitationEditor";
import type { Citation } from "./codes";
import { DocumentPrefsDialog } from "./DocumentPrefsDialog";
import { createEngine } from "./engine";

const docs = [
  paper({
    id: "old",
    title: "Older paper",
    lastOpenedAt: "2026-01-01T00:00:00Z",
    metadata: { creators: [{ family: "Adams", given: "Ann" }], date: "2020" },
  }),
  paper({
    id: "new",
    title: "Recent transformer paper",
    lastOpenedAt: "2026-09-01T00:00:00Z",
    metadata: { creators: [{ family: "Zhou", given: "Li" }], date: "2024" },
  }),
  paper({ id: "book", title: "A book", library: "books" }),
  paper({ id: "gone", title: "Deleted paper", deletedAt: "2026-09-02" }),
];

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label || b.ariaLabel === label,
  )!;
const option = (title: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (b) => b.textContent?.startsWith(title),
  )!;
const input = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
async function type(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const key = (element: HTMLElement, name: string) =>
  act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true }),
    );
  });

it("lists library papers, recent first, and matches every word", () => {
  expect(searchPapers(docs, "").map((d) => d.id)).toEqual(["new", "old"]);
  expect(searchPapers(docs, "zhou 2024").map((d) => d.id)).toEqual(["new"]);
  expect(searchPapers(docs, "zhou 2020")).toEqual([]);
  expect(searchPapers(docs, "deleted")).toEqual([]);
});

it("builds a citation with the keyboard and a page locator", async () => {
  const engine = await createEngine("apa", "en-US");
  const done = vi.fn<(citation: Citation | null) => void>();
  await act(async () =>
    root.render(
      <CitationEditor
        documents={docs}
        initial={null}
        engine={engine}
        before={[]}
        after={[]}
        onDone={done}
      />,
    ),
  );
  const search = input("搜索论文");
  await type(search, "adams");
  await key(search, "Enter");
  expect(search.value).toBe("");
  await type(input("定位 Older paper"), "12");
  expect(document.querySelector('[aria-label="预览"]')?.textContent).toBe(
    "(Adams, 2020, p. 12)",
  );
  // Enter with an empty search inserts the citation.
  await key(search, "Enter");
  expect(done).toHaveBeenCalledOnce();
  expect(done.mock.calls[0][0]?.citationItems).toEqual([
    expect.objectContaining({ id: "old", locator: "12", label: "page" }),
  ]);
});

it("reorders papers and keeps that order", async () => {
  const engine = await createEngine("apa", "en-US");
  const done = vi.fn<(citation: Citation | null) => void>();
  await act(async () =>
    root.render(
      <CitationEditor
        documents={docs}
        initial={null}
        engine={engine}
        before={[]}
        after={[]}
        onDone={done}
      />,
    ),
  );
  await act(async () => option("Older paper").click());
  await act(async () => option("Recent transformer paper").click());
  await act(async () => button("上移 Recent transformer paper").click());
  await act(async () => button("插入").click());
  const citation = done.mock.calls[0][0]!;
  expect(citation.citationItems.map((i) => i.id)).toEqual(["new", "old"]);
  expect(citation.properties.unsorted).toBe(true);
});

it("defaults new documents to GB/T 7714 with automatic updates", async () => {
  const done = vi.fn();
  await act(async () =>
    root.render(<DocumentPrefsDialog current={null} onDone={done} />),
  );
  await act(async () => button("确定").click());
  expect(done).toHaveBeenCalledWith({
    styleId: "gb-t-7714-2015-numeric-bilingual",
    locale: "",
    noteType: 0,
    automaticUpdates: true,
  });
});
