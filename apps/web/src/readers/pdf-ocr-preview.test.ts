import { api } from "@neoread/api";
import type { PDFOCRPreviewPage } from "@neoread/core";
import { beforeEach, expect, it, vi } from "vitest";
import { PDFOCRPreview } from "./pdf-ocr-preview";

vi.mock("@neoread/api", () => ({ api: { ocrPreview: vi.fn() } }));
const request = vi.mocked(api.ocrPreview);
const job = (
  reparseRun: string | undefined,
  pagesDone: number,
  layoutRevision = "saved",
) => ({
  reparseRun,
  pagesDone,
  layoutRevision,
});

function pauseRequest() {
  // ES2022 target: Promise.withResolvers is not in the repository's TS lib.
  let resolve!: (value: { pages: PDFOCRPreviewPage[] }) => void;
  const pending = new Promise<{ pages: PDFOCRPreviewPage[] }>((finish) => {
    resolve = finish;
  });
  request.mockReturnValueOnce(pending);
  return async (value: { pages: PDFOCRPreviewPage[] }) => {
    resolve(value);
    await pending;
    // The downloader handles rejection on a chained promise.
    await Promise.resolve();
  };
}

beforeEach(() => {
  request.mockReset();
});

it("fetches only newly completed pages in sequential one-based batches", async () => {
  const apply = vi.fn();
  const preview = new PDFOCRPreview("doc", apply);
  preview.update(job("run", 0));
  expect(request).not.toHaveBeenCalled();

  const first = pauseRequest();
  request.mockResolvedValueOnce({ pages: [{ page: 33, lines: [] }] });
  request.mockResolvedValueOnce({ pages: [{ page: 65, lines: [] }] });
  preview.update(job("run", 35));
  preview.update(job("run", 70));
  expect(request.mock.calls.map((call) => call.slice(0, 4))).toEqual([
    ["doc", "run", 1, 32],
  ]);
  await first({ pages: [{ page: 1, lines: [] }] });
  await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(3));
  expect(request.mock.calls.map((call) => call.slice(0, 4))).toEqual([
    ["doc", "run", 1, 32],
    ["doc", "run", 33, 64],
    ["doc", "run", 65, 70],
  ]);
  expect(apply.mock.calls.map(([pages]) => pages[0].page)).toEqual([1, 33, 65]);
  preview.update(job("run", 70));
  expect(request).toHaveBeenCalledTimes(3);
});

it("ignores a superseded run and all responses after closing the reader", async () => {
  const apply = vi.fn();
  const preview = new PDFOCRPreview("doc", apply);
  const old = pauseRequest();
  const next = pauseRequest();
  preview.update(job("old-run", 1));
  preview.update(job("new-run", 2));
  expect(request.mock.calls[0][4]?.aborted).toBe(true);
  expect(request.mock.calls[1].slice(0, 4)).toEqual(["doc", "new-run", 1, 2]);
  await old({ pages: [{ page: 1, lines: [] }] });
  expect(apply.mock.calls).toEqual([[null]]);

  preview.close();
  expect(request.mock.calls[1][4]?.aborted).toBe(true);
  await next({ pages: [{ page: 2, lines: [] }] });
  expect(apply.mock.calls).toEqual([[null], [null]]);
});

it("keeps a published preview until canonical blocks arrive, but clears a failed run", async () => {
  const apply = vi.fn();
  const preview = new PDFOCRPreview("doc", apply);
  const batch = { pages: [{ page: 1, lines: [] }] };
  request.mockResolvedValueOnce(batch);
  preview.update(job("run", 1), "saved");
  await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(batch.pages));

  const late = pauseRequest();
  preview.update(job("run", 2), "saved");
  preview.update(job(undefined, 2, "published"), "saved");
  expect(request.mock.calls[1][4]?.aborted).toBe(true);
  await late({ pages: [{ page: 2, lines: [] }] });
  expect(apply.mock.calls).toEqual([[batch.pages]]);

  preview.update(job(undefined, 2, "published"), "published");
  expect(apply).toHaveBeenLastCalledWith(null);

  request.mockResolvedValueOnce(batch);
  preview.update(job("failed", 1, "published"), "published");
  await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith(batch.pages));
  preview.update(job(undefined, 1, "published"), "published");
  expect(apply).toHaveBeenLastCalledWith(null);
});
