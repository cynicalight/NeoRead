import { api, type OCRAction, type OCRStatus } from "@neoread/api";
import type { Document } from "@neoread/core";
import { toast } from "sonner";
import { create } from "zustand";
import { reparseDocument } from "./reparse-document";
import { useReaderStore } from "./store";

/** A document whose parse found scanned pages. */
export interface ScanDocument {
  id: string;
  title: string;
}

export const scanToastId = "ocr-scan";
export const modelToastId = "ocr-model";
const downloadPollMs = 1000;
const refreshGapMs = 2000;

export const useOCRStore = create<{
  status: OCRStatus | null;
  error: string;
  /** Settings section requested by a notification; consumed by App. */
  settingsRequest: number;
  /** Documents offered for re-parsing with the new engine. */
  reparseOffer: ScanDocument[];
}>(() => ({ status: null, error: "", settingsRequest: 0, reparseOffer: [] }));

// Scanned documents seen this session, kept after the server clears its
// notices so a finished download can still offer to re-parse them.
const scanned = new Map<string, string>();
// Notices already announced this session; the server persists dismissal.
const announced = new Set<string>();
let toastDocs: ScanDocument[] = [];
let closingQuietly = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> | undefined;
let queued = false;
let lastRefresh = 0;

export function openOCRSettings() {
  useOCRStore.setState((s) => ({ settingsRequest: s.settingsRequest + 1 }));
}

/** Decimal megabytes, as download sizes are usually quoted. */
export const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(2);

export const modelSize = (status: OCRStatus) =>
  status.totalBytes > 0 ? `${megabytes(status.totalBytes)} MB` : "约 90 MB";

function scanDescription(status: OCRStatus) {
  if (status.engine === "system")
    return status.modelState === "downloading"
      ? "当前使用系统文字识别，PaddleOCR 模型正在下载。"
      : "当前使用系统文字识别，也可下载 PaddleOCR 模型。";
  if (status.engine === "paddle") return "当前使用 PaddleOCR 文字识别。";
  if (status.modelState === "downloading")
    return "文字识别模型正在下载，完成后可重新解析。";
  if (status.modelState === "failed")
    return "文字识别模型下载失败，可在设置中重试。";
  return `这些页面没有可选中的文字。下载文字识别模型（${modelSize(status)}）后可以识别。`;
}

async function dismiss(docs: ScanDocument[]) {
  for (const doc of docs) {
    try {
      apply(await api.updateOCR({ action: "dismiss", documentId: doc.id }));
    } catch {
      // The notice stays on the server and returns after a restart.
    }
  }
}

function closeScanToast() {
  if (!toastDocs.length) return;
  closingQuietly = true;
  toast.dismiss(scanToastId);
  closingQuietly = false;
  toastDocs = [];
}

function showScanToast(status: OCRStatus) {
  const docs = toastDocs;
  const subject =
    docs.length === 1
      ? `《${docs[0].title}》`
      : `《${docs[0].title}》等 ${docs.length} 份文档`;
  toast.info(`${subject}中发现扫描页`, {
    id: scanToastId,
    description: scanDescription(status),
    duration: Infinity,
    closeButton: true,
    action: {
      label: "文字识别设置",
      onClick: () => {
        openOCRSettings();
        toastDocs = [];
        void dismiss(docs);
      },
    },
    onDismiss: () => {
      if (closingQuietly || toastDocs !== docs) return;
      toastDocs = [];
      void dismiss(docs);
    },
  });
}

function announce(status: OCRStatus, previous: OCRStatus | null) {
  const current = new Set(status.notices.map((n) => n.documentId));
  for (const notice of status.notices)
    scanned.set(notice.documentId, notice.title);
  const fresh = status.notices
    .filter((n) => !announced.has(n.documentId))
    .map((n) => ({ id: n.documentId, title: n.title }));
  for (const notice of fresh) announced.add(notice.id);
  const kept = toastDocs.filter((doc) => current.has(doc.id));
  if (!kept.length && !fresh.length) return closeScanToast();
  const changed =
    fresh.length > 0 ||
    kept.length !== toastDocs.length ||
    previous?.engine !== status.engine ||
    previous?.modelState !== status.modelState;
  if (!changed) return;
  toastDocs = [...kept, ...fresh];
  showScanToast(status);
}

export function scannedDocuments(): ScanDocument[] {
  return [...scanned].map(([id, title]) => ({ id, title }));
}

function offerReparse() {
  if (scanned.size) useOCRStore.setState({ reparseOffer: scannedDocuments() });
}

function reportModel(status: OCRStatus, previous: OCRStatus | null) {
  if (previous?.modelState !== "downloading") return;
  if (status.modelState === "failed")
    toast.error("文字识别模型下载失败", {
      id: modelToastId,
      duration: Infinity,
      closeButton: true,
      action: { label: "重试", onClick: () => void runOCRAction("download") },
    });
  else if (status.modelState === "ready") {
    const reparse = scanned.size
      ? { label: "重新解析…", onClick: offerReparse }
      : undefined;
    if (status.engine === "paddle")
      toast.success("文字识别模型已就绪", {
        id: modelToastId,
        description: "之后解析的扫描页会使用 PaddleOCR。",
        duration: Infinity,
        closeButton: true,
        action: reparse,
      });
    else
      toast.success("PaddleOCR 模型已下载", {
        id: modelToastId,
        description: "当前仍使用系统文字识别，可以随时切换。",
        duration: Infinity,
        closeButton: true,
        action: {
          label: "改用 PaddleOCR",
          onClick: () => void runOCRAction("use-paddle"),
        },
      });
  }
}

function schedule(status: OCRStatus) {
  clearTimeout(pollTimer);
  pollTimer = undefined;
  if (status.modelState === "downloading")
    pollTimer = setTimeout(() => void refreshOCR(true), downloadPollMs);
}

function apply(status: OCRStatus) {
  const previous = useOCRStore.getState().status;
  useOCRStore.setState({ status, error: "" });
  announce(status, previous);
  reportModel(status, previous);
  schedule(status);
}

/**
 * Reads the OCR state. Callers may fire this on every processing change; it
 * coalesces into at most one request per gap. Downloads poll on their own.
 */
export function refreshOCR(force = false): Promise<void> {
  if (inflight) {
    queued = true;
    return inflight;
  }
  const wait = force ? 0 : lastRefresh + refreshGapMs - Date.now();
  if (wait > 0) {
    if (!queued) {
      queued = true;
      setTimeout(() => {
        queued = false;
        void refreshOCR(true);
      }, wait);
    }
    return Promise.resolve();
  }
  lastRefresh = Date.now();
  inflight = api
    .ocr()
    .then(apply)
    .catch((error: Error) => useOCRStore.setState({ error: error.message }))
    .finally(() => {
      inflight = undefined;
      if (queued) {
        queued = false;
        void refreshOCR();
      }
    });
  return inflight;
}

/** Actions the user triggers from settings or notifications. */
export type OCRUserAction = Exclude<OCRAction["action"], "dismiss">;

export async function runOCRAction(action: OCRUserAction) {
  try {
    const previous = useOCRStore.getState().status;
    apply(await api.updateOCR({ action }));
    if (action === "use-paddle" || action === "use-system") {
      const name = action === "use-paddle" ? "PaddleOCR" : "系统文字识别";
      if (previous?.engine === useOCRStore.getState().status?.engine) return;
      toast.success(`已改用${name}`, {
        id: modelToastId,
        description: scanned.size
          ? "已解析的扫描文档需重新解析后才会使用新引擎。"
          : "之后解析的扫描页会使用新引擎。",
        action: scanned.size
          ? { label: "重新解析…", onClick: offerReparse }
          : undefined,
      });
    }
  } catch (error) {
    toast.error((error as Error).message);
  }
}

/** Re-parses the confirmed documents through the existing re-parse flow. */
export function confirmReparse(ids: string[]) {
  const documents = useReaderStore.getState().documents;
  useOCRStore.setState({ reparseOffer: [] });
  for (const id of ids) {
    const doc = documents.find((d: Document) => d.id === id);
    if (doc) void reparseDocument(doc);
  }
}

export function resetOCRForTests() {
  clearTimeout(pollTimer);
  scanned.clear();
  announced.clear();
  toastDocs = [];
  inflight = undefined;
  queued = false;
  lastRefresh = 0;
  useOCRStore.setState({
    status: null,
    error: "",
    settingsRequest: 0,
    reparseOffer: [],
  });
}
