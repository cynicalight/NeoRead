/// <reference types="chrome" />
import type { Candidate } from "./detect";
const bridge = "http://127.0.0.1:17841";
type Result = {
  ok: boolean;
  error?: string;
  code?: string;
  pages?: number;
  warnings?: string[];
  document?: { id: string; title: string };
};
async function save(
  candidate: Candidate,
  folders: string[],
  tags: string[],
  allowLarge = false,
  library: "papers" | "books" = "papers",
): Promise<Result> {
  const { secret } = await chrome.storage.local.get("secret");
  if (!secret) return { ok: false, error: "请先打开 Reader 后重新打开插件" };
  if (!candidate.pdfUrl) return { ok: false, error: "页面没有可下载的 PDF" };
  let pdf: Response;
  try {
    pdf = await fetch(candidate.pdfUrl, {
      credentials: "include",
      redirect: "follow",
    });
  } catch {
    return { ok: false, error: "无法下载 PDF；请检查站点权限或登录状态" };
  }
  if (!pdf.ok) return { ok: false, error: `PDF 下载失败 (${pdf.status})` };
  const declared = Number(pdf.headers.get("content-length") || 0);
  if (declared > 512 * 1024 * 1024)
    return { ok: false, error: "PDF 超过 Reader 的 512 MB 上传限制" };
  const blob = await pdf.blob();
  if (blob.size > 512 * 1024 * 1024)
    return { ok: false, error: "PDF 超过 Reader 的 512 MB 上传限制" };
  const magic = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...magic) !== "%PDF-")
    return { ok: false, error: "下载结果不是 PDF；可能需要在网站登录" };
  const form = new FormData();
  form.append("library", library);
  form.append("pdf", blob, "paper.pdf");
  form.append("metadata", JSON.stringify(candidate.metadata));
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
    });
  } catch {
    return { ok: false, error: "无法连接 Reader，请确认桌面应用正在运行" };
  }
  const data = await response
    .json()
    .catch(() => ({ error: `收录失败 (${response.status})` }));
  return response.ok
    ? { ok: true, document: data.document, warnings: data.warnings }
    : {
        ok: false,
        error: data.error || "收录失败",
        code: data.code,
        pages: data.pages,
      };
}
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    const m = message as {
      type?: string;
      candidate?: Candidate;
      folders?: string[];
      tags?: string[];
      allowLarge?: boolean;
      library?: "papers" | "books";
    };
    if (m?.type !== "save" || !m.candidate) return;
    void save(
      m.candidate,
      m.folders || [],
      m.tags || [],
      !!m.allowLarge,
      m.library,
    )
      .then(sendResponse)
      .catch((error: Error) =>
        sendResponse({ ok: false, error: error.message }),
      );
    return true;
  },
);
