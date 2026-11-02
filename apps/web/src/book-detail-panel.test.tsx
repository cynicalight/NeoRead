// @vitest-environment jsdom
import { act } from "react";
import type { Document } from "@neoread/core";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { defaultTheme } from "@neoread/core";
import { App } from "./App";
import { useReaderStore } from "./store";

vi.mock("@neoread/api", () => ({
  RequestError: class extends Error {},
  api: {
    documents: vi.fn(),
    libraryPreferences: vi
      .fn()
      .mockResolvedValue({ mode: "books", primaryMode: "books" }),
    trash: vi.fn().mockResolvedValue([]),
    settings: vi.fn().mockResolvedValue({}),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("./shortcuts/shortcuts", () => ({
  isMac: () => false,
  useShortcut: vi.fn(),
  loadBindings: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./ProcessingStatus", () => ({ useProcessing: () => ({ jobs: [] }) }));
vi.mock("./update-progress", () => ({ useUpdateProgress: vi.fn() }));
vi.mock("./appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./appearance")>()),
  useResolvedTheme: () => defaultTheme,
}));
vi.mock("./Settings", () => ({ Settings: () => null }));
vi.mock("./Workspace", () => ({ Workspace: () => null }));
vi.mock("./guide/GuideHost", () => ({ GuideHost: () => null }));
vi.mock("./papers/PaperLibrary", () => ({ PaperLibrary: () => null }));
vi.mock("./papers/PaperSidebar", () => ({ PaperSidebar: () => null }));
vi.mock("./papers/ImportPaperDialog", () => ({
  ImportPaperDialog: () => null,
}));
vi.mock("./TrashView", () => ({ TrashView: () => null }));
vi.mock("./TagBoards", () => ({ TagBoards: () => null }));
vi.mock("./LibraryDocuments", () => ({
  LibraryDocuments: ({
    onActivate,
  }: {
    onActivate: (id: string | null) => void;
  }) => (
    <article className="book-card" onClick={() => onActivate("b1")}>
      Alpha
    </article>
  ),
}));
vi.mock("./BookDetail", () => ({
  saveBookDetailWidth: vi.fn(),
  BookDetail: () => (
    <aside className="book-detail">
      <p>详情</p>
    </aside>
  ),
}));
vi.mock("./DocumentManagement", () => ({
  DocumentEditor: () => null,
  LibraryFilterBar: () => null,
  LibraryTagFilters: () => null,
}));
vi.mock("./LargePaperDialog", () => ({
  LargePaperConfirmation: () => null,
  LargePaperDialog: () => null,
}));
const book = {
  id: "b1",
  type: "epub",
  title: "Alpha",
  author: "",
  library: "books",
  category: "book",
  tags: [],
  folders: [],
  metadata: {},
  percentage: 0,
} as unknown as Document;
const press = (target: Element, type: string) =>
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }),
  );

it("closes the book detail panel on a click on empty library space", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api.documents).mockResolvedValue([book]);
  useReaderStore.setState({
    theme: defaultTheme,
    active: null,
    documents: [],
    trash: [],
    libraryPreferences: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<App />));
    const panel = () => host.querySelector(".book-detail");
    await act(async () => press(host.querySelector(".book-card")!, "click"));
    expect(panel()).not.toBeNull();
    const empty = host.querySelector(".book-list-pane")!;
    // The press alone keeps the panel, so a field being edited can save on
    // blur before it unmounts.
    await act(async () => press(empty, "pointerdown"));
    expect(panel()).not.toBeNull();
    // A drag that began inside the panel does not close it.
    await act(async () => press(panel()!.querySelector("p")!, "pointerdown"));
    await act(async () => press(empty, "click"));
    expect(panel()).not.toBeNull();
    await act(async () => press(empty, "pointerdown"));
    await act(async () => press(empty, "click"));
    expect(panel()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
