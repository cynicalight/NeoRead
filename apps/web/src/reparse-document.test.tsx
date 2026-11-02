// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Document } from "@neoread/core";

const mocks = vi.hoisted(() => ({
  reparse: vi.fn(),
  refresh: vi.fn(),
  saveCover: vi.fn(),
  getDocument: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@neoread/api", () => ({
  api: { reparseDocument: mocks.reparse, saveCover: mocks.saveCover },
  coverURL: (id: string, revision?: number) =>
    `/cover/${id}?v=${revision ?? 0}`,
  publicationURL: (id: string, resource: string) => `/pub/${id}/${resource}`,
}));
vi.mock("./store", () => ({ refreshLibrary: mocks.refresh }));
vi.mock("sonner", () => ({
  toast: { loading: vi.fn(), success: mocks.success, error: mocks.error },
}));
vi.mock("./diagnostics", () => ({ reportDiagnostic: vi.fn() }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  AnnotationMode: { DISABLE: 0 },
  getDocument: mocks.getDocument,
}));
import { BookCoverImage } from "./book-cover";
import { reparseDocument } from "./reparse-document";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.reparse.mockResolvedValue({});
  mocks.refresh.mockResolvedValue(undefined);
  mocks.saveCover.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "reloads the EPUB cover after reparse, including missing=%s",
  async (missing) => {
    const doc = {
      id: `epub-${missing}`,
      type: "epub",
      title: "Book",
    } as Document;
    await act(async () => root.render(<BookCoverImage doc={doc} />));
    const old = host.querySelector("img")!.src;
    if (missing)
      await act(async () =>
        host.querySelector("img")!.dispatchEvent(new Event("error")),
      );
    await act(async () => reparseDocument(doc));
    expect(host.querySelector("img")).not.toBeNull();
    expect(host.querySelector("img")!.src).not.toBe(old);
    expect(mocks.saveCover).not.toHaveBeenCalled();
  },
);

it("renders and saves a fresh PDF first page even when an old cover exists", async () => {
  const doc = { id: "pdf-refresh", type: "pdf", title: "PDF" } as Document;
  const blob = new Blob(["jpeg"], { type: "image/jpeg" });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(blob),
  );
  const destroy = vi.fn();
  const getPage = vi.fn().mockResolvedValue({
    getViewport: () => ({ width: 420, height: 600 }),
    render: () => ({ promise: Promise.resolve() }),
  });
  mocks.getDocument.mockReturnValue({
    promise: Promise.resolve({ getPage }),
    destroy,
  });
  await act(async () => root.render(<BookCoverImage doc={doc} />));
  const old = host.querySelector("img")!.src;
  await act(async () => reparseDocument(doc));
  expect(getPage).toHaveBeenCalledWith(1);
  expect(mocks.saveCover).toHaveBeenCalledWith(doc.id, blob);
  expect(mocks.getDocument.mock.calls[0][0].url).toMatch(
    /original\.pdf\?v=\d+/,
  );
  expect(host.querySelector("img")!.src).not.toBe(old);
  expect(destroy).toHaveBeenCalled();
});

it("keeps the old cover when parsing fails", async () => {
  const doc = { id: "failed-epub", type: "epub", title: "Book" } as Document;
  mocks.reparse.mockRejectedValueOnce(new Error("invalid EPUB"));
  await act(async () => root.render(<BookCoverImage doc={doc} />));
  const old = host.querySelector("img")!.src;
  await act(async () => reparseDocument(doc));
  expect(host.querySelector("img")!.src).toBe(old);
  expect(mocks.success).not.toHaveBeenCalled();
});

it("reports a cover failure separately and preserves the previous PDF cover", async () => {
  const doc = {
    id: "pdf-cover-failure",
    type: "pdf",
    title: "PDF",
  } as Document;
  const destroy = vi.fn();
  mocks.getDocument.mockImplementation(() => ({
    promise: Promise.reject(new Error("PDF rendering failed")),
    destroy,
  }));
  await act(async () => root.render(<BookCoverImage doc={doc} />));
  const old = host.querySelector("img")!.src;
  await act(async () => reparseDocument(doc));
  expect(host.querySelector("img")!.src).toBe(old);
  expect(mocks.error).toHaveBeenCalledWith(
    expect.stringContaining("文档重新解析完成，但封面刷新失败"),
    expect.anything(),
  );
  expect(mocks.success).not.toHaveBeenCalled();
  expect(destroy).toHaveBeenCalled();
});

it("waits for an earlier PDF cover upload before publishing the refreshed cover", async () => {
  const doc = { id: "pdf-in-flight", type: "pdf", title: "PDF" } as Document;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["jpeg"])),
  );
  mocks.getDocument.mockImplementation(() => ({
    promise: Promise.resolve({
      getPage: async () => ({
        getViewport: () => ({ width: 420, height: 600 }),
        render: () => ({ promise: Promise.resolve() }),
      }),
    }),
    destroy: vi.fn(),
  }));
  let finishOld!: () => void;
  mocks.saveCover.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishOld = resolve;
      }),
  );
  await act(async () => root.render(<BookCoverImage doc={doc} />));
  await act(async () =>
    host.querySelector("img")!.dispatchEvent(new Event("error")),
  );
  expect(mocks.saveCover).toHaveBeenCalledTimes(1);
  let refresh!: Promise<void>;
  await act(async () => {
    refresh = reparseDocument(doc);
  });
  expect(mocks.getDocument).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishOld();
    await refresh;
  });
  expect(mocks.saveCover).toHaveBeenCalledTimes(2);
  expect(mocks.getDocument.mock.calls[1][0].url).toMatch(
    /original\.pdf\?v=\d+/,
  );
  expect(mocks.success).toHaveBeenCalledOnce();
});
