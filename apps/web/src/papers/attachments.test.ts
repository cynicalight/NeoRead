// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type PaperAttachment } from "@neoread/api";
import {
  loadAttachments,
  putAttachment,
  uploadAttachments,
  useAttachments,
} from "./attachments";
import { paper } from "./fixtures";
vi.mock("@neoread/api", () => ({
  api: { paperAttachments: vi.fn(), addPaperAttachment: vi.fn() },
}));
vi.mock("../store", () => ({ refreshLibrary: vi.fn(async () => {}) }));
vi.mock("./actions", () => ({ openLink: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
const item = (id: string): PaperAttachment => ({
  id,
  documentId: "paper",
  kind: "file",
  title: id,
  filename: `${id}.pdf`,
  mediaType: "application/pdf",
  size: 1,
  url: "",
  createdAt: "2026-10-23T00:00:00Z",
});
const files = [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")];
beforeEach(() => {
  vi.clearAllMocks();
  useAttachments.setState({
    items: {},
    errors: {},
    uploads: {},
    expanded: new Set(),
    selected: null,
  });
  vi.mocked(api.paperAttachments).mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());
it("waits for save completion after upload reaches 100 percent", async () => {
  let resolve!: (value: PaperAttachment) => void;
  vi.mocked(api.addPaperAttachment).mockImplementation(
    async (_id, _file, options) => {
      options?.onProgress?.(1);
      return new Promise((done) => {
        resolve = done;
      });
    },
  );
  const work = uploadAttachments(paper({ id: "paper" }), [files[0]]);
  await vi.waitFor(() =>
    expect(useAttachments.getState().uploads.paper?.entries[0].status).toBe(
      "saving",
    ),
  );
  expect(useAttachments.getState().items.paper).toEqual([]);
  vi.mocked(api.paperAttachments).mockResolvedValue([item("a")]);
  resolve(item("a"));
  await work;
  expect(useAttachments.getState().items.paper).toEqual([item("a")]);
  expect(useAttachments.getState().uploads.paper).toBeUndefined();
});
it("preserves successful files and exposes failed files for retry", async () => {
  vi.mocked(api.addPaperAttachment)
    .mockResolvedValueOnce(item("a"))
    .mockRejectedValueOnce(new Error("network interrupted"));
  vi.mocked(api.paperAttachments)
    .mockResolvedValueOnce([])
    .mockResolvedValue([item("a")]);
  await uploadAttachments(paper({ id: "paper" }), files);
  const batch = useAttachments.getState().uploads.paper!;
  expect(batch.entries.map((e) => e.status)).toEqual(["done", "failed"]);
  expect(batch.entries[0].file).toBeUndefined();
  expect(batch.entries[1].file).toBe(files[1]);
  expect(useAttachments.getState().items.paper).toEqual([item("a")]);
});
it("cancels the current and queued files and reconciles a possible server save", async () => {
  vi.mocked(api.addPaperAttachment).mockImplementation(
    async (_id, _file, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("cancelled", "AbortError")),
        ),
      ),
  );
  const work = uploadAttachments(paper({ id: "paper" }), files);
  await vi.waitFor(() => expect(api.addPaperAttachment).toHaveBeenCalledOnce());
  vi.mocked(api.paperAttachments).mockResolvedValue([
    item("saved-before-abort"),
  ]);
  useAttachments.getState().uploads.paper!.controller.abort();
  await work;
  expect(
    useAttachments.getState().uploads.paper?.entries.map((e) => e.status),
  ).toEqual(["cancelled", "cancelled"]);
  expect(useAttachments.getState().items.paper?.[0].id).toBe(
    "saved-before-abort",
  );
  expect(api.addPaperAttachment).toHaveBeenCalledOnce();
});
it("does not let an older list request overwrite a completed mutation", async () => {
  let resolve!: (value: PaperAttachment[]) => void;
  vi.mocked(api.paperAttachments)
    .mockImplementationOnce(
      async () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue([item("new")]);
  const pending = loadAttachments("paper");
  putAttachment(item("new"));
  resolve([]);
  await pending;
  await vi.waitFor(() => expect(api.paperAttachments).toHaveBeenCalledTimes(2));
  expect(useAttachments.getState().items.paper).toEqual([item("new")]);
});
