// @vitest-environment jsdom
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme, type Document } from "@neoread/core";
import { TooltipProvider } from "@neoread/ui/components/tooltip";
import { paper } from "./papers/fixtures";
import { useReaderStore } from "./store";
import { DocumentTabs, ReadingWorkspaces } from "./DocumentTabs";
import { registerTabCloseGuard } from "./document-tab-guards";
import { flushProgress } from "./progress";
import { toast } from "sonner";
import { forwardReaderShortcut } from "./shortcuts/shortcuts";
const fixture = vi.hoisted(() => ({
  mounts: [] as string[],
  unmounts: [] as string[],
  documents: [] as Document[],
}));
vi.mock("@neoread/api", () => ({
  api: { documents: vi.fn(async () => fixture.documents) },
}));
vi.mock("./progress", () => ({ flushProgress: vi.fn(async () => {}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("./Workspace", () => ({
  Workspace: ({ document: doc }: { document: Document }) => {
    const [draft, setDraft] = useState("");
    const current = useRef(draft);
    current.current = draft;
    useEffect(() => {
      fixture.mounts.push(doc.id);
      const remove = registerTabCloseGuard(doc.id, () =>
        current.current ? { message: "未发送内容" } : null,
      );
      return () => {
        fixture.unmounts.push(doc.id);
        remove();
      };
    }, []);
    return (
      <input
        aria-label={`问题 ${doc.id}`}
        value={draft}
        onInput={(event) => setDraft(event.currentTarget.value)}
      />
    );
  },
}));
let root: Root, host: HTMLDivElement;
const docs = [
  paper({ id: "a", title: "Alpha" }),
  paper({ id: "b", title: "Beta" }),
  paper({ id: "c", title: "Gamma" }),
];
function Harness() {
  const s = useReaderStore();
  return (
    <TooltipProvider>
      <DocumentTabs
        onSelect={s.open}
        onLibrary={() => s.open(null)}
        onNew={() => s.open(null)}
      />
      <ReadingWorkspaces
        theme={s.theme}
        jobs={[]}
        onLibrary={() => s.open(null)}
        onSettings={() => {}}
      />
    </TooltipProvider>
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.mounts.length = 0;
  fixture.unmounts.length = 0;
  fixture.documents = docs;
  useReaderStore.setState({
    documents: docs,
    tabIds: [],
    visitedTabs: [],
    active: null,
    closedTabGroups: [],
    sessionReady: true,
    theme: { ...defaultTheme, documentTabs: true },
  });
  useReaderStore.getState().openMany(docs);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const el = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) =>
      button.getAttribute("aria-label") === label ||
      button.textContent === label,
  )!;
  expect(el).toBeTruthy();
  await act(async () => el.click());
}
it("loads restored tabs lazily and keeps drafts/readers alive when switching or returning to the library", async () => {
  expect(fixture.mounts).toEqual(["a"]);
  const input = host.querySelector<HTMLInputElement>('[aria-label="问题 a"]')!;
  await act(async () => {
    input.value = "unfinished";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Beta");
  expect(fixture.mounts).toEqual(["a", "b"]);
  expect(input.closest<HTMLElement>('[role="tabpanel"]')!.hidden).toBe(true);
  expect(fixture.unmounts).toEqual([]);
  await click("Alpha");
  expect(input.value).toBe("unfinished");
  await click("返回书库");
  expect(useReaderStore.getState().active).toBeNull();
  expect(useReaderStore.getState().tabIds).toHaveLength(3);
  expect(fixture.unmounts).toEqual([]);
});
it("warns before discarding a background draft and disposes only the explicitly closed tab", async () => {
  const input = host.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    input.value = "draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Beta");
  await click("关闭标签页：Alpha");
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await click("返回阅读");
  expect(fixture.unmounts).toEqual([]);
  await click("关闭标签页：Alpha");
  await click("关闭标签页");
  expect(fixture.unmounts).toEqual(["a"]);
  expect(useReaderStore.getState().active?.id).toBe("b");
  expect(useReaderStore.getState().tabIds).toEqual(["b", "c"]);
});
it("keeps tabs open if progress cannot be saved and supports cycling/numbered keyboard navigation", async () => {
  vi.mocked(flushProgress).mockRejectedValueOnce(new Error("offline"));
  await click("关闭标签页：Alpha");
  expect(useReaderStore.getState().tabIds).toContain("a");
  expect(toast.error).toHaveBeenCalled();
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        ctrlKey: true,
        cancelable: true,
      }),
    ),
  );
  expect(useReaderStore.getState().active?.id).toBe("b");
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "9",
        metaKey: true,
        cancelable: true,
      }),
    ),
  );
  expect(useReaderStore.getState().active?.id).toBe("c");
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "w",
        metaKey: true,
        cancelable: true,
      }),
    ),
  );
  expect(useReaderStore.getState().tabIds).toEqual(["a", "b"]);
});

it("forwards tab navigation and close commands from EPUB frames", async () => {
  const cycle = new KeyboardEvent("keydown", {
    key: "Tab",
    ctrlKey: true,
    cancelable: true,
  });
  await act(async () => forwardReaderShortcut(cycle));
  expect(cycle.defaultPrevented).toBe(true);
  expect(useReaderStore.getState().active?.id).toBe("b");
  const close = new KeyboardEvent("keydown", {
    key: "w",
    metaKey: true,
    cancelable: true,
  });
  await act(async () => forwardReaderShortcut(close));
  expect(close.defaultPrevented).toBe(true);
  expect(useReaderStore.getState().tabIds).toEqual(["a", "c"]);
});

it("checks for new drafts again if saving progress delayed the close", async () => {
  let finish!: () => void;
  vi.mocked(flushProgress).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await click("关闭标签页：Alpha");
  const input = host.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    input.value = "new draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => finish());
  expect(useReaderStore.getState().tabIds).toContain("a");
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
});

async function menuClick(text: string) {
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((el) => el.textContent?.trim() === text)!;
  expect(item).toBeTruthy();
  await act(async () => item.click());
}
it("finds documents in the tab list and reopens a closed group after all tabs were closed", async () => {
  await click("标签页列表");
  await menuClick("Gamma");
  expect(useReaderStore.getState().active?.id).toBe("c");
  await click("标签页列表");
  await menuClick("关闭所有标签页");
  expect(useReaderStore.getState().tabIds).toEqual([]);
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "t",
        metaKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    ),
  );
  expect(useReaderStore.getState().tabIds).toEqual(["a", "b", "c"]);
  expect(useReaderStore.getState().active?.id).toBe("c");
});
it("keeps every tab if a group contains a saving document, and identifies affected documents", async () => {
  await click("Beta");
  const remove = registerTabCloseGuard("b", () => ({
    blocked: true,
    message: "批注正在保存",
  }));
  await click("标签页列表");
  await menuClick("关闭所有标签页");
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Alpha",
  );
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "批注正在保存",
  );
  expect(useReaderStore.getState().tabIds).toHaveLength(3);
  await click("返回阅读");
  remove();
});
it("closes a background tab with the middle button and restores keyboard focus to the active tab", async () => {
  const tab = document.getElementById("document-tab-b")!;
  await act(async () =>
    tab.dispatchEvent(
      new MouseEvent("auxclick", {
        bubbles: true,
        button: 1,
        cancelable: true,
      }),
    ),
  );
  await act(async () => {
    await new Promise(requestAnimationFrame);
  });
  expect(useReaderStore.getState().tabIds).toEqual(["a", "c"]);
  expect(useReaderStore.getState().active?.id).toBe("a");
  expect(document.activeElement?.id).toBe("document-tab-a");
});

it("does not steal focus from the current chat when closing a background tab with the middle button", async () => {
  const input = host.querySelector<HTMLInputElement>('[aria-label="问题 a"]')!;
  input.focus();
  await act(async () =>
    document.getElementById("document-tab-b")!.dispatchEvent(
      new MouseEvent("auxclick", {
        bubbles: true,
        button: 1,
        cancelable: true,
      }),
    ),
  );
  await act(async () => {
    await new Promise(requestAnimationFrame);
  });
  expect(document.activeElement).toBe(input);
});
it("closes only the right-side tabs from a tab's context menu", async () => {
  const tab = document.getElementById("document-tab-b")!;
  await act(async () =>
    tab.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: 40,
        clientY: 20,
      }),
    ),
  );
  await menuClick("关闭右侧标签页");
  expect(useReaderStore.getState().tabIds).toEqual(["a", "b"]);
  expect(useReaderStore.getState().active?.id).toBe("a");
});
it("moves a tab from its context menu and saves the new order", async () => {
  const tab = document.getElementById("document-tab-a")!;
  await act(async () =>
    tab.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: 40,
        clientY: 20,
      }),
    ),
  );
  await menuClick("向右移动");
  const state = useReaderStore.getState();
  expect(state.tabIds).toEqual(["b", "a", "c"]);
  expect(state.active?.id).toBe("a");
  expect(state.theme.readingSession?.documentIds).toEqual(["b", "a", "c"]);
});
it("closes the other tabs when tabs are turned off and keeps them on if cancelled", async () => {
  useReaderStore.getState().open(docs[0]);
  await act(async () => root.render(<Harness />));
  const input = document.querySelector<HTMLInputElement>('[aria-label="问题 a"]')!;
  await act(async () => {
    input.value = "draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  useReaderStore.getState().open(docs[1]);
  await act(async () =>
    useReaderStore.getState().setTheme({ documentTabs: false }),
  );
  expect(document.body.textContent).toContain("未发送内容");
  await click("返回阅读");
  expect(useReaderStore.getState().theme.documentTabs).toBe(true);
  expect(useReaderStore.getState().tabIds).toEqual(["a", "b", "c"]);
  await act(async () =>
    useReaderStore.getState().setTheme({ documentTabs: false }),
  );
  await click("关闭标签页");
  await act(async () => {});
  expect(useReaderStore.getState().tabIds).toEqual(["b"]);
  expect(document.querySelector(".document-tabbar")).toBeNull();
});
