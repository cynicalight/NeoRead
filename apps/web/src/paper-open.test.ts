import { beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import type { Processing } from "@neoread/core";
import {
  openLibraryDocument,
  openLinkTarget,
  openWhenParsed,
  useReaderStore,
} from "./store";
import { paper } from "./papers/fixtures";

vi.mock("@neoread/api", () => ({
  api: {
    processing: vi.fn(),
    saveLibraryPreferences: vi.fn(async (value) => value),
  },
}));
const doc = paper();
const job = (patch: Partial<Processing> = {}): Processing => ({
  documentId: doc.id,
  phase: "learning",
  status: "running",
  pagesDone: 0,
  pagesTotal: 2,
  translationsDone: 0,
  translationsTotal: 0,
  detail: "",
  updatedAt: "",
  ...patch,
});
beforeEach(() => {
  vi.resetAllMocks();
  useReaderStore.getState().open(null);
  useReaderStore.setState({
    documents: [doc],
    linkTarget: null,
    libraryPreferences: { mode: "books" },
  });
});
it.each(["queued", "running", "paused", "waiting", "failed"] as const)(
  "blocks a paper whose parsing is %s",
  async (status) => {
    vi.mocked(api.processing).mockResolvedValue([job({ status })]);
    await expect(openLibraryDocument(doc)).rejects.toThrow(
      "论文飞速解析中，请稍等",
    );
    expect(useReaderStore.getState().active).toBeNull();
  },
);
it("blocks unknown and incomplete parsing", async () => {
  for (const jobs of [[], [job({ phase: "translating", incomplete: true })]]) {
    vi.mocked(api.processing).mockResolvedValue(jobs);
    await expect(openLibraryDocument(doc)).rejects.toThrow(
      "论文飞速解析中，请稍等",
    );
    expect(useReaderStore.getState().active).toBeNull();
  }
});
it.each(["running", "paused", "failed", "complete"] as const)(
  "opens parsed papers even when translation is %s",
  async (status) => {
    vi.mocked(api.processing).mockResolvedValue([
      job({ phase: "translating", status }),
    ]);
    expect(await openLibraryDocument(doc)).toBe(true);
    expect(useReaderStore.getState().active).toEqual(doc);
  },
);
it("allows retry after parsing completes", async () => {
  vi.mocked(api.processing)
    .mockResolvedValueOnce([job()])
    .mockResolvedValueOnce([job({ phase: "ready", status: "complete" })]);
  await expect(openLibraryDocument(doc)).rejects.toThrow();
  expect(await openLibraryDocument(doc)).toBe(true);
});
it("guards links without switching library or saving the blocked target", async () => {
  vi.mocked(api.processing).mockResolvedValue([job()]);
  await expect(openLinkTarget({ id: doc.id, page: 1 })).rejects.toThrow(
    "论文飞速解析中，请稍等",
  );
  expect(useReaderStore.getState().active).toBeNull();
  expect(useReaderStore.getState().linkTarget).toBeNull();
  expect(useReaderStore.getState().libraryPreferences.mode).toBe("books");
});
it("keeps books available without a processing request", async () => {
  const book = paper({ library: "books" });
  expect(await openLibraryDocument(book)).toBe(true);
  expect(api.processing).not.toHaveBeenCalled();
});
it("does not open when the processing request fails", async () => {
  vi.mocked(api.processing).mockRejectedValue(new Error("连接失败"));
  await expect(openLibraryDocument(doc)).rejects.toThrow("连接失败");
  expect(useReaderStore.getState().active).toBeNull();
});
it("does not replace a newer navigation with a late response", async () => {
  let resolve!: (jobs: Processing[]) => void;
  vi.mocked(api.processing).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = openLibraryDocument(doc);
  const book = paper({ id: "book", library: "books" });
  await openLibraryDocument(book);
  resolve([job({ phase: "ready" })]);
  expect(await pending).toBe(false);
  expect(useReaderStore.getState().active).toEqual(book);
});
it("opens a paper from Open With once parsing finishes", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(api.processing)
      .mockResolvedValueOnce([job()])
      .mockResolvedValueOnce([job({ pagesDone: 1 })])
      .mockResolvedValue([job({ phase: "ready", status: "complete" })]);
    const onWaiting = vi.fn();
    const opened = openWhenParsed(doc.id, onWaiting);
    await vi.advanceTimersByTimeAsync(0);
    expect(onWaiting).toHaveBeenCalledOnce();
    expect(useReaderStore.getState().active).toBeNull();
    expect(useReaderStore.getState().libraryPreferences.mode).toBe("papers");
    await vi.advanceTimersByTimeAsync(2400);
    expect(await opened).toBe(true);
    expect(onWaiting).toHaveBeenCalledOnce();
    expect(useReaderStore.getState().active).toEqual(doc);
  } finally {
    vi.useRealTimers();
  }
});
it.each([
  [job({ status: "failed", detail: "解析失败" }), "解析失败"],
  [job({ status: "waiting", detail: "需要配置" }), "需要配置"],
  [
    job({ phase: "ready", status: "complete", incomplete: true }),
    "论文正文不完整，无法打开",
  ],
])("reports a paper from Open With that cannot open", async (state, error) => {
  vi.mocked(api.processing).mockResolvedValue([state]);
  await expect(openWhenParsed(doc.id, vi.fn())).rejects.toThrow(error);
  expect(useReaderStore.getState().active).toBeNull();
});
it("replaces an earlier Open With wait", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(api.processing).mockResolvedValue([job()]);
    const first = openWhenParsed(doc.id, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const book = paper({ id: "book", library: "books" });
    useReaderStore.setState({ documents: [doc, book] });
    expect(await openWhenParsed(book.id, vi.fn())).toBe(true);
    vi.mocked(api.processing).mockResolvedValue([
      job({ phase: "ready", status: "complete" }),
    ]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await first).toBe(true);
    expect(useReaderStore.getState().active).toEqual(book);
  } finally {
    vi.useRealTimers();
  }
});
