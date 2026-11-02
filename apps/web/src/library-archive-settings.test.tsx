// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryArchiveSettings } from "./LibraryArchiveSettings";
import { useReaderStore } from "./store";
import { libraryArchiveFilename } from "../../../packages/neoread-core/src/library-archive";

afterEach(() => {
  vi.unstubAllGlobals();
});
it("names all-library and nested-category archives", () => {
  expect(libraryArchiveFilename()).toBe("NeoRead书库.zip");
  expect(
    libraryArchiveFilename({ library: "papers", folder: "研究/语言模型" }),
  ).toBe("语言模型.zip");
});
it("exports the selected category and supports both import modes with native dialogs", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const desktop = {
    exportLibraryArchive: vi.fn(async () => false),
    importLibraryArchive: vi.fn(async () => false),
  };
  vi.stubGlobal("neoreadDesktop", desktop);
  useReaderStore.setState({
    documents: [],
    libraryPreferences: { papers: { categories: ["研究/语言"] } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === label,
    )!;
  const choose = async (label: string, text: string) => {
    await act(async () =>
      host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(),
    );
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === text)!;
    expect(option).toBeDefined();
    await act(async () => {
      option.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      option.click();
    });
  };
  try {
    await act(async () => root.render(<LibraryArchiveSettings />));
    await act(async () => button("导出书库").click());
    expect(desktop.exportLibraryArchive).toHaveBeenLastCalledWith(
      {},
      expect.any(Function),
    );
    await choose("导出范围", "分类：研究");
    await act(async () => button("导出书库").click());
    expect(desktop.exportLibraryArchive).toHaveBeenLastCalledWith(
      {
        library: "papers",
        folder: "研究",
      },
      expect.any(Function),
    );
    await act(async () => button("导入压缩包").click());
    expect(desktop.importLibraryArchive).toHaveBeenLastCalledWith(
      "new",
      expect.any(Function),
    );
    await choose("导入方式", "合并到当前书库");
    await act(async () => button("导入压缩包").click());
    expect(desktop.importLibraryArchive).toHaveBeenLastCalledWith(
      "merge",
      expect.any(Function),
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
