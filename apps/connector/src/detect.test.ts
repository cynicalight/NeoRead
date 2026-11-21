// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { detectPage } from "./detect";
afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("reads Highwire metadata and arXiv PDF on a paper page", () => {
  vi.stubGlobal("location", {
    href: "https://arxiv.org/abs/2501.01234",
    hostname: "arxiv.org",
    pathname: "/abs/2501.01234",
  });
  document.head.innerHTML =
    '<meta name="citation_title" content="Example Paper"><meta name="citation_author" content="Ada Lovelace"><meta name="citation_doi" content="10.1000/example">';
  document.body.innerHTML = "<article><h1>Example Paper</h1></article>";
  const result = detectPage();
  expect(result.kind).toBe("single");
  expect(result.items[0].pdfUrl).toBe("https://arxiv.org/pdf/2501.01234");
  expect(result.items[0].metadata).toMatchObject({
    title: "Example Paper",
    doi: "10.1000/example",
    creators: [{ name: "Ada Lovelace" }],
  });
  expect(result.items[0].snapshot).toContain("<article>");
});
it("offers multiple Scholar results without treating the results page as one paper", () => {
  vi.stubGlobal("location", {
    href: "https://scholar.google.com/scholar?q=test",
    hostname: "scholar.google.com",
    pathname: "/scholar",
  });
  document.body.innerHTML =
    '<div class="gs_r gs_or"><h3><a href="https://example.org/one">Paper One</a></h3><a href="https://example.org/one.pdf">PDF</a></div><div class="gs_r gs_or"><h3><a href="https://example.org/two">Paper Two</a></h3></div>';
  const result = detectPage();
  expect(result.kind).toBe("list");
  expect(result.items).toHaveLength(2);
  expect(result.items[0].pdfUrl).toBe("https://example.org/one.pdf");
  expect(result.items[1].sourceUrl).toBe("https://example.org/two");
});
it("reads arXiv search results with separate title and identifier links", () => {
  vi.stubGlobal("location", {
    href: "https://arxiv.org/search/?query=security",
    hostname: "arxiv.org",
    pathname: "/search/",
  });
  document.body.innerHTML =
    '<li class="arxiv-result"><p class="list-title"><a href="https://arxiv.org/abs/2501.01234">arXiv:2501.01234</a></p><p class="title">Security Paper</p><a href="https://arxiv.org/pdf/2501.01234">pdf</a></li>';
  const result = detectPage();
  expect(result.kind).toBe("list");
  expect(result.items[0]).toMatchObject({
    title: "Security Paper",
    sourceUrl: "https://arxiv.org/abs/2501.01234",
    pdfUrl: "https://arxiv.org/pdf/2501.01234",
  });
});

it("detects CNKI PDF download endpoints without a .pdf suffix", () => {
  vi.stubGlobal("location", {
    href: "https://kns.cnki.net/kcms2/article/abstract?v=sample",
    hostname: "kns.cnki.net",
    pathname: "/kcms2/article/abstract",
  });
  document.body.innerHTML = `<input id="paramdbcode" value="CJFQ"><input id="paramdbname" value="CJFDLAST2026"><input id="paramfilename" value="TEST202601001">
    <div class="wx-tit"><h1>知网论文</h1></div><div id="authorpart"><span><a>张三<sup>1</sup></a></span></div>
    <div class="abstract-text">论文摘要</div><div class="top-tip">测试期刊. 2026,12(01):1-9</div>
    <li class="btn-dlpdf"><a href="/kcms2/download?token=sample">PDF下载</a></li>
    <li class="btn-dlcaj"><a href="/kcms2/download?format=caj">CAJ下载</a></li>`;
  expect(detectPage().items[0]).toMatchObject({
    title: "知网论文",
    pdfUrl: "https://kns.cnki.net/kcms2/download?token=sample",
    metadata: {
      creators: [{ name: "张三" }],
      abstract: "论文摘要",
      venue: "测试期刊",
      date: "2026",
    },
  });
});

it("reads fetched CNKI pages against the response URL rather than the extension URL", () => {
  const result = detectPage(
    '<div class="wx-tit"><h1>旧版论文</h1></div><a name="pdfDown" href="../download?id=1">PDF</a>',
    "https://kns.cnki.net/kcms/detail/detail.aspx?filename=TEST",
  );
  expect(result.items[0].pdfUrl).toBe(
    "https://kns.cnki.net/kcms/download?id=1",
  );
});
it("distinguishes CAJ-only theses and supports thesis PDF sections", () => {
  const html =
    '<input id="paramdbcode" value="CMFD"><div class="wx-tit"><h1>学位论文</h1></div><div id="ndate">2026-10-22</div><div id="DownLoadParts"><a href="/download?format=caj">CAJ</a></div>';
  const result = detectPage(
    html,
    "https://kns.cnki.net/kcms2/article/abstract?v=example",
  );
  expect(result.items[0]).toMatchObject({
    pdfUrl: "",
    cajUrl: "https://kns.cnki.net/download?format=caj",
    metadata: { itemType: "thesis", date: "2026-10-22" },
  });
  expect(
    detectPage(
      html.replace('format=caj">CAJ', 'format=pdf">PDF'),
      "https://kns.cnki.net/kcms2/article/abstract?v=example",
    ).items[0].pdfUrl,
  ).toBe("https://kns.cnki.net/download?format=pdf");
});
it("enumerates CNKI result rows instead of saving a result page as a paper", () => {
  const result = detectPage(
    '<table class="result-table-list"><tbody><tr><td class="name"><a href="/kcms2/article/abstract?v=one">第一篇</a></td></tr><tr><td class="name"><a href="/kcms2/article/abstract?v=two">第二篇</a></td></tr></tbody></table>',
    "https://kns.cnki.net/kns8s/defaultresult/index",
  );
  expect(result.kind).toBe("list");
  expect(result.items.map((item) => item.sourceUrl)).toEqual([
    "https://kns.cnki.net/kcms2/article/abstract?v=one",
    "https://kns.cnki.net/kcms2/article/abstract?v=two",
  ]);
  expect(result.items[0].referrerUrl).toBe(
    "https://kns.cnki.net/kns8s/defaultresult/index",
  );
});
it("does not apply CNKI rules on lookalike hostnames or accept javascript downloads", () => {
  const html =
    '<div class="wx-tit"><h1>论文</h1></div><li class="btn-dlpdf"><a href="javascript:download()">PDF</a></li>';
  expect(
    detectPage(html, "https://kns.cnki.net/kcms2/article/abstract").items[0]
      .pdfUrl,
  ).toBe("");
  expect(
    detectPage(
      html.replace("javascript:download()", "/download"),
      "https://cnki.net.example.com/",
    ).items[0].pdfUrl,
  ).toBe("");
});
it("remains executable after Chrome serializes the injected function", () => {
  const injected = (0, eval)(`(${detectPage.toString()})`) as typeof detectPage;
  expect(
    injected(
      '<li class="btn-dlpdf"><a href="/download?id=1">PDF</a></li>',
      "https://kns.cnki.net/kcms2/article/abstract",
    ).items[0].pdfUrl,
  ).toBe("https://kns.cnki.net/download?id=1");
});

it("does not substitute a related article PDF for a CAJ-only CNKI article", () => {
  const result = detectPage(
    '<div class="wx-tit"><h1>论文</h1></div><li class="btn-dlcaj"><a href="/download?format=caj">CAJ</a></li><aside><a href="https://example.org/other.pdf">相关文献</a></aside>',
    "https://kns.cnki.net/kcms2/article/abstract?v=example",
  );
  expect(result.items[0].pdfUrl).toBe("");
  expect(result.items[0].cajUrl).toBe(
    "https://kns.cnki.net/download?format=caj",
  );
});

const scienceDirectArticle = "https://www.sciencedirect.com/science/article/pii/S2352711024000111";
const otherScienceDirectArticle = "https://www.sciencedirect.com/science/article/pii/S2352711024000222";

it("detects a serializable ScienceDirect result for this PII, not related PDFs or temporary URLs", () => {
  const injected = (0, eval)(`(${detectPage.toString()})`) as typeof detectPage;
  const result = injected(
    `<link rel="canonical" href="${scienceDirectArticle}">
    <meta name="citation_title" content="The actual article">
    <meta name="citation_pdf_url" content="${otherScienceDirectArticle}/pdfft">
    <meta name="citation_author" content="Ada Lovelace">
    <meta name="citation_journal_title" content="Example Journal">
    <meta name="citation_volume" content="34">
    <meta name="citation_firstpage" content="99">
    <meta name="citation_lastpage" content="111">
    <script type="application/ld+json">{"@type":"ScholarlyArticle","name":"Other article","description":"Not this abstract"}</script>
    <article><h1 id="title">The actual article</h1><p>Article text</p>
      <a href="${otherScienceDirectArticle}/pdfft">Related PDF</a>
    </article>`,
    scienceDirectArticle + "?via%3Dihub&__cf_chl_tk=temporary#section",
  );
  expect(result.kind).toBe("single");
  expect(result.items[0]).toMatchObject({
    title: "The actual article",
    sourceUrl: scienceDirectArticle,
    pdfUrl: scienceDirectArticle + "/pdfft?download=true",
    metadata: {
      title: "The actual article",
      url: scienceDirectArticle,
      creators: [{ name: "Ada Lovelace" }],
      venue: "Example Journal",
      volume: "34",
      pages: "99-111",
      abstract: "",
    },
  });
  expect(result.items[0]).not.toHaveProperty("scienceDirectPublishedPDF");
});

it.each([
  `<a id="pdfLink" href="/science/article/pii/S2352711024000111/pdfft?md5=published&amp;pid=paper#viewer">PDF</a>`,
  `<a id="pdfLink" href="#">PDF</a><meta name="citation_pdf_url" content="${scienceDirectArticle}/pdfft?md5=published&amp;pid=paper">`,
  `<div class="PdfEmbed"><object data="${scienceDirectArticle}/pdfft?md5=published&amp;pid=paper"></object></div>`,
  `<div class="PdfDropDownMenu"><a href="${scienceDirectArticle}/pdfft?md5=published&amp;pid=paper">PDF</a></div>`,
  `<a class="pdf-download-btn-link" href="${scienceDirectArticle}/pdfft?md5=published&amp;pid=paper">PDF</a>`,
])("retains a distinct published link only as a transient download hint: %s", (html) => {
  const [article] = detectPage(
    `<meta name="citation_title" content="Paper"><article>${html}<p>Article body</p></article>`,
    scienceDirectArticle,
  ).items;
  expect(article.scienceDirectPublishedPDF).toBe(`${scienceDirectArticle}/pdfft?md5=published&pid=paper`);
  expect(article.pdfUrl).toBe(`${scienceDirectArticle}/pdfft?download=true`);
  expect(article.snapshot).toBe("<article><p>Article body</p></article>");
  expect(JSON.stringify(article.metadata)).not.toContain("md5=");
});

it("selects the current article's View PDF toolbar link, not a recommendation or the guessed endpoint", () => {
  const own = `${scienceDirectArticle}/pdfft?pid=published-attachment`;
  const { items: [paper] } = detectPage(`<meta name="citation_title" content="Paper">
    <a class="accessbar-utility-link" href="${otherScienceDirectArticle}/pdfft?pid=related">View PDF</a>
    <a class="accessbar-utility-link" href="${own}"><span>View&nbsp;PDF</span></a>`, scienceDirectArticle);
  expect(paper.scienceDirectPublishedPDF).toBe(own);
  expect(JSON.stringify([paper.metadata, paper.snapshot])).not.toContain("published-attachment");
});

it.each([
  `${scienceDirectArticle}/pdfft`,
  `${scienceDirectArticle}/pdfft?download=true#viewer`,
  `${scienceDirectArticle}/pdfft?__cf_chl_tk=verification`,
  `${otherScienceDirectArticle}/pdfft?md5=signed`,
  "https://example.org/paper.pdf",
])("uses the canonical link instead of an equivalent or unauthorized publisher href: %s", (href) => {
  const [article] = detectPage(
    `<meta name="citation_title" content="Paper"><a id="pdfLink" href="${href}">PDF</a>`,
    scienceDirectArticle,
  ).items;
  expect(article.pdfUrl).toBe(`${scienceDirectArticle}/pdfft?download=true`);
  expect(article).not.toHaveProperty("scienceDirectPublishedPDF");
});

it("does not offer a PDF when ScienceDirect displays its primary access notice", () => {
  const [article] = detectPage(
    `<meta name="citation_title" content="Article with an access notice">
    <meta name="citation_pdf_url" content="${scienceDirectArticle}/pdfft?md5=published">
    <div id="check-access-popover"><span>Get full text elsewhere</span></div>`,
    scienceDirectArticle,
  ).items;
  expect(article).toMatchObject({ pdfUrl: "", scienceDirectAccess: "denied" });
  expect(article).not.toHaveProperty("scienceDirectPublishedPDF");
});

it("offers only unique, on-site article results on ScienceDirect search pages", () => {
  const result = detectPage(
    `<h2><a class="result-list-title-link" href="/science/article/abs/pii/S2352711024000111?__cf_chl_tk=temporary#abstract">Paper One</a></h2>
    <h2><a class="result-list-title-link" href="${scienceDirectArticle}">Same Paper Again</a></h2>
    <h2><a class="result-list-title-link" href="${otherScienceDirectArticle}">Paper Two</a></h2>
    <h2><a class="result-list-title-link" href="https://www.sciencedirect.com.example.org/science/article/pii/S2352711024000333">Lookalike</a></h2>
    <h2><a class="result-list-title-link" href="${scienceDirectArticle}/pdfft">PDF viewer</a></h2>`,
    "https://www.sciencedirect.com/search?qs=paper#results",
  );
  expect(result.kind).toBe("list");
  expect(result.items.map(({ title, sourceUrl, pdfUrl }) => ({ title, sourceUrl, pdfUrl }))).toEqual([
    { title: "Paper One", sourceUrl: scienceDirectArticle, pdfUrl: "" },
    { title: "Paper Two", sourceUrl: otherScienceDirectArticle, pdfUrl: "" },
  ]);
});

it("does not present ScienceDirect challenge pages or insecure lookalike article locations as papers", () => {
  expect(detectPage(
    '<title>Just a moment...</title><article><h1>Verify you are human</h1></article>',
    `${scienceDirectArticle}?__cf_chl_tk=temporary`,
  ).items).toEqual([]);
  expect(detectPage(
    '<meta name="citation_title" content="Example"><a href="https://example.org/related.pdf">PDF</a>',
    scienceDirectArticle.replace("https:", "http:"),
  ).items).toEqual([]);
});
