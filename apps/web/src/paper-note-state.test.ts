import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import { toast } from "sonner";
import {
  getPaperNote,
  flushPaperNote,
  flushPaperNotes,
  hasPendingPaperNotes,
} from "./paper-note-state";
vi.mock("@reader/api", () => ({
  api: {
    documentNote: vi.fn(async () => ({ body: "original" })),
    saveDocumentNote: vi.fn(async (_id: string, body: string) => ({ body })),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
let id = 0;
const deferred = () => {
  let resolve!: (value: { body: string; updatedAt: string }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ body: string; updatedAt: string }>(
    (yes, no) => {
      resolve = yes;
      reject = no;
    },
  );
  return {
    promise,
    resolve: (body = "") => resolve({ body, updatedAt: "" }),
    reject,
  };
};
async function note() {
  const entry = getPaperNote(`note-${++id}`);
  const release = entry.subscribe(() => {});
  await entry.load();
  return { entry, release };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());
it("debounces edits and flushes the latest text", async () => {
  const { entry, release } = await note();
  entry.edit("one");
  entry.edit("two");
  expect(entry.getSnapshot().status).toBe("dirty");
  await vi.advanceTimersByTimeAsync(799);
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(api.saveDocumentNote).toHaveBeenCalledExactlyOnceWith(entry.id, "two");
  expect(entry.getSnapshot()).toMatchObject({ body: "two", status: "saved" });
  release();
});
it("serializes writes and persists a revert made while an earlier write is in flight", async () => {
  const { entry, release } = await note();
  const first = deferred(),
    second = deferred();
  vi.mocked(api.saveDocumentNote)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  entry.edit("first");
  const saving = entry.flush();
  entry.edit("intermediate");
  entry.edit("original");
  const concurrent = entry.flush();
  expect(api.saveDocumentNote).toHaveBeenCalledTimes(1);
  first.resolve("first");
  await Promise.resolve();
  expect(api.saveDocumentNote).toHaveBeenLastCalledWith(entry.id, "original");
  expect(entry.getSnapshot().status).toBe("saving");
  second.resolve("original");
  await Promise.all([saving, concurrent]);
  expect(api.saveDocumentNote).toHaveBeenCalledTimes(2);
  expect(entry.getSnapshot()).toMatchObject({
    body: "original",
    status: "saved",
  });
  release();
});
it("retains failed unmounted drafts without automatic retry and retries explicitly", async () => {
  const { entry, release } = await note();
  const request = deferred();
  vi.mocked(api.saveDocumentNote).mockReturnValueOnce(request.promise);
  entry.edit("unsaved");
  release();
  await Promise.resolve();
  request.reject(new Error("offline"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(toast.error).toHaveBeenCalled();
  expect(api.saveDocumentNote).toHaveBeenCalledTimes(1);
  expect(getPaperNote(entry.id)).toBe(entry);
  const again = entry.subscribe(() => {});
  await entry.load();
  expect(api.documentNote).toHaveBeenCalledTimes(1);
  expect(entry.getSnapshot()).toMatchObject({
    body: "unsaved",
    status: "save-error",
  });
  expect(hasPendingPaperNotes()).toBe(true);
  expect(await flushPaperNote(entry.id)).toBe("unsaved");
  expect(entry.getSnapshot().status).toBe("saved");
  again();
});
it("does not write an empty note after a failed initial read", async () => {
  vi.mocked(api.documentNote).mockRejectedValueOnce(new Error("offline"));
  const entry = getPaperNote(`note-${++id}`);
  const release = entry.subscribe(() => {});
  await expect(entry.load()).rejects.toThrow("offline");
  entry.edit("blank overwrite");
  expect(entry.getSnapshot()).toMatchObject({ body: "", status: "load-error" });
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  await entry.load();
  expect(entry.getSnapshot().body).toBe("original");
  release();
});
it("keeps a single load and draft across a strict-mode unsubscribe/subscribe", async () => {
  const entry = getPaperNote(`note-${++id}`);
  const request = deferred();
  vi.mocked(api.documentNote).mockReturnValueOnce(request.promise);
  const release = entry.subscribe(() => {});
  const loading = entry.load();
  release();
  const again = entry.subscribe(() => {});
  const duplicate = entry.load();
  request.resolve("loaded");
  await Promise.all([loading, duplicate]);
  expect(api.documentNote).toHaveBeenCalledTimes(1);
  entry.edit("draft");
  await entry.load();
  expect(entry.getSnapshot().body).toBe("draft");
  await flushPaperNotes();
  expect(entry.getSnapshot().status).toBe("saved");
  again();
});
it("preserves over-limit raw text and counts Unicode characters instead of UTF-16 units", async () => {
  const { entry, release } = await note();
  entry.edit("😀".repeat(100001));
  await expect(entry.flush()).rejects.toThrow("100000");
  expect(entry.getSnapshot().body).toHaveLength(200002);
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  entry.edit("😀".repeat(100000));
  await entry.flush();
  expect(entry.getSnapshot().status).toBe("saved");
  release();
});

it("rewrites the previous saved text after an uncertain failed PUT and further edits", async () => {
  const { entry, release } = await note();
  vi.mocked(api.saveDocumentNote).mockRejectedValueOnce(
    new Error("response lost"),
  );
  entry.edit("possibly reached server");
  await expect(entry.flush()).rejects.toThrow("response lost");
  entry.edit("another edit");
  entry.edit("original");
  await entry.flush();
  expect(api.saveDocumentNote).toHaveBeenLastCalledWith(entry.id, "original");
  expect(entry.getSnapshot().status).toBe("saved");
  release();
});

it("keeps document queues separate and restores the same draft on re-entry during a PUT", async () => {
  const a = await note(),
    b = await note();
  const request = deferred();
  vi.mocked(api.saveDocumentNote).mockReturnValueOnce(request.promise);
  a.entry.edit("A");
  const saving = a.entry.flush();
  a.release();
  await Promise.resolve();
  const returned = getPaperNote(a.entry.id);
  const release = returned.subscribe(() => {});
  await returned.load();
  returned.edit("A latest");
  b.entry.edit("");
  await b.entry.flush();
  expect(b.entry.getSnapshot()).toMatchObject({ body: "", status: "saved" });
  expect(returned.getSnapshot().status).toBe("saving");
  request.resolve("A");
  await saving;
  expect(api.saveDocumentNote).toHaveBeenLastCalledWith(a.entry.id, "A latest");
  release();
  b.release();
});

it("flushes documents that become dirty while an earlier flush batch is awaiting writes", async () => {
  const a = await note(),
    b = await note();
  const first = deferred();
  vi.mocked(api.saveDocumentNote).mockReturnValueOnce(first.promise);
  a.entry.edit("first document");
  const flushing = flushPaperNotes();
  b.entry.edit("late second document");
  first.resolve("first document");
  await flushing;
  expect(api.saveDocumentNote).toHaveBeenCalledWith(
    b.entry.id,
    "late second document",
  );
  expect(hasPendingPaperNotes()).toBe(false);
  a.release();
  b.release();
});
