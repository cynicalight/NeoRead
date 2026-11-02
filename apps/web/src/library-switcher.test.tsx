// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryModeSwitcher } from "./LibraryModeSwitcher";
import type { LibraryCatalogSnapshot } from "../../../packages/neoread-core/src/library-archive";
import { doubleClickWindow } from "./DetailSheet";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
let host: HTMLDivElement, root: Root;
let snapshot: LibraryCatalogSnapshot;
const switchLibrary = vi.fn(async () => true);
const renameLibrary = vi.fn();
const onMode = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.useFakeTimers();
  snapshot = {
    activeId: "original",
    libraries: [
      { id: "original", name: "论文库", directory: "/original" },
      { id: "other", name: "研究", directory: "/other" },
    ],
  };
  window.neoreadDesktop = {
    platform: "darwin",
    libraryCatalog: async () => snapshot,
    switchLibrary,
    renameLibrary,
  } as unknown as NonNullable<Window["neoreadDesktop"]>;
  renameLibrary.mockImplementation(async () => ({
    ...snapshot,
    libraries: snapshot.libraries.map((entry) =>
      entry.id === "original" ? { ...entry, name: "研究(1)" } : entry,
    ),
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<LibraryModeSwitcher mode="papers" onChange={onMode} />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.neoreadDesktop;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const trigger = () =>
  host.querySelector<HTMLButtonElement>(".library-mode-trigger")!;
const open = async () => {
  await act(async () =>
    trigger().dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }),
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(doubleClickWindow + 1));
};
it("switches registered libraries from the title menu while retaining paper/book views", async () => {
  await open();
  const items = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ];
  const other = items.find((item) => item.textContent === "研究");
  expect(other).toBeDefined();
  expect(items.some((item) => item.textContent?.startsWith("图书"))).toBe(true);
  await act(async () => other!.click());
  expect(switchLibrary).toHaveBeenCalledWith("other");
  expect(onMode).not.toHaveBeenCalled();
});
it("double clicks the title to rename the active library and displays the disambiguated result", async () => {
  await act(async () => {
    trigger().dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1 }),
    );
    trigger().dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, detail: 2 }),
    );
  });
  const input = host.querySelector<HTMLInputElement>(
    '[aria-label="书库名称"]',
  )!;
  expect(input.value).toBe("论文库");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "研究");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(renameLibrary).toHaveBeenCalledWith("original", "研究");
  expect(trigger().textContent).toContain("研究(1)");
  expect(switchLibrary).not.toHaveBeenCalled();
});
