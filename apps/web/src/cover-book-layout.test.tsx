// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Processing } from "@neoread/core";
import { CoverProcessing } from "./ProcessingStatus";
vi.mock("@neoread/api", () => ({ api: { process: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// A book PDF waits for chapter requests, so its translation stays ready.
const book = (bookLayout?: Processing["bookLayout"]): Processing => ({
  documentId: "book",
  phase: "ready",
  status: "complete",
  pagesDone: 0,
  pagesTotal: 0,
  translationsDone: 0,
  translationsTotal: 0,
  detail: "",
  updatedAt: "",
  bookLayout,
});
let root: Root, host: HTMLDivElement;
const render = (job: Processing) =>
  act(() => root.render(<CoverProcessing job={job} onSettings={() => {}} />));
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("shows background layout progress on book covers", () => {
  render(book({ status: "running", pagesDone: 12, pagesTotal: 48 }));
  expect(host.textContent).toContain("解析中");
  expect(host.textContent).toContain("12 / 48 页");
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  render(book({ status: "queued", pagesDone: 0, pagesTotal: 48 }));
  expect(host.textContent).toContain("等待解析");
  render(book({ status: "failed", pagesDone: 12, pagesTotal: 48 }));
  expect(host.textContent).toContain("解析失败");
});

it("fades out once every page is parsed", () => {
  vi.useFakeTimers();
  render(book({ status: "running", pagesDone: 47, pagesTotal: 48 }));
  render(book({ status: "complete", pagesDone: 48, pagesTotal: 48 }));
  expect(host.textContent).toContain("解析完成");
  act(() => vi.advanceTimersByTime(750));
  expect(host.textContent).toBe("");
});

it("stays hidden for books parsed before the library opened", () => {
  render(book({ status: "complete", pagesDone: 48, pagesTotal: 48 }));
  expect(host.textContent).toBe("");
  render(book());
  expect(host.textContent).toBe("");
});

it("immediately replaces published layout status with this reparse's measured pages", () => {
  const published = book({ status: "complete", pagesDone: 48, pagesTotal: 48 });
  render(published);
  render({
    ...published,
    phase: "translating",
    status: "queued",
    retranslating: true,
    reparseStatus: "queued",
    pagesDone: 48,
    pagesTotal: 48,
  });
  expect(host.querySelector('[role="status"]')?.textContent).toBe("等待文字解析");
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  const reparse: Processing = {
    ...published,
    phase: "translating",
    status: "running",
    translating: { status: "complete", detail: "翻译完成" },
    reparseStatus: "running",
    pagesDone: 0,
    pagesTotal: 48,
  };
  render(reparse);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "文字解析中0 / 48 页",
  );
  render({ ...reparse, status: "running", pagesDone: 12 });
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "文字解析中12 / 48 页",
  );
  expect(
    host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"),
  ).toBe("25");
  render(published);
  expect(host.textContent).toBe("");
});
