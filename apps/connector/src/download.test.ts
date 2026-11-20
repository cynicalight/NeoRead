import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cnkiPageError,
  downloadPDF,
  isCNKIURL,
  readCNKIPage,
} from "./download";
import type { Candidate } from "./detect";
const sourceUrl = "https://kns.cnki.net/kcms2/article/abstract?v=sample";
const candidate: Candidate = {
  title: "论文",
  sourceUrl,
  pdfUrl: "https://kns.cnki.net/download?id=sample",
  metadata: {},
  snapshot: "",
};
let rules: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  rules = vi.fn().mockResolvedValue(undefined);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "neoread-extension",
      getPlatformInfo: vi.fn().mockResolvedValue({}),
    },
    declarativeNetRequest: {
      updateSessionRules: rules,
      RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      HeaderOperation: { SET: "set" },
      ResourceType: { XMLHTTPREQUEST: "xmlhttprequest" },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("downloads with browser credentials and a temporary origin-scoped Referer rule", async () => {
  fetchMock.mockResolvedValue(new Response("%PDF-1.7\nexample"));
  expect(await (await downloadPDF(candidate)).text()).toBe("%PDF-1.7\nexample");
  expect(fetchMock).toHaveBeenCalledWith(
    candidate.pdfUrl,
    expect.objectContaining({ credentials: "include", redirect: "follow" }),
  );
  expect(rules.mock.calls[0][0].addRules[0]).toMatchObject({
    action: {
      requestHeaders: [
        { header: "Referer", operation: "set", value: sourceUrl },
      ],
    },
    condition: {
      initiatorDomains: ["neoread-extension"],
      urlFilter: "|https://kns.cnki.net/",
      resourceTypes: ["xmlhttprequest"],
    },
  });
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
});
it("rejects HTTP 200 verification HTML instead of uploading it as a PDF", async () => {
  fetchMock.mockResolvedValue(
    new Response(
      '<html><title>安全验证</title><script src="/verify/js/app.js"></script></html>',
      { headers: { "content-type": "text/html" } },
    ),
  );
  await expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "cnki-verification",
  });
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
});
it.each([
  ["<title>用户登录</title>", "cnki-login"],
  ["<p>没有该文献的下载权限</p>", "cnki-access-denied"],
  ["<p>未说明原因的页面</p>", "pdf-invalid-response"],
])("classifies explicit non-PDF evidence: %s", async (html, code) => {
  fetchMock.mockResolvedValue(new Response(html));
  await expect(downloadPDF(candidate)).rejects.toMatchObject({ code });
});
it("does not infer a subscription failure from HTTP 403 alone", async () => {
  fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));
  await expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "pdf-http",
    message: "PDF 下载失败 (403)",
  });
});
it("ignores permission/login words in an article's abstract or ordinary login button", () => {
  expect(
    cnkiPageError(
      '<title>论文详情</title><div class="wx-tit">研究</div><p>没有下载权限的用户</p><button>登录</button>',
      sourceUrl,
    ),
  ).toBeUndefined();
});
it("distinguishes a CAJ-only page before making any download", async () => {
  await expect(
    downloadPDF({
      ...candidate,
      pdfUrl: "",
      cajUrl: "https://kns.cnki.net/caj",
    }),
  ).rejects.toMatchObject({ code: "cnki-caj-only" });
  expect(fetchMock).not.toHaveBeenCalled();
});
it("detects CAJ responses even when the selected button claimed PDF", async () => {
  fetchMock.mockResolvedValue(
    new Response("CAJ", {
      headers: { "content-disposition": 'attachment; filename="paper.caj"' },
    }),
  );
  await expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "cnki-caj-response",
  });
});
it("cleans up on a network failure and allows a subsequent request", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("network"));
  await expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "cnki-request-failed",
  });
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
  fetchMock.mockResolvedValueOnce(new Response("%PDF-1.7"));
  await expect(downloadPDF(candidate)).resolves.toBeInstanceOf(Blob);
});
it("serializes simultaneous downloads so article Referers cannot overwrite one another", async () => {
  let release!: (response: Response) => void;
  fetchMock
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(new Response("%PDF-2"));
  const first = downloadPDF(candidate);
  const second = downloadPDF({ ...candidate, sourceUrl: sourceUrl + "2" });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(rules.mock.calls.filter(([change]) => change.addRules)).toHaveLength(
    1,
  );
  release(new Response("%PDF-1"));
  await Promise.all([first, second]);
  const additions = rules.mock.calls.filter(([change]) => change.addRules);
  expect(additions[1][0].addRules[0].action.requestHeaders[0].value).toBe(
    sourceUrl + "2",
  );
});
it("aborts a stalled CNKI request and removes its rule", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  const result = expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "cnki-timeout",
  });
  await vi.advanceTimersByTimeAsync(25_000);
  await result;
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects oversized downloads before buffering the response", async () => {
  fetchMock.mockResolvedValue(
    new Response("%PDF-", {
      headers: { "content-length": String(513 * 1024 * 1024) },
    }),
  );
  await expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "download-too-large",
  });
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
});
it("loads result-page details through the same authenticated request path", async () => {
  fetchMock.mockResolvedValue(
    new Response('<div class="wx-tit"><h1>论文</h1></div>'),
  );
  await expect(
    readCNKIPage(sourceUrl, "https://kns.cnki.net/kns8s/defaultresult/"),
  ).resolves.toMatchObject({ url: sourceUrl });
  expect(
    rules.mock.calls[0][0].addRules[0].action.requestHeaders[0].value,
  ).toBe("https://kns.cnki.net/kns8s/defaultresult/");
});
it("does not install CNKI rules for ordinary publishers or external attachment hosts", async () => {
  fetchMock.mockResolvedValue(new Response("%PDF-1.7"));
  await downloadPDF({
    ...candidate,
    sourceUrl: "https://example.org/article",
    pdfUrl: "https://example.org/file.pdf",
  });
  expect(rules).not.toHaveBeenCalled();
});
it("rejects lookalikes, credentials and protocol downgrades", async () => {
  for (const url of [
    "https://cnki.net.example.org/",
    "https://evilcnki.net/",
    "https://cnki.net@evil.org/",
    "javascript:alert(1)",
    "https://user:password@kns.cnki.net/",
  ])
    expect(isCNKIURL(url)).toBe(false);
  await expect(
    readCNKIPage("https://cnki.net.example.org/", sourceUrl),
  ).rejects.toMatchObject({ code: "cnki-invalid-url" });
  await expect(
    downloadPDF({ ...candidate, pdfUrl: "http://kns.cnki.net/download" }),
  ).rejects.toMatchObject({ code: "cnki-insecure-download" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(["验证码识别研究", "单点登录研究", "安全验证机制分析"])(
  "does not mistake a paper titled %s for an access challenge",
  (title) => {
    expect(
      cnkiPageError(
        `<title>${title} - 中国知网</title><div class="wx-tit"><h1>${title}</h1></div>`,
        sourceUrl,
      ),
    ).toBeUndefined();
  },
);

const scienceDirectArticle = "https://www.sciencedirect.com/science/article/pii/S2352711024000111";
const scienceDirectPDF = `${scienceDirectArticle}/pdfft?download=true`;
const otherScienceDirectPDF = scienceDirectPDF.replace("S2352711024000111", "S2352711024000222");
const scienceDirectCDN = "https://pdf.sciencedirectassets.com/271730/1-s2.0-S2352711024X00022/1-s2.0-S2352711024000111/main.pdf";
const scienceDirectCandidate: Candidate = {
  title: "Example ScienceDirect paper",
  sourceUrl: scienceDirectArticle,
  pdfUrl: scienceDirectPDF,
  metadata: {},
  snapshot: "",
};

it("makes an ordinary PDF request and gives a browser-required hint for a publisher 403", async () => {
  fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({
    code: "sciencedirect-browser-required",
    message: expect.stringContaining("请在浏览器中打开原文"),
  });
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(scienceDirectPDF, {
    credentials: "include",
    redirect: "follow",
    cache: "no-store",
  });
  expect(rules).not.toHaveBeenCalled();
});

it("identifies explicit verification in the HTML returned from this article's PDF endpoint", async () => {
  fetchMock.mockResolvedValue(new Response(
    "<!doctype html><title>Just a moment...</title><div id='challenge-stage'></div>",
    { headers: { "content-type": "text/html; charset=utf-8" } },
  ));
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({
    code: "sciencedirect-browser-required",
  });
});

it.each([401, 404, 429, 500])("does not classify publisher HTTP %d as browser verification", async (status) => {
  fetchMock.mockResolvedValue(new Response("<title>Just a moment...</title>", {
    status,
    headers: { "content-type": "text/html" },
  }));
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({ code: "pdf-http" });
});

it.each([
  "<title>ScienceDirect Login</title><p>Sign in</p>",
  "<title>A paper about browser verification</title><p>Just a moment...</p>",
  `<script>const bogus = '<meta http-equiv="refresh" content="0; url=${scienceDirectCDN}">';</script>`,
  `<!-- <meta http-equiv="refresh" content="0; url=${scienceDirectCDN}"> -->`,
  `<template><p id="redirect-message"><a href="${scienceDirectCDN}">Download</a></p></template>`,
  `<p><a href="${scienceDirectCDN}">Ordinary attachment link</a></p>`,
  `<title>Just a moment...</title><p id="redirect-message"><a href="${scienceDirectCDN}">Continue</a></p>`,
  `<div id="challenge-form"></div><meta http-equiv="refresh" content="0; url=${scienceDirectCDN}">`,
  `<script src="/cdn-cgi/challenge-platform/example.js"></script><meta http-equiv="refresh" content="0; url=${scienceDirectCDN}">`,
  `<div class="accessContent">Get Full Text Elsewhere</div><meta http-equiv="refresh" content="0; url=${scienceDirectCDN}">`,
  `<meta http-equiv="refresh" content="0; url=${scienceDirectPDF}#self">`,
  `<meta http-equiv="refresh" content="0; url=${otherScienceDirectPDF}">`,
  `<meta http-equiv="refresh" content="0; url=${scienceDirectCDN.replace("S2352711024000111", "S2352711024000222")}">`,
  `<meta http-equiv="refresh" content="0; url=${scienceDirectCDN.replace("https:", "http:")}">`,
  `<meta http-equiv="refresh" content="0; url=${scienceDirectCDN.replace("://", "://user@")}">`,
  `<meta http-equiv="refresh" content="0; url=https://www.sciencedirect.com/science/search?q=article">`,
  `<meta http-equiv="refresh" content="0; url=${scienceDirectPDF}&amp;__cf_chl_tk=temporary">`,
  '<p id="redirect-message"><a href="https://example.org/document.pdf">Continue</a></p>',
])("offers the official page without following links or inferring verification from HTML: %s", async (html) => {
  fetchMock.mockResolvedValue(new Response(html, { headers: { "content-type": "text/html" } }));
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({ code: "sciencedirect-browser-required" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  [
    `<meta content="0; URL='${scienceDirectCDN}?download=1&amp;attachment=pdf'" http-equiv="Refresh">`,
    `${scienceDirectCDN}?download=1&attachment=pdf`,
  ],
  [`<p id='redirect-message'><a href='${scienceDirectCDN}'>Download</a></p>`, scienceDirectCDN],
])("downloads the official PDF reached by a single static publisher link: %s", async (html, finalPDF) => {
  fetchMock
    .mockResolvedValueOnce(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }))
    .mockResolvedValueOnce(new Response("%PDF-1.7\nthis article"));
  expect(await (await downloadPDF(scienceDirectCandidate)).text()).toBe("%PDF-1.7\nthis article");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenNthCalledWith(2, finalPDF, {
    credentials: "include",
    redirect: "error",
    cache: "no-store",
  });
});

it("uses a distinct published download link in memory and resolves a relative link against the actual response", async () => {
  const publishedPDF = `${scienceDirectArticle}/pdfft?md5=publisher-signature&pid=published-paper`;
  const responseURL = scienceDirectPDF.replace("www.sciencedirect.com", "sciencedirect.com");
  const finalPDF = new URL("?download=true&attachment=pdf", responseURL).href;
  const intermediate = new Response(
    '<base href="https://example.org"><div id="redirect-message"><span><a href="?download=true&amp;attachment=pdf">PDF</a></span></div>',
    { headers: { "content-type": "text/html" } },
  );
  Object.defineProperty(intermediate, "url", { value: responseURL });
  fetchMock
    .mockResolvedValueOnce(intermediate)
    .mockResolvedValueOnce(new Response("%PDF-1.7\nthis article"));
  await expect(downloadPDF({ ...scienceDirectCandidate, scienceDirectPublishedPDF: publishedPDF }))
    .resolves.toBeInstanceOf(Blob);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([publishedPDF, finalPDF]);
});

it("never follows a second static PDF link", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(`<meta http-equiv="refresh" content="0;URL=${scienceDirectCDN}">`, {
      headers: { "content-type": "text/html" },
    }))
    .mockResolvedValueOnce(new Response(`<div id="redirect-message"><a href="${scienceDirectCDN}?download=1">PDF</a></div>`, {
      headers: { "content-type": "text/html" },
    }));
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({ code: "sciencedirect-browser-required" });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([scienceDirectPDF, scienceDirectCDN]);
});

it("keeps a failed final static request recoverable without exposing its address", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(`<meta http-equiv="refresh" content="0;URL=${scienceDirectCDN}">`, {
      headers: { "content-type": "text/html" },
    }))
    .mockRejectedValueOnce(new TypeError(`redirected: ${scienceDirectCDN}`));
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({
    code: "sciencedirect-browser-required",
    message: expect.not.stringContaining(scienceDirectCDN),
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("bounds the publisher HTML read before attempting to resolve an intermediate link", async () => {
  fetchMock.mockResolvedValue(new Response(`<meta http-equiv="refresh" content="0;URL=${scienceDirectCDN}">`, {
    headers: { "content-type": "text/html", "content-length": String(1024 * 1024 + 1) },
  }));
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({ code: "sciencedirect-browser-required" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("ignores an invalid optional published link and uses the canonical request", async () => {
  fetchMock.mockResolvedValue(new Response("%PDF-1.7\nexample"));
  await expect(downloadPDF({ ...scienceDirectCandidate, scienceDirectPublishedPDF: otherScienceDirectPDF }))
    .resolves.toBeInstanceOf(Blob);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(scienceDirectPDF, expect.anything());
});

it("does not resolve a static link when re-fetching the already visible PDF", async () => {
  fetchMock.mockResolvedValue(new Response(`<meta http-equiv="refresh" content="0;URL=${scienceDirectCDN}">`, {
    headers: { "content-type": "text/html" },
  }));
  await expect(downloadPDF(scienceDirectCandidate, { visibleScienceDirectPDF: true }))
    .rejects.toMatchObject({ code: "sciencedirect-browser-required" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("rejects a request or a successful PDF redirect to a different article", async () => {
  await expect(downloadPDF({ ...scienceDirectCandidate, pdfUrl: otherScienceDirectPDF }))
    .rejects.toMatchObject({ code: "pdf-invalid-response" });
  expect(fetchMock).not.toHaveBeenCalled();

  const response = new Response("%PDF-1.7\nexample");
  Object.defineProperty(response, "url", { value: otherScienceDirectPDF });
  fetchMock.mockResolvedValue(response);
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({ code: "pdf-invalid-response" });
});

it.each([otherScienceDirectPDF, "https://example.org/document.pdf"])(
  "does not create a browser-required action for a 403 redirected to %s",
  async (finalURL) => {
    const response = new Response("Forbidden", { status: 403 });
    Object.defineProperty(response, "url", { value: finalURL });
    fetchMock.mockResolvedValue(response);
    await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({ code: "pdf-http" });
  },
);

it("does not apply ScienceDirect classification to a 403 from another publisher", async () => {
  fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));
  await expect(downloadPDF({
    ...scienceDirectCandidate,
    sourceUrl: "https://example.org/article",
    pdfUrl: "https://example.org/article.pdf",
  })).rejects.toMatchObject({ code: "pdf-http" });
});

it("uses the already visible same-article PDF URL without following redirects on resume", async () => {
  fetchMock.mockResolvedValue(new Response("%PDF-1.7\nexample"));
  const signal = new AbortController().signal;
  const pdf = await downloadPDF(
    { ...scienceDirectCandidate, pdfUrl: scienceDirectCDN },
    { visibleScienceDirectPDF: true, signal },
  );
  expect(await pdf.text()).toBe("%PDF-1.7\nexample");
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(scienceDirectCDN, {
    credentials: "include",
    redirect: "error",
    cache: "no-store",
    signal,
  });
});

it.each([
  `${scienceDirectPDF}&__cf_chl_rt_tk=temporary`,
  `${scienceDirectArticle}?__cf_chl_tk=temporary`,
  "https://www.sciencedirect.com/cdn-cgi/challenge-platform/navigation",
])("keeps an official verification destination out of PDF data: %s", async (finalURL) => {
  const rejected = new Response("Forbidden", { status: 403 });
  Object.defineProperty(rejected, "url", { value: finalURL });
  const verification = new Response("<html><title>Just a moment...</title></html>");
  Object.defineProperty(verification, "url", { value: finalURL });
  const incorrectPDF = new Response("%PDF-1.7\nnot an accepted location");
  Object.defineProperty(incorrectPDF, "url", { value: finalURL });
  fetchMock
    .mockResolvedValueOnce(rejected)
    .mockResolvedValueOnce(verification)
    .mockResolvedValueOnce(incorrectPDF);
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({
    code: "sciencedirect-browser-required",
    message: expect.not.stringContaining(finalURL),
  });
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({
    code: "sciencedirect-browser-required",
    message: expect.not.stringContaining(finalURL),
  });
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({
    code: "pdf-invalid-response",
  });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
    [scienceDirectPDF, scienceDirectPDF, scienceDirectPDF],
  );
});

it.each([
  `${otherScienceDirectPDF}&__cf_chl_tk=temporary`,
  "https://example.org/cdn-cgi/challenge-platform/navigation",
])("does not classify an unrelated verification-looking URL: %s", async (finalURL) => {
  const response = new Response("<html><title>Just a moment...</title></html>");
  Object.defineProperty(response, "url", { value: finalURL });
  fetchMock.mockResolvedValue(response);
  await expect(downloadPDF(scienceDirectCandidate)).rejects.toMatchObject({ code: "pdf-invalid-response" });
});
