// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { detectPage, pdfTabCandidate, withPDFTitle } from "./detect";
import { prepareCandidate } from "./prepare";
const url = "https://kns.cnki.net/kcms2/article/abstract?v=example";
const html =
  '<input id="paramdbcode" value="CMFD"><div class="wx-tit"><h1>学位论文</h1></div><div id="authorpart">张三</div><div id="ndate">2026-10-22</div><li class="btn-dlpdf"><a href="/download?id=fresh">PDF</a></li>';
afterEach(() => vi.unstubAllGlobals());
it("refreshes the original tab before saving and preserves thesis metadata", async () => {
  const old = {
    ...detectPage(html.replace("id=fresh", "id=old"), url).items[0],
    tabId: 7,
  };
  const executeScript = vi
    .fn()
    .mockResolvedValue([{ result: detectPage(html, url) }]);
  vi.stubGlobal("chrome", { scripting: { executeScript } });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const result = await prepareCandidate(old);
  expect(result.pdfUrl).toBe("https://kns.cnki.net/download?id=fresh");
  expect(result.metadata).toMatchObject({
    itemType: "thesis",
    title: "学位论文",
    date: "2026-10-22",
    creators: [{ name: "张三" }],
  });
  expect(executeScript).toHaveBeenCalledWith({
    target: { tabId: 7 },
    func: detectPage,
  });
  expect(fetchMock).not.toHaveBeenCalled();
});
it("does not silently save a different article after the tab navigated", async () => {
  vi.stubGlobal("chrome", {
    scripting: {
      executeScript: vi
        .fn()
        .mockResolvedValue([{ result: detectPage(html, url + "changed") }]),
    },
  });
  await expect(
    prepareCandidate({ ...detectPage(html, url).items[0], tabId: 7 }),
  ).rejects.toThrow("原论文标签页已切换");
});
it("loads search selections through the worker and detects their returned detail pages", async () => {
  const sendMessage = vi.fn().mockResolvedValue({ ok: true, html, url });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  const result = await prepareCandidate({
    title: "搜索结果",
    pdfUrl: "",
    sourceUrl: url,
    referrerUrl: "https://kns.cnki.net/kns8s/defaultresult/",
    metadata: {},
    snapshot: "",
  });
  expect(result.pdfUrl).toBe("https://kns.cnki.net/download?id=fresh");
  expect(result.metadata.itemType).toBe("thesis");
  expect(sendMessage).toHaveBeenCalledWith({
    type: "cnki-page",
    url,
    sourceUrl: "https://kns.cnki.net/kns8s/defaultresult/",
  });
});
it("reports a live verification page before generic PDF lookup or snapshot downloads", async () => {
  const item = detectPage(
    '<title>安全验证</title><script src="/verify/js/app.js"></script>',
    url,
  ).items[0];
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(prepareCandidate(item)).rejects.toThrow("知网要求安全验证");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("keeps generic direct PDF imports unchanged", async () => {
  const item = {
    title: "PDF",
    pdfUrl: "https://example.org/paper.pdf",
    sourceUrl: "https://example.org/paper.pdf",
    metadata: {},
    snapshot: "",
  };
  expect(await prepareCandidate(item)).toMatchObject({
    ...item,
    metadata: { title: "PDF" },
  });
});

const paperTitle = "RegionReasoner: Region-Grounded Multi-Round Visual Reasoning";
it.each([
  [paperTitle.replace(":", "："), paperTitle],
  [paperTitle.replace(": ", "："), paperTitle],
  ["RegionReasoner：区域推理", "RegionReasoner：区域推理"],
])("uses the same PDF title in the popup and import: %s", async (input, expected) => {
  const url = "https://arxiv.org/pdf/2602.03733";
  const candidates = [
    pdfTabCandidate(url, input),
    withPDFTitle(detectPage(`<title>${input}</title>`, url).items[0]),
  ];
  for (const candidate of candidates) {
    expect(candidate.title).toBe(expected);
    expect((await prepareCandidate(candidate)).metadata.title).toBe(expected);
  }
});

it("imports a titleless arXiv viewer using the paper's citation title", async () => {
  const url = "https://arxiv.org/pdf/2602.03733";
  const item = detectPage("<body><embed type='application/pdf'></body>", url).items[0];
  const fetchPage = vi.fn().mockResolvedValue(new Response(`<meta name="citation_title" content="${paperTitle}">`));
  vi.stubGlobal("fetch", fetchPage);
  expect(await prepareCandidate(item)).toMatchObject({
    title: paperTitle, pdfUrl: url, metadata: { title: paperTitle },
  });
  expect(fetchPage.mock.calls[0][0]).toBe("https://arxiv.org/abs/2602.03733");
});

it("can still import into older desktops when arXiv metadata is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const url = "https://arxiv.org/pdf/2602.03733v2.pdf?download=1";
  expect(await prepareCandidate(pdfTabCandidate(url, ""))).toMatchObject({
    pdfUrl: url, metadata: { title: "arXiv:2602.03733v2" },
  });
});
