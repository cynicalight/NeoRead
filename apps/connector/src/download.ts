/// <reference types="chrome" />
import type { Candidate } from "./detect";
import {
  classifyScienceDirectPDFLocation,
  isScienceDirectPDFLocation,
  scienceDirectArticleURL,
} from "./scienceDirect";

export class ConnectorError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
export function isCNKIURL(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      (url.hostname === "cnki.net" || url.hostname.endsWith(".cnki.net"))
    );
  } catch {
    return false;
  }
}

// Only classify explicit response evidence. A 403 or an arbitrary HTML page is
// insufficient to infer whether the user has purchased access to the article.
export function cnkiPageError(
  html: string,
  url: string,
): ConnectorError | undefined {
  const title = (
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""
  ).replace(/\s+/g, " ");
  // Avoid interpreting article titles/abstracts or hidden login dialogs as errors.
  const article =
    /(?:class=["'][^"']*\bwx-tit\b|name=["']citation_title["'])/i.test(html);
  const path = new URL(url).pathname;
  if (
    (!article && /安全验证|人机验证|验证码|访问验证/.test(title)) ||
    /^\/verify(?:\/|$)/i.test(path) ||
    /<script\b[^>]*src=["'][^"']*\/verify\/js\//i.test(html)
  ) {
    return new ConnectorError(
      "cnki-verification",
      "知网要求安全验证，请在原网页完成验证后重新打开插件重试",
    );
  }
  if (
    (!article && /登录|登陆|\bsign[ -]?in\b/i.test(title)) ||
    /^\/(?:login|signin)(?:[/.]|$)/i.test(path)
  ) {
    return new ConnectorError(
      "cnki-login",
      "知网要求登录，请在原网页登录后重新打开插件重试",
    );
  }
  if (
    !article &&
    /无(?:全文)?下载权限|没有(?:该文献的?)?下载权限|未购买(?:该|此)(?:文献|文章)|不在(?:您|你)的订购范围/.test(
      html,
    )
  ) {
    return new ConnectorError(
      "cnki-access-denied",
      "知网提示当前账号或机构没有该文献的下载权限",
    );
  }
}

const ruleID = 17841;
let requests: Promise<unknown> = Promise.resolve();
export async function clearCNKIRequestRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleID],
  });
}

// Serialize requests so two tabs cannot replace each other's Referer. Session
// rules only affect this extension's XHR/fetch on the target origin, including
// same-origin redirects. Other sites never receive the article URL via this rule.
export function requestCNKI<T>(
  url: string,
  sourceUrl: string,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  if (!isCNKIURL(url) || !isCNKIURL(sourceUrl)) {
    return Promise.reject(
      new ConnectorError(
        "cnki-invalid-url",
        "知网页面地址无效，请重新打开文章详情页",
      ),
    );
  }
  const task = requests.then(async () => {
    const target = new URL(url);
    const referer = new URL(sourceUrl);
    referer.hash = "";
    if (referer.protocol === "https:" && target.protocol !== "https:") {
      throw new ConnectorError(
        "cnki-insecure-download",
        "知网下载地址使用不安全的 HTTP，请在网站打开 HTTPS 下载链接后重试",
      );
    }
    const controller = new AbortController();
    let timeout = setTimeout(() => controller.abort(), 25_000);
    const keepAlive = setInterval(() => {
      void chrome.runtime.getPlatformInfo().catch(() => {});
    }, 20_000);
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleID],
        addRules: [
          {
            id: ruleID,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
              requestHeaders: [
                {
                  header: "Referer",
                  operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                  value: referer.href,
                },
              ],
            },
            condition: {
              initiatorDomains: [chrome.runtime.id],
              urlFilter: `|${target.origin}/`,
              resourceTypes: [
                chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
              ],
            },
          },
        ],
      });
      const response = await fetch(target.href, {
        credentials: "include",
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), 120_000);
      return await read(response);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (controller.signal.aborted)
        throw new ConnectorError("cnki-timeout", "知网请求超时，请稍后重试");
      throw new ConnectorError(
        "cnki-request-failed",
        "无法请求知网，请检查网站访问权限、网络和登录状态后重试",
      );
    } finally {
      clearTimeout(timeout);
      clearInterval(keepAlive);
      await clearCNKIRequestRule();
    }
  });
  requests = task.catch(() => {});
  return task;
}

async function boundedBlob(response: Response, limit: number): Promise<Blob> {
  const tooLarge = () =>
    new ConnectorError(
      "download-too-large",
      limit === 512 * 1024 * 1024
        ? "PDF 超过 NeoRead 的 512 MB 上传限制"
        : "知网页面超过 10 MB，无法读取",
    );
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return new Blob();
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: response.headers.get("content-type") || "" });
}

export async function readCNKIPage(
  url: string,
  sourceUrl: string,
): Promise<{ html: string; url: string }> {
  return requestCNKI(url, sourceUrl, async (response) => {
    const html = await (await boundedBlob(response, 10 * 1024 * 1024)).text();
    const finalURL = response.url || url;
    const issue = cnkiPageError(html, finalURL);
    if (issue) throw issue;
    if (!response.ok)
      throw new ConnectorError(
        "cnki-http",
        `知网页面读取失败 (${response.status})`,
      );
    if (!isCNKIURL(finalURL))
      throw new ConnectorError(
        "cnki-redirect",
        "知网页面已跳转，请在浏览器打开文章详情页后重试",
      );
    return { html, url: finalURL };
  });
}

function scienceDirectBrowserRequired(): ConnectorError {
  return new ConnectorError(
    "sciencedirect-browser-required",
    "ScienceDirect 未直接返回 PDF。请在浏览器中打开原文，通过网站的 PDF 按钮继续；如有验证，请在网页上完成",
  );
}

type DownloadPDFOptions = {
  visibleScienceDirectPDF?: boolean;
  signal?: AbortSignal;
};

export async function downloadPDF(
  candidate: Candidate,
  options: DownloadPDFOptions = {},
): Promise<Blob> {
  const cnki = isCNKIURL(candidate.sourceUrl);
  if (cnki) {
    const issue = cnkiPageError(candidate.snapshot, candidate.sourceUrl);
    if (issue) throw issue;
  }
  const scienceDirect = scienceDirectArticleURL(candidate.sourceUrl) !== null;
  if (scienceDirect && candidate.scienceDirectAccess === "denied")
    throw new ConnectorError(
      "sciencedirect-access-denied",
      "ScienceDirect 页面未提供本篇 PDF 下载，请在原网页查看全文获取选项",
    );
  if (!candidate.pdfUrl) {
    if (cnki && candidate.cajUrl)
      throw new ConnectorError(
        "cnki-caj-only",
        "当前知网页面仅发现 CAJ 下载入口，NeoRead 暂不支持 CAJ；请在网站确认是否提供 PDF",
      );
    throw new ConnectorError(
      "pdf-not-found",
      cnki
        ? "未识别到知网 PDF 下载入口，请打开文章详情页，确认页面加载完成后重试，或手动下载 PDF 导入"
        : "页面没有可下载的 PDF",
    );
  }
  const mismatchedPDF = () => new ConnectorError(
    "pdf-invalid-response",
    "下载地址不是这篇 ScienceDirect 论文的官方 PDF",
  );
  if ((scienceDirect || options.visibleScienceDirectPDF) &&
      !isScienceDirectPDFLocation(candidate.pdfUrl, candidate.sourceUrl))
    throw mismatchedPDF();
  const read = async (response: Response) => {
    const finalURL = response.url || candidate.pdfUrl;
    const location = scienceDirect
      ? classifyScienceDirectPDFLocation(finalURL, candidate.sourceUrl)
      : "pdf";
    const canOpenPublisherPage = scienceDirect && response.status === 200;
    if (scienceDirect && location && response.status === 403) {
      await response.body?.cancel();
      throw scienceDirectBrowserRequired();
    }
    if (!location || (location === "verification" && !canOpenPublisherPage)) {
      await response.body?.cancel();
      throw response.ok
        ? mismatchedPDF()
        : new ConnectorError("pdf-http", `PDF 下载失败 (${response.status})`);
    }
    const blob = await boundedBlob(response, 512 * 1024 * 1024);
    const signature = await blob.slice(0, 5).text();
    if (signature !== "%PDF-") {
      // The destination is validated above. Its HTML, scripts, and links are
      // neither instructions nor evidence of a login problem.
      if (canOpenPublisherPage) throw scienceDirectBrowserRequired();
      if (location !== "pdf") throw mismatchedPDF();
      if (cnki) {
        const issue = cnkiPageError(
          await blob.slice(0, 65536).text(),
          response.url || candidate.pdfUrl,
        );
        if (issue) throw issue;
        if (
          /application\/(?:x-)?caj/i.test(blob.type) ||
          /attachment[^\r\n]*filename[^\r\n]*\.caj/i.test(
            response.headers.get("content-disposition") || "",
          )
        ) {
          throw new ConnectorError(
            "cnki-caj-response",
            "知网返回了 CAJ 文件，NeoRead 暂不支持；请在网站选择 PDF 下载",
          );
        }
      }
      if (!response.ok)
        throw new ConnectorError(
          "pdf-http",
          `PDF 下载失败 (${response.status})`,
        );
      throw new ConnectorError(
        "pdf-invalid-response",
        cnki
          ? "知网下载返回的内容不是 PDF，暂时无法确定原因；请在原网页尝试手动下载"
          : "下载结果不是 PDF；请在原网页确认下载是否需要登录或验证",
      );
    }
    if (location !== "pdf") throw mismatchedPDF();
    if (!response.ok)
      throw new ConnectorError("pdf-http", `PDF 下载失败 (${response.status})`);
    return blob;
  };
  if (cnki && isCNKIURL(candidate.pdfUrl))
    return requestCNKI(candidate.pdfUrl, candidate.sourceUrl, read);
  let response: Response;
  try {
    response = await fetch(candidate.pdfUrl, {
      credentials: "include",
      redirect: options.visibleScienceDirectPDF ? "error" : "follow",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    throw new ConnectorError(
      "pdf-network",
      "无法下载 PDF；请检查站点权限或登录状态",
    );
  }
  return read(response);
}
