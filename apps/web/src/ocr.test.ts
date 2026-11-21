import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OCRStatus } from "@neoread/api";
import {
  confirmReparse,
  refreshOCR,
  resetOCRForTests,
  useOCRStore,
} from "./ocr";

const { ocr, updateOCR, reparseDocument, documents, toast } = vi.hoisted(
  () => ({
    ocr: vi.fn<() => Promise<OCRStatus>>(),
    updateOCR: vi.fn<(payload: unknown) => Promise<OCRStatus>>(),
    reparseDocument: vi.fn(),
    documents: [{ id: "a", title: "Scan A" }],
    toast: Object.assign(vi.fn(), {
      info: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      dismiss: vi.fn(),
    }),
  }),
);

vi.mock("@neoread/api", () => ({ api: { ocr, updateOCR } }));
vi.mock("sonner", () => ({ toast }));
vi.mock("./reparse-document", () => ({ reparseDocument }));
vi.mock("./store", () => ({
  useReaderStore: { getState: () => ({ documents }) },
}));

const status = (patch: Partial<OCRStatus> = {}): OCRStatus => ({
  systemAvailable: false,
  engine: "none",
  modelState: "missing",
  downloadedBytes: 0,
  totalBytes: 0,
  notices: [],
  ...patch,
});
const notice = (documentId: string) => ({
  documentId,
  title: `Scan ${documentId.toUpperCase()}`,
});
type ToastOptions = {
  duration?: number;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
};
const options = (call: unknown[]) => call[1] as ToastOptions;

beforeEach(() => {
  resetOCRForTests();
  vi.resetAllMocks();
});
afterEach(() => vi.useRealTimers());

it("announces scanned documents once, persistently, across repeated reads", async () => {
  ocr.mockResolvedValue(status({ notices: [notice("a"), notice("b")] }));
  await refreshOCR(true);
  await refreshOCR(true);
  expect(toast.info).toHaveBeenCalledTimes(1);
  expect(toast.info.mock.calls[0][0]).toBe("《Scan A》等 2 份文档中发现扫描页");
  expect(options(toast.info.mock.calls[0]).duration).toBe(Infinity);
  expect(updateOCR).not.toHaveBeenCalled();
});

it("acknowledges every aggregated document only when the user closes the toast", async () => {
  ocr.mockResolvedValue(status({ notices: [notice("a"), notice("b")] }));
  updateOCR.mockResolvedValue(status());
  await refreshOCR(true);
  options(toast.info.mock.calls[0]).onDismiss!();
  await vi.waitFor(() => expect(updateOCR).toHaveBeenCalledTimes(2));
  expect(updateOCR).toHaveBeenCalledWith({
    action: "dismiss",
    documentId: "a",
  });
  expect(updateOCR).toHaveBeenCalledWith({
    action: "dismiss",
    documentId: "b",
  });
});

it("opens OCR settings from the toast and acknowledges the notice", async () => {
  ocr.mockResolvedValue(status({ notices: [notice("a")] }));
  updateOCR.mockResolvedValue(status());
  await refreshOCR(true);
  const { action, onDismiss } = options(toast.info.mock.calls[0]);
  action!.onClick();
  onDismiss!();
  expect(useOCRStore.getState().settingsRequest).toBe(1);
  await vi.waitFor(() => expect(updateOCR).toHaveBeenCalledTimes(1));
});

it("closes the toast without acknowledging when the server clears notices", async () => {
  ocr.mockResolvedValueOnce(status({ notices: [notice("a")] }));
  await refreshOCR(true);
  toast.dismiss.mockImplementation(() =>
    options(toast.info.mock.calls[0]).onDismiss!(),
  );
  ocr.mockResolvedValueOnce(status({ modelState: "ready", engine: "paddle" }));
  await refreshOCR(true);
  expect(toast.dismiss).toHaveBeenCalledWith("ocr-scan");
  expect(updateOCR).not.toHaveBeenCalled();
});

it("polls a download and offers to re-parse scanned documents when it finishes", async () => {
  vi.useFakeTimers();
  ocr.mockResolvedValueOnce(
    status({ modelState: "downloading", notices: [notice("a")] }),
  );
  await refreshOCR(true);
  ocr.mockResolvedValueOnce(status({ modelState: "ready", engine: "paddle" }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(ocr).toHaveBeenCalledTimes(2);
  const [title, ready] = toast.success.mock.calls[0];
  expect(title).toBe("文字识别模型已就绪");
  options([title, ready]).action!.onClick();
  expect(useOCRStore.getState().reparseOffer).toEqual([
    { id: "a", title: "Scan A" },
  ]);
  confirmReparse(["a"]);
  expect(reparseDocument).toHaveBeenCalledWith(documents[0]);
  expect(useOCRStore.getState().reparseOffer).toEqual([]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(ocr).toHaveBeenCalledTimes(2);
});

it("keeps system OCR on macOS after the model downloads", async () => {
  vi.useFakeTimers();
  const mac = { systemAvailable: true, engine: "system" as const };
  ocr.mockResolvedValueOnce(status({ ...mac, modelState: "downloading" }));
  await refreshOCR(true);
  ocr.mockResolvedValueOnce(status({ ...mac, modelState: "ready" }));
  await vi.advanceTimersByTimeAsync(1000);
  const [title, opts] = toast.success.mock.calls[0];
  expect(title).toBe("PaddleOCR 模型已下载");
  updateOCR.mockResolvedValue(
    status({ ...mac, engine: "paddle", modelState: "ready" }),
  );
  options([title, opts]).action!.onClick();
  await vi.waitFor(() =>
    expect(updateOCR).toHaveBeenCalledWith({ action: "use-paddle" }),
  );
  expect(updateOCR).toHaveBeenCalledTimes(1);
});

it("offers a retry when the download fails", async () => {
  vi.useFakeTimers();
  ocr.mockResolvedValueOnce(status({ modelState: "downloading" }));
  await refreshOCR(true);
  ocr.mockResolvedValueOnce(status({ modelState: "failed" }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(toast.error.mock.calls[0][0]).toBe("文字识别模型下载失败");
  expect(options(toast.error.mock.calls[0]).action!.label).toBe("重试");
});
