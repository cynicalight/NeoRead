// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import { toast } from "sonner";
import type { Document } from "@reader/core";
import { LibraryDocuments } from "./LibraryDocuments";
import { useReaderStore } from "./store";
vi.mock("@reader/api", () => ({
  api: {
    trashDocument: vi.fn(),
    restoreDocument: vi.fn(),
    trash: vi.fn(async () => []),
    documents: vi.fn(async () => []),
    processingUsage: vi.fn(),
    chatUsage: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("./ProcessingStatus", () => ({ CoverProcessing: () => null }));
const docs: Document[] = ["Alpha", "Beta"].map((title, i) => ({
  id: String(i),
  title,
  author: "",
  type: "epub",
  category: "book",
  categorySource: "manual",
  classificationStatus: "done",
  classificationError: "",
  library: "books",
  metadata: {},
  readingStatus: "unread",
  noteCount: 0,
  highlightCount: 0,
  openQuestionCount: 0,
  related: [],
  folders: [],
  tags: [],
  size: 100,
  createdAt: "",
  lastOpenedAt: "",
  favorite: false,
  percentage: 0,
}));
let root: Root, host: HTMLDivElement;
const openMany = vi.fn();
const open = vi.fn(),
  edit = vi.fn();
function Harness() {
  const documents = useReaderStore((s) => s.documents);
  return (
    <LibraryDocuments
      documents={documents}
      libraryView="grid"
      jobs={[]}
      processingError=""
      openDocument={open}
      openDocuments={openMany}
      favorite={() => {}}
      onEdit={edit}
      onSettings={() => {}}
    />
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  vi.mocked(api.chatUsage).mockResolvedValue({
    historyComplete: true,
    total: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      reasoningOutputTokens: null,
    },
    calls: [],
    groups: [],
    stages: [{ stage: "chat", durationMs: 0 }],
    unknownCalls: 0,
    failedCalls: 0,
    partialCalls: 0,
    elapsedMs: 0,
  });
  useReaderStore.setState({ documents: docs });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
it("moves selected documents to the trash, keeps failures and offers an undo", async () => {
  await act(async () => button("编辑").click());
  await act(async () =>
    host.querySelector("article")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(host.textContent).toContain("已选 2 份");
  vi.mocked(api.trashDocument).mockImplementation(async (id) => {
    if (id === "1") throw Error("offline");
    return docs[0];
  });
  await act(async () => button("移到回收站").click());
  expect(useReaderStore.getState().documents.map((d) => d.id)).toEqual(["1"]);
  expect(toast.error).toHaveBeenCalledWith(
    "1 份未能移到回收站，已保留，可重试",
  );
  expect(button("完成")).toBeDefined();
  expect(host.textContent).toContain("已选 1 份");
  const undo = vi.mocked(toast.success).mock.calls[0];
  expect(undo[0]).toBe("已将 1 份移到回收站");
  const action = (undo[1] as unknown as { action: { onClick: () => void } })
    .action;
  await act(async () => action.onClick());
  expect(api.restoreDocument).toHaveBeenCalledExactlyOnceWith("0");
  expect(open).not.toHaveBeenCalled();
});
it("leaves selection mode after all selected documents move to the trash", async () => {
  await act(async () => button("编辑").click());
  await act(async () =>
    host.querySelector("article")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  vi.mocked(api.trashDocument).mockResolvedValue(docs[0]);

  await act(async () => button("移到回收站").click());

  expect(button("编辑")).toBeDefined();
  expect(host.textContent).not.toContain("已选");
});
it("opens the context menu on the targeted document and edits that document", async () => {
  const card = host.querySelectorAll("article")[1];
  await act(async () =>
    card.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 50,
      }),
    ),
  );
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((el) => el.textContent?.includes("编辑文档信息"));
  expect(item).toBeDefined();
  await act(async () => item!.click());
  expect(edit).toHaveBeenCalledExactlyOnceWith("1");
  expect(open).not.toHaveBeenCalled();
});

it("requires edit mode before selecting and clears selection on exit", async () => {
  const shortcut = () =>
    host.querySelector("article")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  expect(host.querySelector('[role="checkbox"]')).toBeNull();
  await act(async () => {
    shortcut();
  });
  expect(host.textContent).not.toContain("已选");
  await act(async () => button("编辑").click());
  await act(async () => {
    shortcut();
  });
  expect(host.textContent).toContain("已选 2 份");
  await act(async () => button("完成").click());
  expect(host.querySelector('[role="checkbox"]')).toBeNull();
  await act(async () => button("编辑").click());
  expect(host.textContent).toContain("已选 0 份");
});

it("opens the selected documents together in tabs", async () => {
  await act(async () => button("编辑").click());
  await act(async () =>
    host
      .querySelector("article")!
      .dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "a",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
  );
  await act(async () => button("在标签页中打开").click());
  expect(openMany).toHaveBeenCalledExactlyOnceWith(docs);
});
