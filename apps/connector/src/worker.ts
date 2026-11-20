/// <reference types="chrome" />
import type { Candidate } from "./detect";
import {
  clearCNKIRequestRule,
  ConnectorError,
  downloadPDF,
  readCNKIPage,
} from "./download";
import { scienceDirectArticleURL } from "./scienceDirect";
import { citationForPII, findPublishedCopy } from "./publishedCopy";
import { createScienceDirectResume, type ImportResult } from "./scienceDirectResume";
// Remove a rule left by an interrupted service worker before handling requests.
const ready = clearCNKIRequestRule().then(
  () => null,
  () => "无法初始化知网下载规则，请重新加载插件",
);
const bridge = "http://127.0.0.1:17841";
async function save(
  candidate: Candidate,
  folders: string[],
  tags: string[],
  allowLarge = false,
  library: "papers" | "books" = "papers",
  attempt?: { pdfUrl: string; signal: AbortSignal; repositoryOnly?: boolean },
): Promise<ImportResult> {
  const { secret } = await chrome.storage.local.get("secret");
  if (!secret)
    return { ok: false, error: "请先打开 NeoRead 后重新打开插件" };
  attempt?.signal.throwIfAborted();
  let blob: Blob | undefined;
  let copyURL: string | undefined;
  let metadata = candidate.metadata;
  if (!attempt?.repositoryOnly) {
    try {
      blob = attempt
        ? await downloadPDF({ ...candidate, pdfUrl: attempt.pdfUrl }, { visibleScienceDirectPDF: true, signal: attempt.signal })
        : await downloadPDF(candidate);
    } catch (error) {
      if (!scienceDirectArticleURL(candidate.sourceUrl) || !(error instanceof ConnectorError) ||
          !["sciencedirect-browser-required", "pdf-network", "pdf-http"].includes(error.code)) throw error;
    }
  }
  if (!blob) {
    attempt?.signal.throwIfAborted();
    if (attempt && !metadata.doi) {
      // Viewer tasks retain the canonical article URL, never the CDN query.
      const pii = candidate.sourceUrl.slice(candidate.sourceUrl.lastIndexOf("/") + 1);
      const citation = await citationForPII(pii, attempt.signal);
      if (citation) metadata = { ...metadata, doi: citation.doi, title: citation.title || candidate.title };
    }
    attempt?.signal.throwIfAborted();
    const doi = metadata.doi;
    const copy = typeof doi === "string" && doi ? await findPublishedCopy(doi, attempt?.signal) : null;
    if (!copy) return { ok: false, code: "pdf-unavailable",
      error: "未取得本篇 PDF，也未找到可核实的公开出版版。请从论文页重新打开 PDF，或导入已下载的文件。" };
    blob = copy.blob;
    copyURL = copy.url;
  }
  attempt?.signal.throwIfAborted();
  const form = new FormData();
  form.append("library", library);
  form.append("pdf", blob, "paper.pdf");
  form.append("metadata", JSON.stringify(metadata));
  form.append("sourceUrl", candidate.sourceUrl);
  form.append("snapshot", candidate.snapshot);
  form.append("tags", JSON.stringify(tags));
  form.append("folders", JSON.stringify(folders));
  if (allowLarge) form.append("allowLarge", "1");
  let response: Response;
  try {
    response = await fetch(bridge + "/v1/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: form,
      signal: attempt?.signal,
    });
  } catch {
    return {
      ok: false,
      error: "无法连接 NeoRead，请确认桌面应用正在运行",
    };
  }
  const data = await response
    .json()
    .catch(() => ({ error: `收录失败 (${response.status})` }));
  return response.ok
    ? { ok: true, document: data.document, warnings: copyURL
        ? [...(data.warnings ?? []), `PDF 来源：公开仓储的出版版（${copyURL}）`]
        : data.warnings }
    : {
        ok: false,
        error: data.error || "收录失败",
        code: data.code,
        pages: data.pages,
      };
}
const scienceDirect = createScienceDirectResume((request, attempt) =>
  save(
    request.candidate,
    request.folders,
    request.tags,
    request.allowLarge,
    request.library,
    attempt,
  ),
);

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
    const m = message as {
      type?: string;
      url?: string;
      sourceUrl?: string;
      candidate?: Candidate;
      folders?: string[];
      tags?: string[];
      allowLarge?: boolean;
      library?: "papers" | "books";
      tabId?: number;
      viewerTabId?: number;
    };
    if (sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL("popup.html"))
      return;
    if (
      m?.type === "sciencedirect-status" ||
      m?.type === "sciencedirect-resume" ||
      m?.type === "sciencedirect-dismiss"
    ) {
      const tabId = m.tabId;
      if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0)
        return;
      const operation = m.type === "sciencedirect-status"
        ? scienceDirect.status(tabId)
        : m.type === "sciencedirect-dismiss"
          ? scienceDirect.dismiss(tabId)
          : scienceDirect.resume(tabId, {
              allowLarge: m.allowLarge === true,
              library: m.library === "papers" || m.library === "books" ? m.library : undefined,
            });
      void operation.then(sendResponse, () =>
        sendResponse({ ok: false, error: "无法恢复收录，请重新打开插件后重试" }),
      );
      return true;
    }
    if (m?.type !== "save" && m?.type !== "cnki-page") return;
    void (async () => {
      const initializationError = await ready;
      if (initializationError)
        throw new ConnectorError("connector-init", initializationError);
      if (m.type === "cnki-page" && m.url && m.sourceUrl) {
        return { ok: true, ...(await readCNKIPage(m.url, m.sourceUrl)) };
      }
      if (!m.candidate)
        throw new ConnectorError("invalid-request", "收录请求缺少论文信息");
      if (m.viewerTabId !== undefined) {
        const source = scienceDirectArticleURL(m.candidate.sourceUrl);
        if (!source || !Number.isSafeInteger(m.viewerTabId) || m.viewerTabId < 0)
          throw new ConnectorError("invalid-viewer", "无法确认当前标签页的论文编号");
        await scienceDirect.begin({
          candidate: m.candidate, folders: m.folders || [], tags: m.tags || [],
          allowLarge: false, library: "papers",
        }, source, m.viewerTabId).catch(() => {
          throw new ConnectorError("viewer-changed", "无法在当前标签页开始收录，请重新打开插件");
        });
        return scienceDirect.resume(m.viewerTabId);
      }
      return save(
        m.candidate,
        m.folders || [],
        m.tags || [],
        !!m.allowLarge,
        m.library,
      );
    })()
      .then(sendResponse)
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          code:
            error instanceof ConnectorError ? error.code : "connector-error",
          error:
            error instanceof ConnectorError
              ? error.message
              : "收录失败，请重新打开插件后重试",
        }),
      );
    return true;
  },
);
