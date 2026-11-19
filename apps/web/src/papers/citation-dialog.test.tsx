// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyText } from "../chat/clipboard";
import { useReaderStore } from "../store";
import { CitationDialog } from "./CitationDialog";
import { paper } from "./fixtures";
vi.mock("@neoread/api", () => ({
  api: { saveLibraryPreferences: vi.fn(async (value) => value) },
}));
vi.mock("../chat/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const docs = [
  paper({
    id: "z",
    title: "Zebra paper",
    metadata: { creators: [{ family: "Zhou", given: "Li" }], date: "2020" },
  }),
  paper({
    id: "a",
    title: "Apple paper",
    metadata: {
      creators: [{ family: "Adams", given: "Ann" }],
      date: "2022",
      venue: "Nature",
    },
  }),
];
let root: Root, host: HTMLDivElement;
const edit = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  useReaderStore.setState({
    libraryPreferences: { papers: { citationStyle: "bibtex" } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <CitationDialog
        docs={docs}
        title="ML"
        onClose={() => {}}
        onEdit={edit}
      />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});
const preview = () =>
  document.querySelector<HTMLTextAreaElement>('[aria-label="引用预览"]')!.value;
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label || b.ariaLabel === label,
  )!;
it("orders by author, reorders by hand and copies the preview", async () => {
  await vi.waitFor(() =>
    expect(preview()).toContain("@article{adams2022apple"),
  );
  expect(preview().indexOf("adams")).toBeLessThan(preview().indexOf("zhou"));
  await act(async () => button("下移 Apple paper").click());
  await vi.waitFor(() =>
    expect(preview().indexOf("zhou")).toBeLessThan(preview().indexOf("adams")),
  );
  await act(async () => button("复制").click());
  expect(copyText).toHaveBeenCalledWith(preview());
});
it("switches to GB/T 7714 and sends incomplete papers to the editor", async () => {
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((b) => b.textContent === "GB/T 7714")!
      .click(),
  );
  await vi.waitFor(() => expect(preview()).toMatch(/^\[1\] ADAMS A/));
  expect(document.body.textContent).toContain("缺出处");
  await act(async () => button("去补").click());
  expect(edit).toHaveBeenCalledExactlyOnceWith(docs[0]);
});
