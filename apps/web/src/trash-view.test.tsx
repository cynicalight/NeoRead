// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import type { Document } from "@neoread/core";
import { discardPaperNotes } from "./paper-note-state";
import { TrashView } from "./TrashView";
import { useReaderStore } from "./store";
vi.mock("@neoread/api", () => ({
  api: {
    restoreDocument: vi.fn(),
    removeDocument: vi.fn(),
    emptyTrash: vi.fn(),
    trash: vi.fn(async () => []),
    documents: vi.fn(async () => []),
  },
}));
vi.mock("./paper-note-state", () => ({ discardPaperNotes: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const trashed = (id: string, title: string) =>
  ({
    id,
    title,
    author: "Ada",
    type: "pdf",
    library: "papers",
    deletedAt: "2026-10-08T10:00:00Z",
  }) as Document;
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  useReaderStore.setState({ libraryPreferences: { mode: "papers" } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <TrashView documents={[trashed("a", "Alpha"), trashed("b", "Beta")]} />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});
const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) => b.textContent?.trim() === label,
  );
it("restores one document from the trash", async () => {
  await act(async () => button("恢复")[1].click());
  expect(api.restoreDocument).toHaveBeenCalledExactlyOnceWith("b");
  expect(api.removeDocument).not.toHaveBeenCalled();
});
it("purges only after confirmation", async () => {
  await act(async () => button("彻底删除")[0].click());
  expect(api.removeDocument).not.toHaveBeenCalled();
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("彻底删除 1 份");
  await act(async () => button("彻底删除", dialog)[0].click());
  expect(api.removeDocument).toHaveBeenCalledExactlyOnceWith("a");
  expect(discardPaperNotes).toHaveBeenCalledExactlyOnceWith(["a"]);
});
it("empties the current library's trash in one request", async () => {
  await act(async () => button("清空回收站")[0].click());
  const dialog = document.querySelector('[role="alertdialog"]')!;
  await act(async () => button("彻底删除", dialog)[0].click());
  expect(api.emptyTrash).toHaveBeenCalledExactlyOnceWith("papers");
  expect(discardPaperNotes).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
});

it("retains pending notes if permanent deletion fails", async () => {
  vi.mocked(api.removeDocument).mockRejectedValueOnce(new Error("disk error"));
  await act(async () => button("彻底删除")[0].click());
  const dialog = document.querySelector('[role="alertdialog"]')!;
  await act(async () => button("彻底删除", dialog)[0].click());
  expect(discardPaperNotes).not.toHaveBeenCalled();
});
