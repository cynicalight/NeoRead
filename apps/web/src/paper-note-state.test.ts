import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { reportDiagnostic } from "./diagnostics";
import { api } from "@neoread/api";
import {
  getPaperNote,
  importWithPaperNotes,
  flushPaperNotes,
  hasPendingPaperNotes,
  mergePaperNotes,
  readPaperNote,
  discardPaperNotes,
  takePaperNoteSaveWarning,
} from "./paper-note-state";
vi.mock("@neoread/api", () => ({
  api: {
    mergeDocuments: vi.fn(async () => ({ trashed: [] })),
    documentNote: vi.fn(async () => ({ body: "original" })),
    saveDocumentNote: vi.fn(async (_id: string, body: string) => ({ body })),
  },
}));
vi.mock("./diagnostics", () => ({ reportDiagnostic: vi.fn() }));
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
  takePaperNoteSaveWarning();
});
afterEach(() => vi.useRealTimers());
it("automatically saves the latest text every five seconds", async () => {
  const { entry, release } = await note();
  entry.edit("one");
  entry.edit("two");
  expect(entry.getSnapshot().status).toBe("dirty");
  await vi.advanceTimersByTimeAsync(4999);
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
it("discards failed writes after unmount and never retries them", async () => {
  const { entry, release } = await note();
  vi.mocked(api.saveDocumentNote).mockRejectedValueOnce(new Error("offline"));
  entry.edit("unsaved");
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(api.saveDocumentNote).toHaveBeenCalledTimes(1);
  expect(entry.getSnapshot().status).toBe("saved");
  await vi.advanceTimersByTimeAsync(5000);
  expect(api.saveDocumentNote).toHaveBeenCalledTimes(1);
  expect(entry.getSnapshot()).toMatchObject({
    body: "original",
    status: "saved",
  });
  expect(hasPendingPaperNotes()).toBe(false);
});
it("saves during continuous typing without restarting the five-second deadline", async () => {
  const { entry, release } = await note();
  entry.edit("first");
  await vi.advanceTimersByTimeAsync(4000);
  entry.edit("still typing");
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.saveDocumentNote).toHaveBeenLastCalledWith(
    entry.id,
    "still typing",
  );
  entry.edit("next batch");
  await vi.advanceTimersByTimeAsync(5000);
  expect(api.saveDocumentNote).toHaveBeenLastCalledWith(entry.id, "next batch");
  release();
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
it("discards rejected oversized edits and allows fresh edits", async () => {
  const { entry, release } = await note();
  vi.mocked(api.saveDocumentNote).mockRejectedValueOnce(
    new Error("server limit: 100000"),
  );
  entry.edit("😀".repeat(100001));
  await expect(entry.flush()).rejects.toThrow("100000");
  expect(entry.getSnapshot().body).toBe("original");
  expect(api.saveDocumentNote).toHaveBeenCalledWith(
    entry.id,
    "😀".repeat(100001),
  );
  expect(entry.getSnapshot().error).toBe("");
  entry.edit("😀".repeat(100000));
  await entry.flush();
  expect(entry.getSnapshot().status).toBe("saved");
  release();
});

it("does not retry discarded text even when subsequent edits revert to the saved text", async () => {
  const { entry, release } = await note();
  vi.mocked(api.saveDocumentNote).mockRejectedValueOnce(
    new Error("response lost"),
  );
  entry.edit("possibly reached server");
  await expect(entry.flush()).rejects.toThrow("response lost");
  entry.edit("another edit");
  entry.edit("original");
  await entry.flush();
  expect(api.saveDocumentNote).toHaveBeenCalledTimes(1);
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

it("refreshes a cached master after merging so later edits do not overwrite the winner", async () => {
  const { entry, release } = await note();
  vi.mocked(api.documentNote).mockResolvedValueOnce({
    body: "longer merged note",
    updatedAt: "",
  });
  await mergePaperNotes(entry.id, ["duplicate"]);
  expect(entry.getSnapshot()).toMatchObject({
    body: "longer merged note",
    status: "saved",
  });
  expect(await readPaperNote(entry.id)).toBe("longer merged note");
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  entry.edit(entry.getSnapshot().body + " edited");
  await entry.flush();
  expect(api.saveDocumentNote).toHaveBeenLastCalledWith(
    entry.id,
    "longer merged note edited",
  );
  release();
});
it("saves participating drafts before the merge request", async () => {
  const a = await note(),
    b = await note();
  a.entry.edit("master draft");
  b.entry.edit("longer duplicate draft");
  vi.mocked(api.mergeDocuments).mockImplementationOnce(async () => {
    expect(api.saveDocumentNote).toHaveBeenCalledWith(
      a.entry.id,
      "master draft",
    );
    expect(api.saveDocumentNote).toHaveBeenCalledWith(
      b.entry.id,
      "longer duplicate draft",
    );
    return {} as Awaited<ReturnType<typeof api.mergeDocuments>>;
  });
  vi.mocked(api.documentNote).mockResolvedValueOnce({
    body: "longer duplicate draft",
    updatedAt: "",
  });
  await mergePaperNotes(a.entry.id, [b.entry.id]);
  expect(a.entry.getSnapshot().body).toBe("longer duplicate draft");
  a.release();
  b.release();
});
it("does not merge when saving a participating draft fails", async () => {
  const { entry, release } = await note();
  entry.edit("pending");
  vi.mocked(api.saveDocumentNote).mockRejectedValueOnce(new Error("offline"));
  await expect(mergePaperNotes(entry.id, ["duplicate"])).rejects.toThrow(
    "offline",
  );
  expect(api.mergeDocuments).not.toHaveBeenCalled();
  expect(entry.getSnapshot().body).toBe("original");
  await entry.flush();
  release();
});
it("blocks stale autosave after a failed refresh and retries the read first", async () => {
  const { entry, release } = await note();
  vi.mocked(api.documentNote).mockRejectedValueOnce(new Error("offline"));
  await mergePaperNotes(entry.id, ["duplicate"]);
  expect(entry.getSnapshot().status).toBe("load-error");
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  vi.mocked(api.documentNote).mockResolvedValueOnce({
    body: "longer merged note",
    updatedAt: "",
  });
  expect(await entry.flush()).toBe("longer merged note");
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  expect(entry.hasPending()).toBe(false);
  release();
});
it("waits for merge reconciliation before saving a longer concurrent draft", async () => {
  const { entry, release } = await note();
  const merging = deferred();
  vi.mocked(api.mergeDocuments).mockReturnValueOnce(
    merging.promise as unknown as ReturnType<typeof api.mergeDocuments>,
  );
  vi.mocked(api.documentNote).mockResolvedValueOnce({
    body: "server winner",
    updatedAt: "",
  });
  const work = mergePaperNotes(entry.id, ["duplicate"]);
  await vi.waitFor(() => expect(api.mergeDocuments).toHaveBeenCalled());
  entry.edit("a much longer local draft typed while merging");
  await vi.advanceTimersByTimeAsync(900);
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  merging.resolve();
  await work;
  await entry.flush();
  expect(api.saveDocumentNote).toHaveBeenLastCalledWith(
    entry.id,
    "a much longer local draft typed while merging",
  );
  release();
});
it.each([
  ["中文", "abc", "abc"],
  ["other", "first", "first"],
  ["longer local draft", "short", "longer local draft"],
])(
  "reconciles local %s and remote %s by Unicode length, preferring the server on ties",
  async (local, remote, expected) => {
    const { entry, release } = await note();
    entry.edit(local);
    vi.mocked(api.documentNote).mockResolvedValueOnce({
      body: remote,
      updatedAt: "",
    });
    await mergePaperNotes(entry.id, ["duplicate"]);
    expect(entry.getSnapshot().body).toBe(expected);
    await entry.flush();
    expect(entry.hasPending()).toBe(false);
    release();
  },
);
it("refreshes before writing again after an uncertain merge failure", async () => {
  const { entry, release } = await note();
  vi.mocked(api.mergeDocuments).mockRejectedValueOnce(
    new Error("response lost"),
  );
  await expect(mergePaperNotes(entry.id, ["duplicate"])).rejects.toThrow(
    "response lost",
  );
  vi.mocked(api.documentNote).mockResolvedValueOnce({
    body: "longer result already on server",
    updatedAt: "",
  });
  await entry.flush();
  expect(entry.getSnapshot().body).toBe("longer result already on server");
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  release();
});

it("removes a permanently deleted note from retry and shutdown queues", async () => {
  const { entry, release } = await note();
  entry.edit("pending deletion");
  vi.mocked(api.saveDocumentNote).mockRejectedValueOnce(new Error("offline"));
  await expect(entry.flush()).rejects.toThrow();
  discardPaperNotes([entry.id]);
  await vi.advanceTimersByTimeAsync(15000);
  await flushPaperNotes();
  expect(api.saveDocumentNote).toHaveBeenCalledTimes(1);
  expect(hasPendingPaperNotes()).toBe(false);
  release();
});
it("ignores an in-flight write failure after permanent deletion", async () => {
  const { entry, release } = await note();
  const request = deferred();
  vi.mocked(api.saveDocumentNote).mockReturnValueOnce(request.promise);
  entry.edit("pending");
  const saving = entry.flush();
  discardPaperNotes([entry.id]);
  request.reject(new Error("document deleted"));
  await saving;
  await vi.advanceTimersByTimeAsync(15000);
  expect(entry.hasPending()).toBe(false);
  expect(api.saveDocumentNote).toHaveBeenCalledTimes(1);
  release();
});

it("reports discarded writes without leaking note text or exception messages", async () => {
  const { entry, release } = await note();
  entry.edit("private note text");
  vi.mocked(api.saveDocumentNote).mockRejectedValueOnce(
    new TypeError("private note text"),
  );
  await expect(entry.flush()).rejects.toThrow();
  expect(reportDiagnostic).toHaveBeenCalledExactlyOnceWith({
    level: "error",
    event: "paper_note.save_failed_discarded",
    detail: "TypeError",
  });
  expect(toast.error).toHaveBeenCalledWith(
    "论文笔记保存失败，本次未保存的修改已丢弃",
  );
  expect(takePaperNoteSaveWarning()).toBe(true);
  expect(takePaperNoteSaveWarning()).toBe(false);
  expect(entry.getSnapshot().body).toBe("original");
  expect(entry.hasPending()).toBe(false);
  await vi.advanceTimersByTimeAsync(15000);
  expect(api.saveDocumentNote).toHaveBeenCalledTimes(1);
  release();
});

it("refreshes an open note after import and holds autosave during import", async () => {
  const note = getPaperNote("import-" + ++id);
  const release = note.subscribe(() => {});
  await note.load();
  const gate = deferred();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const importing = importWithPaperNotes(async () => {
    started();
    await gate.promise;
    vi.mocked(api.documentNote).mockResolvedValue({
      body: "long imported note from Zotero",
    });
    return "imported";
  });
  await ready;
  note.edit("local edit");
  await vi.advanceTimersByTimeAsync(5000);
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  gate.resolve();
  expect(await importing).toBe("imported");
  expect(await note.flush()).toBe("long imported note from Zotero");
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  release();
});
