/// <reference types="chrome" />
import { detectPage, withPDFTitle, type Candidate, type Detection } from "./detect";
import { cnkiPageError, ConnectorError, isCNKIURL } from "./download";
import { isScienceDirectPDFLocation, scienceDirectArticleURL, scienceDirectDownloadURL } from "./scienceDirect";
const cleanDate = (value: unknown) => {
  const match = String(value || "").match(
    /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?/,
  );
  return match
    ? [match[1], match[2]?.padStart(2, "0"), match[3]?.padStart(2, "0")]
        .filter(Boolean)
        .join("-")
    : "";
};

// Older desktop versions require a nonempty, single-line title on every import.
function importTitle(title: string, url: URL): string {
  return (title.replace(/[\p{Cc}\s]+/gu, " ").trim() ||
    url.pathname.split("/").pop() || url.hostname || "PDF").slice(0, 300);
}

export async function prepareCandidate(
  candidate: Candidate,
): Promise<Candidate> {
  const source = new URL(candidate.sourceUrl);
  const publisherSource = scienceDirectArticleURL(source.href);
  if (publisherSource) {
    let latest: Detection | undefined;
    if (candidate.tabId !== undefined) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: candidate.tabId },
        func: detectPage,
      });
      latest = results[0]?.result as Detection | undefined;
    } else if (candidate.scienceDirectAccess) {
      latest = { kind: "single", items: [candidate] };
    } else {
      // A search result is only a pointer; read its own detail page for the
      // access notice, authoritative citation, and safe article snapshot.
      const response = await fetch(publisherSource, {
        credentials: "include",
        redirect: "error",
      });
      if (!response.ok) throw Error(`ScienceDirect 页面读取失败 (${response.status})；请在浏览器中打开原文后重试`);
      const finalURL = response.url || publisherSource;
      if (scienceDirectArticleURL(finalURL) === publisherSource)
        latest = detectPage(await response.text(), finalURL);
    }
    const article = latest?.kind === "single" ? latest.items[0] : undefined;
    if (!article || scienceDirectArticleURL(article.sourceUrl) !== publisherSource ||
        !article.scienceDirectAccess)
      throw Error("无法确认是这篇 ScienceDirect 论文，请在浏览器中打开原文后重试");
    if (article.scienceDirectAccess === "denied")
      throw new ConnectorError(
        "sciencedirect-access-denied",
        "ScienceDirect 页面未提供本篇 PDF 下载，请在原网页查看全文获取选项",
      );

    const title = importTitle(article.title, source);
    const { scienceDirectPublishedPDF, ...articleData } = article;
    return {
      ...articleData,
      sourceUrl: publisherSource,
      pdfUrl: scienceDirectDownloadURL(publisherSource)!,
      ...(scienceDirectPublishedPDF && isScienceDirectPDFLocation(scienceDirectPublishedPDF, publisherSource)
        ? { scienceDirectPublishedPDF }
        : {}),
      title,
      metadata: {
        ...article.metadata,
        url: publisherSource,
        title,
        date: cleanDate(article.metadata.date),
      },
      ...(candidate.tabId === undefined ? {} : { tabId: candidate.tabId }),
    };
  }
  const arxivPDF = source.hostname === "arxiv.org"
    ? source.pathname.match(/^\/pdf\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z.-]+\/\d{7}(?:v\d+)?)(?:\.pdf)?$/i)?.[1]
    : undefined;
  if (
    arxivPDF ||
    (candidate.pdfUrl === candidate.sourceUrl &&
      (!candidate.snapshot || /\.pdf$/i.test(source.pathname)))
  ) {
    let title = candidate.title.trim();
    if (arxivPDF && (!title || title === "PDF" || title === source.href ||
        /^(?:arxiv:)?(?:\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i.test(title) ||
        title === source.pathname.split("/").pop())) {
      title = `arXiv:${arxivPDF}`;
      try {
        const res = await fetch(`https://arxiv.org/abs/${arxivPDF}`, {
          credentials: "omit",
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const page = new DOMParser().parseFromString(await res.text(), "text/html");
          title = page.querySelector<HTMLMetaElement>('meta[name="citation_title"]')?.content.trim() || title;
        }
      } catch {
        // The identifier is sufficient to import when abstract metadata is unavailable.
      }
    }
    const normalized = withPDFTitle({ ...candidate, pdfUrl: candidate.sourceUrl, title });
    title = importTitle(normalized.title, source);
    return {
      ...normalized,
      snapshot: "",
      title,
      metadata: { ...normalized.metadata, title },
    };
  }
  if (isCNKIURL(candidate.sourceUrl)) {
    if (candidate.tabId !== undefined) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: candidate.tabId },
        func: detectPage,
      });
      const latest = results[0]?.result as Detection | undefined;
      if (
        latest?.kind !== "single" ||
        latest.items[0]?.sourceUrl !== candidate.sourceUrl
      ) {
        throw Error(
          "原论文标签页已切换或无法读取，请返回文章详情页并重新打开插件",
        );
      }
      candidate = { ...latest.items[0], tabId: candidate.tabId };
    } else if (!candidate.snapshot) {
      const result = (await chrome.runtime.sendMessage({
        type: "cnki-page",
        url: candidate.sourceUrl,
        sourceUrl: candidate.referrerUrl || candidate.sourceUrl,
      })) as { ok: boolean; error?: string; html?: string; url?: string };
      if (!result.ok || !result.html || !result.url)
        throw Error(result.error || "无法读取知网详情页");
      const detected = detectPage(result.html, result.url);
      if (detected.kind !== "single") throw Error("请打开知网文章详情页后收录");
      candidate = detected.items[0];
    }
    const issue = cnkiPageError(candidate.snapshot, candidate.sourceUrl);
    if (issue) throw issue;
    if (!candidate.pdfUrl) {
      throw Error(
        candidate.cajUrl
          ? "当前知网页面仅发现 CAJ 下载入口，NeoRead 暂不支持 CAJ；请在网站确认是否提供 PDF"
          : "未识别到知网 PDF 下载入口，请确认文章详情页加载完成后重试，或手动下载 PDF 导入",
      );
    }
  }
  let page: Document;
  if (candidate.snapshot) {
    page = new DOMParser().parseFromString(candidate.snapshot, "text/html");
  } else {
    const response = await fetch(candidate.sourceUrl, {
      credentials: "include",
    });
    if (!response.ok) throw Error(`页面读取失败 (${response.status})`);
    page = new DOMParser().parseFromString(await response.text(), "text/html");
  }
  const meta = (name: string) =>
    (
      page.querySelector(
        `meta[name="${name}"],meta[property="${name}"]`,
      ) as HTMLMetaElement | null
    )?.content?.trim() || "";
  const absolute = (value: string) => {
    if (!value.trim()) return "";
    try {
      const u = new URL(value, candidate.sourceUrl);
      return ["http:", "https:"].includes(u.protocol) ? u.href : "";
    } catch {
      return "";
    }
  };
  const arxiv =
    meta("citation_arxiv_id") ||
    (candidate.sourceUrl.includes("arxiv.org")
      ? (candidate.sourceUrl.match(/\/(?:abs|pdf)\/([^/?#]+)/) || [])[1]
      : "") ||
    "";
  let pdf =
    candidate.pdfUrl ||
    absolute(meta("citation_pdf_url")) ||
    absolute(
      (
        page.querySelector(
          'a[href$=".pdf"],a[href*="/pdf/"],link[type="application/pdf"]',
        ) as HTMLAnchorElement | null
      )?.getAttribute("href") || "",
    ) ||
    (arxiv ? `https://arxiv.org/pdf/${arxiv}` : "");
  const title = (meta("citation_title") || candidate.title).slice(0, 300);
  const authors = Array.from(
    page.querySelectorAll<HTMLMetaElement>('meta[name="citation_author"]'),
  )
    .map((a) => ({ name: a.content.trim() }))
    .filter((a) => a.name);
  const rawDOI = String(meta("citation_doi") || candidate.metadata.doi || "")
    .replace(/^doi:/i, "")
    .trim();
  const metadata: Record<string, unknown> = {
    ...candidate.metadata,
    title,
    url: candidate.sourceUrl,
    itemType: arxiv ? "preprint" : candidate.metadata.itemType || "journal",
    date: cleanDate(
      meta("citation_date") ||
        meta("citation_publication_date") ||
        candidate.metadata.date,
    ),
    doi: /^10\.\d{4,9}\/\S+$/.test(rawDOI) ? rawDOI : "",
    arxiv,
    venue: String(
      meta("citation_journal_title") ||
        meta("citation_conference_title") ||
        candidate.metadata.venue ||
        "",
    ).slice(0, 500),
    abstract: String(
      meta("citation_abstract") || candidate.metadata.abstract || "",
    ).slice(0, 20000),
  };
  if (authors.length) metadata.creators = authors;
  if (metadata.doi && !isCNKIURL(candidate.sourceUrl)) {
    try {
      const response = await fetch(
        `https://api.crossref.org/works/${encodeURIComponent(String(metadata.doi))}`,
      );
      if (response.ok) {
        const { message: work } = await response.json();
        if (work && typeof work === "object") {
          if (
            !meta("citation_title") &&
            Array.isArray(work.title) &&
            work.title[0]
          )
            metadata.title = String(work.title[0]).slice(0, 300);
          if (!authors.length && Array.isArray(work.author))
            metadata.creators = work.author
              .map((a: { given?: string; family?: string }) => ({
                name: [a.given, a.family].filter(Boolean).join(" "),
              }))
              .filter((a: { name: string }) => a.name);
          if (!metadata.venue && Array.isArray(work["container-title"]))
            metadata.venue = String(work["container-title"][0] || "").slice(
              0,
              500,
            );
          if (!metadata.date) {
            const parts = work.published?.["date-parts"]?.[0];
            if (Array.isArray(parts))
              metadata.date = cleanDate(parts.join("-"));
          }
          if (!pdf && Array.isArray(work.link)) {
            const link = work.link.find(
              (x: { "content-type"?: string; URL?: string }) =>
                x["content-type"] === "application/pdf",
            );
            pdf = absolute(link?.URL || "");
          }
        }
      }
    } catch {
      /* A DOI lookup is optional when the publisher page already has data. */
    }
  }
  const main = page.querySelector("main,article") || page.body;
  let snapshot = main?.outerHTML || "";
  const snapshotWarnings: string[] = [];
  // Embed images within the snapshot size budget for offline reading.
  const clone = main?.cloneNode(true) as Element | undefined;
  if (clone) {
    clone
      .querySelectorAll(
        "script,style,iframe,object,embed,form,svg,template,noscript",
      )
      .forEach((node) => node.remove());
    let omittedImages = 0;
    for (const img of Array.from(
      clone.querySelectorAll<HTMLImageElement>("img"),
    )) {
      try {
        const src = absolute(
          img.getAttribute("src") || img.getAttribute("data-src") || "",
        );
        if (!src) {
          omittedImages++;
          img.removeAttribute("src");
          continue;
        }
        const response = await fetch(src, { credentials: "include" });
        if (!response.ok) throw Error("image fetch failed");
        const blob = await response.blob();
        if (
          !blob.type.match(/^image\/(png|jpeg|webp|gif)$/) ||
          blob.size > 2_000_000
        )
          throw Error("image too large or unsupported");
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        if (
          new TextEncoder().encode(clone.outerHTML).length + data.length >
          10 * 1024 * 1024
        )
          throw Error("snapshot size limit");
        img.src = data;
      } catch {
        omittedImages++;
        img.removeAttribute("src");
      }
    }
    if (omittedImages)
      snapshotWarnings.push(`${omittedImages} 张图片未能离线保存`);
    snapshot = clone.outerHTML;
  }
  if (new TextEncoder().encode(snapshot).length > 10 * 1024 * 1024) {
    snapshot = "";
    snapshotWarnings.push("网页快照超过 10 MB，未保存快照");
  }
  metadata.title = importTitle(String(metadata.title || ""), source);
  return {
    ...candidate,
    title: String(metadata.title),
    pdfUrl: pdf,
    metadata,
    snapshot,
    snapshotWarnings,
  };
}
