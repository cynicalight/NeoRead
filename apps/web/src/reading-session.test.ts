import { beforeEach, expect, it, vi } from "vitest";
import { defaultTheme } from "@neoread/core";
import { paper } from "./papers/fixtures";
import { useReaderStore, forgetLibraryDocuments } from "./store";
import { readingSession } from "./reading-session";
vi.mock("@neoread/api", () => ({ api: {} }));
const docs = [
  paper({ id: "a", title: "Alpha" }),
  paper({ id: "b", title: "Beta" }),
  paper({ id: "c", title: "Gamma" }),
];
const state = () => useReaderStore.getState();
beforeEach(() =>
  useReaderStore.setState({
    documents: docs,
    active: null,
    tabIds: [],
    visitedTabs: [],
    closedTabGroups: [],
    sessionReady: false,
    theme: { ...defaultTheme, documentTabs: true },
  }),
);
it("opens multiple documents once and retains tabs when returning to the library", () => {
  state().openMany([docs[0], docs[1], docs[0]]);
  expect(state().tabIds).toEqual(["a", "b"]);
  expect(state().visitedTabs).toEqual(["a"]);
  state().open(docs[1]);
  state().open(docs[0]);
  expect(state().tabIds).toEqual(["a", "b"]);
  state().open(null);
  expect(state().active).toBeNull();
  expect(state().tabIds).toEqual(["a", "b"]);
});
it("closes a background tab without stealing focus and selects a neighbor when closing the active tab", () => {
  state().openMany(docs);
  state().open(docs[1]);
  state().closeTab("a");
  expect(state().active?.id).toBe("b");
  state().closeTab("b");
  expect(state().active?.id).toBe("c");
  state().closeTab("c");
  expect(state().active).toBeNull();
  expect(state().theme.readingSession).toEqual({
    documentIds: [],
    activeId: null,
  });
});
it.each([true, false])(
  "restores order and selection after settings/documents load in either order (%s)",
  (settingsFirst) => {
    const saved = {
      ...defaultTheme,
      documentTabs: true,
      readingSession: {
        documentIds: ["c", "a", "missing", "c"],
        activeId: "a",
      },
    };
    useReaderStore.setState({ documents: [] });
    if (settingsFirst) {
      state().setTheme(saved);
      state().setDocuments(docs);
    } else {
      state().setDocuments(docs);
      state().setTheme(saved);
    }
    state().restoreSession();
    expect(state().tabIds).toEqual(["c", "a"]);
    expect(state().active?.id).toBe("a");
    expect(state().visitedTabs).toEqual(["a"]);
    expect(state().theme.readingSession).toEqual({
      documentIds: ["c", "a"],
      activeId: "a",
    });
  },
);
it("removes deleted documents from tabs while keeping other documents and fresh metadata", () => {
  state().openMany(docs);
  state().open(docs[1]);
  forgetLibraryDocuments(["b"]);
  expect(state().tabIds).toEqual(["a", "c"]);
  expect(state().active?.id).toBe("c");
  state().setDocuments([docs[0], { ...docs[2], title: "New title" }]);
  expect(state().active?.title).toBe("New title");
  state().open(null);
  state().closeTab("a");
  expect(state().active).toBeNull();
});
it("ignores malformed or deleted saved tabs and preserves reading preferences", () => {
  expect(
    readingSession(
      { documentIds: [null, 1, "a", "a"], activeId: "deleted" },
      docs,
    ),
  ).toEqual({ documentIds: ["a"], activeId: null });
  expect(readingSession("invalid", docs)).toEqual({
    documentIds: [],
    activeId: null,
  });
  state().setTheme({ zoom: 1.5, margin: 62 });
  state().open(docs[0]);
  expect(state().theme).toMatchObject({
    zoom: 1.5,
    margin: 62,
  });
});

it("closes groups atomically and restores their original order with one reopen", () => {
  state().openMany(docs);
  state().open(docs[1]);
  state().closeTabs(["a", "b"]);
  expect(state().tabIds).toEqual(["c"]);
  expect(state().active?.id).toBe("c");
  expect(state().reopenTabs()?.id).toBe("b");
  expect(state().tabIds).toEqual(["a", "b", "c"]);
  expect(state().closedTabGroups).toEqual([]);
});
it("never reopens deleted documents or duplicates tabs that were opened manually", () => {
  state().openMany(docs);
  state().closeTabs(["a", "b"]);
  state().open(docs[0]);
  state().setDocuments([docs[0], docs[2]]);
  expect(state().reopenTabs()).toBeNull();
  expect(state().tabIds).toEqual(["c", "a"]);
});
it("replaces the current document and restores none when tabs are off", () => {
  state().setTheme({
    documentTabs: false,
    readingSession: { documentIds: ["a", "b"], activeId: "b" },
  });
  useReaderStore.setState({ sessionReady: false });
  state().restoreSession();
  expect(state().tabIds).toEqual([]);
  expect(state().active).toBeNull();
  state().open(docs[0]);
  state().open(docs[1]);
  expect(state().tabIds).toEqual(["b"]);
  expect(state().visitedTabs).toEqual(["b"]);
  state().open(null);
  expect(state().tabIds).toEqual([]);
});
