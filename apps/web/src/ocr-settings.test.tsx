// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OCRStatus } from "@neoread/api";
import { OCRSettings } from "./OCRSettings";
import { resetOCRForTests } from "./ocr";

const { ocr, updateOCR } = vi.hoisted(() => ({
  ocr: vi.fn<() => Promise<OCRStatus>>(),
  updateOCR: vi.fn<(payload: unknown) => Promise<OCRStatus>>(),
}));
vi.mock("@neoread/api", () => ({ api: { ocr, updateOCR } }));
vi.mock("./reparse-document", () => ({ reparseDocument: vi.fn() }));
vi.mock("./store", () => ({
  useReaderStore: { getState: () => ({ documents: [] }) },
}));

const status = (patch: Partial<OCRStatus> = {}): OCRStatus => ({
  systemAvailable: false,
  engine: "none",
  modelState: "missing",
  downloadedBytes: 0,
  totalBytes: 89_480_000,
  notices: [],
  ...patch,
});
let root: Root;
let host: HTMLDivElement;
const render = async (value: OCRStatus) => {
  ocr.mockResolvedValue(value);
  await act(async () => root.render(<OCRSettings open />));
};
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(name),
  );

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetOCRForTests();
  vi.resetAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("asks Windows users to download the model, without an engine choice", async () => {
  await render(status());
  expect(host.textContent).toContain("本机没有系统文字识别");
  expect(host.textContent).toContain("89.48 MB");
  expect(button("PaddleOCR")).toBeUndefined();
  updateOCR.mockResolvedValue(
    status({ modelState: "downloading", downloadedBytes: 44_740_000 }),
  );
  await act(async () => button("下载")!.click());
  expect(updateOCR).toHaveBeenCalledWith({ action: "download" });
  expect(host.textContent).toContain("正在下载 44.74 / 89.48 MB");
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
});

it("keeps PaddleOCR unavailable on macOS until the model is installed", async () => {
  await render(status({ systemAvailable: true, engine: "system" }));
  expect(button("系统")!.getAttribute("aria-selected")).toBe("true");
  expect(
    button("PaddleOCR")!.hasAttribute("disabled") ||
      button("PaddleOCR")!.getAttribute("aria-disabled") === "true",
  ).toBe(true);
  expect(host.textContent).toContain("仅在点击下载时联网");
});

it("offers a retry after a failed download", async () => {
  await render(status({ modelState: "failed" }));
  expect(host.textContent).toContain("下载失败");
  expect(button("重试")).toBeDefined();
});
