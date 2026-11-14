// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import type { Document, Processing } from "@neoread/core";

const mocks = vi.hoisted(() => ({
  reparse: vi.fn(),
  refresh: vi.fn(),
  saveCover: vi.fn(),
  getDocument: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@neoread/api", () => ({
  api: {
    reparseDocument: mocks.reparse,
    assistance: vi.fn(async () => undefined),
    setAssistance: (...args: unknown[]) => mocks.reparse(...args),
    saveCover: mocks.saveCover,
  },
  coverURL: (id: string, revision?: number) =>
    `/cover/${id}?v=${revision ?? 0}`,
  publicationURL: (id: string, resource: string) => `/pub/${id}/${resource}`,
}));
vi.mock("./store", () => ({ refreshLibrary: mocks.refresh }));
vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    success: mocks.success,
    error: mocks.error,
    warning: mocks.warning,
  },
}));
vi.mock("./diagnostics", () => ({ reportDiagnostic: vi.fn() }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  AnnotationMode: { DISABLE: 0 },
  getDocument: mocks.getDocument,
}));
import { BookCoverImage } from "./book-cover";
import { AssistanceControls } from "./translation/AssistanceControls";
import {
  observeReparsedLayouts,
  reparseDocument,
} from "./reparse-document";

const acceptedAt = "2026-11-14T00:00:00Z";
function job(documentId: string, patch: Partial<Processing> = {}): Processing {
  return {
    documentId,
    phase: "translating",
    status: "queued",
    retranslating: true,
    enabled: true,
    layoutRevision: "old",
    pagesDone: 0,
    pagesTotal: 0,
    translationsDone: 0,
    translationsTotal: 0,
    detail: "等待重新解析版面",
    updatedAt: acceptedAt,
    ...patch,
  };
}
const published = (id: string) =>
  job(id, {
    layoutRevision: "new",
    status: "running",
    updatedAt: "2026-11-14T00:00:05Z",
  });
const settle = () => act(() => delay(20));
function renderablePDF() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["jpeg"], { type: "image/jpeg" })),
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
  return { getPage, destroy };
}

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.reparse.mockImplementation(async (id: string) => job(id));
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
const cover = () => host.querySelector("img")?.src;

it("reports an accepted book reparse without promising translation and keeps the cover until publication", async () => {
  const doc = {
    id: "epub-started",
    type: "epub",
    library: "books",
    title: "Book",
  } as Document;
  await act(async () => root.render(<BookCoverImage doc={doc} />));
  const old = cover();
  await act(async () => reparseDocument(doc));
  expect(mocks.success).toHaveBeenCalledWith(
    "已开始重新解析《Book》，进度见处理状态。",
    expect.anything(),
  );
  expect(mocks.success.mock.calls[0][0]).not.toMatch(/翻译|整本书|完成/);
  observeReparsedLayouts([job(doc.id, { status: "running" })]);
  await settle();
  expect(cover()).toBe(old);
  observeReparsedLayouts([published(doc.id)]);
  await settle();
  expect(cover()).not.toBe(old);
  expect(mocks.saveCover).not.toHaveBeenCalled();
});

it("refreshes the cover after a restart accepted through the reader", async () => {
  const doc = {
    id: "reader-restart",
    type: "pdf",
    library: "papers",
    title: "Paper",
  } as Document;
  const ready = job(doc.id, { phase: "ready", status: "complete" });
  renderablePDF();
  await act(async () =>
    root.render(
      <>
        <BookCoverImage doc={doc} />
        <AssistanceControls document={doc} processing={ready} />
      </>,
    ),
  );
  const old = cover();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="重新解析并翻译"]')!
      .click(),
  );
  await act(async () =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="alertdialog"] button',
      ),
    ]
      .find((button) => button.textContent === "开始重新解析并翻译")!
      .click(),
  );
  expect(cover()).toBe(old);
  observeReparsedLayouts([published(doc.id)]);
  await settle();
  expect(cover()).not.toBe(old);
});

it("reloads a missing EPUB cover once the reparse publishes", async () => {
  const doc = { id: "epub-missing", type: "epub", title: "Book" } as Document;
  await act(async () => root.render(<BookCoverImage doc={doc} />));
  await act(async () =>
    host.querySelector("img")!.dispatchEvent(new Event("error")),
  );
  expect(cover()).toBeUndefined();
  await act(async () => reparseDocument(doc));
  observeReparsedLayouts([published(doc.id)]);
  await settle();
  expect(cover()).toBeDefined();
});

it("renders and saves a fresh PDF first page after publication", async () => {
  const doc = {
    id: "pdf-refresh",
    type: "pdf",
    library: "papers",
    title: "PDF",
  } as Document;
  const { getPage, destroy } = renderablePDF();
  await act(async () => root.render(<BookCoverImage doc={doc} />));
  const old = cover();
  await act(async () => reparseDocument(doc));
  expect(mocks.success.mock.calls[0][0]).not.toMatch(/翻译|全文/);
  expect(getPage).not.toHaveBeenCalled();
  observeReparsedLayouts([published(doc.id)]);
  await settle();
  expect(getPage).toHaveBeenCalledWith(1);
  expect(mocks.saveCover).toHaveBeenCalledWith(doc.id, expect.any(Blob));
  expect(mocks.getDocument.mock.calls[0][0].url).toMatch(
    /original\.pdf\?v=\d+/,
  );
  expect(cover()).not.toBe(old);
  expect(destroy).toHaveBeenCalled();
});

it("ignores a poll issued before the job was accepted", async () => {
  const doc = { id: "pdf-stale-poll", type: "pdf", title: "PDF" } as Document;
  const { getPage } = renderablePDF();
  await act(async () => reparseDocument(doc));
  observeReparsedLayouts([
    { ...published(doc.id), updatedAt: "2026-11-13T00:00:00Z" },
  ]);
  observeReparsedLayouts([
    job(doc.id, { status: "failed", updatedAt: "2026-11-13T00:00:00Z" }),
  ]);
  await settle();
  expect(getPage).not.toHaveBeenCalled();
  expect(mocks.error).not.toHaveBeenCalled();
  observeReparsedLayouts([published(doc.id)]);
  await settle();
  expect(getPage).toHaveBeenCalledOnce();
});

it("keeps the old cover when the request is rejected", async () => {
  const doc = { id: "rejected-epub", type: "epub", title: "Book" } as Document;
  mocks.reparse.mockRejectedValueOnce(new Error("文档正在处理"));
  await act(async () => root.render(<BookCoverImage doc={doc} />));
  const old = cover();
  await act(async () => reparseDocument(doc));
  expect(mocks.error).toHaveBeenCalledWith("文档正在处理", expect.anything());
  expect(mocks.success).not.toHaveBeenCalled();
  observeReparsedLayouts([published(doc.id)]);
  await settle();
  expect(cover()).toBe(old);
});

it("reports a background parse failure and a configuration wait truthfully", async () => {
  const doc = { id: "failed-pdf", type: "pdf", title: "PDF" } as Document;
  const { getPage } = renderablePDF();
  await act(async () => reparseDocument(doc));
  const waiting = job(doc.id, {
    status: "waiting",
    detail: "请先配置翻译模型",
  });
  observeReparsedLayouts([waiting]);
  observeReparsedLayouts([waiting]);
  expect(mocks.warning).toHaveBeenCalledOnce();
  expect(mocks.warning).toHaveBeenCalledWith(
    "《PDF》重新解析正在等待：请先配置翻译模型",
  );
  observeReparsedLayouts([
    job(doc.id, { status: "failed", detail: "版面解析失败" }),
  ]);
  expect(mocks.error).toHaveBeenCalledWith("《PDF》重新解析失败：版面解析失败");
  observeReparsedLayouts([published(doc.id)]);
  await settle();
  expect(getPage).not.toHaveBeenCalled();
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
  const old = cover();
  await act(async () => reparseDocument(doc));
  observeReparsedLayouts([published(doc.id)]);
  await settle();
  expect(cover()).toBe(old);
  expect(mocks.error).toHaveBeenCalledWith(
    "《PDF》已重新解析，但封面刷新失败：PDF rendering failed",
  );
  expect(destroy).toHaveBeenCalled();
});

it("waits for an earlier PDF cover upload before publishing the refreshed cover", async () => {
  const doc = { id: "pdf-in-flight", type: "pdf", title: "PDF" } as Document;
  renderablePDF();
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
  await act(async () => reparseDocument(doc));
  observeReparsedLayouts([published(doc.id)]);
  await settle();
  expect(mocks.getDocument).toHaveBeenCalledTimes(1);
  await act(async () => finishOld());
  await settle();
  expect(mocks.saveCover).toHaveBeenCalledTimes(2);
  expect(mocks.getDocument.mock.calls[1][0].url).toMatch(
    /original\.pdf\?v=\d+/,
  );
  expect(mocks.error).not.toHaveBeenCalled();
});
