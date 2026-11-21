import { afterEach, expect, it, vi } from "vitest";
import { api, type OCRStatus } from "./index";

afterEach(() => vi.unstubAllGlobals());

it("reads OCR status and posts explicit model and notice actions", async () => {
  const status: OCRStatus = {
    systemAvailable: true,
    engine: "system",
    modelState: "missing",
    downloadedBytes: 0,
    totalBytes: 89_477_890,
    notices: [{ documentId: "doc", title: "Scan" }],
  };
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json(status),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await api.ocr()).toEqual(status);
  expect(await api.updateOCR({ action: "download" })).toEqual(status);
  await api.updateOCR({ action: "dismiss", documentId: "doc" });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/ocr",
    "/api/ocr",
    "/api/ocr",
  ]);
  expect(fetch.mock.calls[0][1].method).toBeUndefined();
  expect(fetch.mock.calls[1][1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({ action: "download" }),
  });
  expect(fetch.mock.calls[2][1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({ action: "dismiss", documentId: "doc" }),
  });
});
