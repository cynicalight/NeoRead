// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import { defaultTheme } from "@reader/core";
import { App } from "./App";
import { useReaderStore } from "./store";

vi.mock("@reader/api", () => ({
  RequestError: class extends Error {},
  api: {
    documents: vi.fn().mockRejectedValue(new Error("library unavailable")),
    libraryPreferences: vi
      .fn()
      .mockResolvedValue({ mode: "books", primaryMode: "books" }),
    trash: vi.fn().mockResolvedValue([]),
    settings: vi.fn(),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("./shortcuts/shortcuts", () => ({
  useShortcut: vi.fn(),
  loadBindings: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./ProcessingStatus", () => ({ useProcessing: () => ({ jobs: [] }) }));
vi.mock("./update-progress", () => ({ useUpdateProgress: vi.fn() }));
vi.mock("./appearance", () => ({ useResolvedTheme: () => defaultTheme }));
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
vi.mock("./LibraryDocuments", () => ({ LibraryDocuments: () => null }));
vi.mock("./DocumentManagement", () => ({
  DocumentEditor: () => null,
  LibraryFilterBar: () => null,
}));
vi.mock("./LargePaperDialog", () => ({
  LargePaperConfirmation: () => null,
  LargePaperDialog: () => null,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it.each([true, false])(
  "only saves successfully hydrated settings after library startup fails (%s)",
  async (success) => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useReaderStore.setState({
      theme: defaultTheme,
      active: null,
      documents: [],
      trash: [],
      libraryPreferences: {},
    });
    let resolve!: (value: typeof defaultTheme) => void;
    let reject!: (error: Error) => void;
    vi.mocked(api.settings).mockReturnValue(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<App />));
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(api.saveSettings).not.toHaveBeenCalled();
      await act(async () => {
        if (success) resolve({ ...defaultTheme, zoom: 1.5 });
        else reject(new Error("settings unavailable"));
      });
      await act(async () =>
        useReaderStore
          .getState()
          .setTheme({ ...useReaderStore.getState().theme, zoom: 2 }),
      );
      await act(async () => vi.advanceTimersByTimeAsync(500));
      if (success)
        expect(api.saveSettings).toHaveBeenLastCalledWith(
          expect.objectContaining({ zoom: 2 }),
        );
      else expect(api.saveSettings).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  },
);
