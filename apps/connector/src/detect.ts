export type Candidate = {
  title: string;
  sourceUrl: string;
  pdfUrl: string;
  metadata: Record<string, unknown>;
  snapshot: string;
  snapshotWarnings?: string[];
  cajUrl?: string;
  tabId?: number;
  referrerUrl?: string;
};
export type Detection = { items: Candidate[]; kind: "single" | "list" };

export function withPDFTitle(candidate: Candidate): Candidate {
  if (
    candidate.sourceUrl !== candidate.pdfUrl ||
    !candidate.title.includes("：") ||
    !/[A-Za-z]/.test(candidate.title) ||
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      candidate.title,
    )
  )
    return candidate;
  const title = candidate.title
    .replace(/：(?=[A-Za-z])/g, ": ")
    .replace(/：/g, ":");
  return { ...candidate, title, metadata: { ...candidate.metadata, title } };
}

export function pdfTabCandidate(url: string, title: string): Candidate {
  return withPDFTitle({
    title,
    sourceUrl: url,
    pdfUrl: url,
    metadata: { title, url, itemType: "journal" },
    snapshot: "",
  });
}

// Self-contained so Chrome can serialize this function for activeTab injection.
export function detectPage(html?: string, url?: string): Detection {
  const page =
    html === undefined
      ? document
      : new DOMParser().parseFromString(html, "text/html");
  const pageURL = new URL(url || location.href);
  const meta = (name: string) =>
    (
      page.querySelector(
        `meta[name="${name}"],meta[property="${name}"]`,
      ) as HTMLMetaElement | null
    )?.content?.trim() || "";
  const absolute = (value: string) => {
    if (!value.trim()) return "";
    try {
      const u = new URL(value, pageURL.href);
      return ["https:", "http:"].includes(u.protocol) ? u.href : "";
    } catch {
      return "";
    }
  };
  const text = (value: string) => value.replace(/\s+/g, " ").trim();
  const authors = Array.from(
    page.querySelectorAll<HTMLMetaElement>('meta[name="citation_author"]'),
  )
    .map((x) => ({ name: text(x.content) }))
    .filter((x) => x.name);
  const doi =
    meta("citation_doi") ||
    meta("dc.identifier") ||
    (pageURL.href.match(/10\.\d{4,9}\/[^\s?#]+/) || [])[0] ||
    "";
  const arxiv =
    meta("citation_arxiv_id") ||
    (pageURL.hostname.endsWith("arxiv.org")
      ? (pageURL.pathname.match(/\/(?:abs|pdf|html)\/([^/?#]+)/) || [])[1]
      : "") ||
    "";
  let pdf = absolute(meta("citation_pdf_url"));
  if (!pdf && arxiv) pdf = `https://arxiv.org/pdf/${arxiv}`;
  if (!pdf)
    pdf = absolute(
      (
        page.querySelector(
          'link[type="application/pdf"],a[type="application/pdf"],a[href$=".pdf"],a[href*="/pdf/"]',
        ) as HTMLLinkElement | HTMLAnchorElement | null
      )?.getAttribute("href") || "",
    );
  const isPDF =
    pageURL.pathname.toLowerCase().endsWith(".pdf") ||
    page.contentType === "application/pdf";
  if (isPDF) pdf = pageURL.href;
  let title =
    meta("citation_title") ||
    meta("dc.title") ||
    meta("og:title") ||
    page.title;
  let abstract =
    meta("citation_abstract") || meta("dc.description") || meta("description");
  let date =
    meta("citation_date") ||
    meta("citation_publication_date") ||
    meta("datePublished");
  let venue =
    meta("citation_journal_title") || meta("citation_conference_title");
  for (const script of page.querySelectorAll<HTMLScriptElement>(
    'script[type="application/ld+json"]',
  )) {
    try {
      const raw = JSON.parse(script.textContent || "null");
      const entries = Array.isArray(raw) ? raw : [raw];
      for (const entry of entries) {
        const item =
          entry?.["@graph"]?.find?.((x: Record<string, unknown>) =>
            /Article|ScholarlyArticle/.test(String(x["@type"])),
          ) || entry;
        if (!item || !/Article|ScholarlyArticle/.test(String(item["@type"])))
          continue;
        title = meta("citation_title") || item.headline || item.name || title;
        abstract = abstract || item.description || "";
        date = date || item.datePublished || "";
        venue = venue || item.isPartOf?.name || "";
        if (!pdf)
          pdf = absolute(
            item.encoding?.contentUrl || item.associatedMedia?.contentUrl || "",
          );
        break;
      }
    } catch {
      /* malformed site metadata */
    }
  }
  const metadata: Record<string, unknown> = {
    title: text(String(title)).slice(0, 300),
    itemType: arxiv ? "preprint" : "journal",
    creators: authors,
    date: String(date).slice(0, 10),
    venue: text(String(venue)).slice(0, 200),
    doi: doi.replace(/^doi:/i, ""),
    arxiv,
    url: pageURL.href,
    abstract: text(String(abstract)).slice(0, 20000),
  };
  const cnki =
    pageURL.hostname === "cnki.net" || pageURL.hostname.endsWith(".cnki.net");
  let cajUrl = "";
  if (cnki && !isPDF) {
    // Site-specific download controls may point to endpoints without a file extension.
    const link = (selector: string) => {
      for (const node of page.querySelectorAll(selector)) {
        const href = absolute(node.getAttribute("href") || "");
        if (href) return href;
      }
      return "";
    };
    const parts = Array.from(page.querySelectorAll("#DownLoadParts a"));
    pdf =
      link('.btn-dlpdf > a, a[name="pdfDown"]') ||
      absolute(
        parts
          .find((node) => /PDF/i.test(node.textContent || ""))
          ?.getAttribute("href") || "",
      ) ||
      absolute(meta("citation_pdf_url"));
    cajUrl =
      link('.btn-dlcaj > a, a[name="cajDown"], .btn-qwxz > a') ||
      absolute(
        parts
          .find((node) => /CAJ/i.test(node.textContent || ""))
          ?.getAttribute("href") || "",
      );
    const cleanNode = (node: Element | null) => {
      const clone = node?.cloneNode(true) as Element | undefined;
      clone
        ?.querySelectorAll("sup, script, style")
        .forEach((el) => el.remove());
      return text(clone?.textContent || "");
    };
    const cnkiTitle = cleanNode(page.querySelector(".wx-tit > h1"));
    if (cnkiTitle) metadata.title = cnkiTitle.slice(0, 300);
    const cnkiAuthors = Array.from(
      page.querySelectorAll("#authorpart > span > a"),
    )
      .map((node) => ({ name: cleanNode(node) }))
      .filter((author) => author.name);
    if (!cnkiAuthors.length) {
      cnkiAuthors.push(
        ...cleanNode(page.querySelector("#authorpart"))
          .split(/[,，;；]/)
          .map((name) => ({ name: name.trim() }))
          .filter((author) => author.name),
      );
    }
    if (cnkiAuthors.length) metadata.creators = cnkiAuthors;
    const abstractText = cleanNode(
      page.querySelector(".abstract-text, #ChDivSummary"),
    );
    if (abstractText) metadata.abstract = abstractText.slice(0, 20000);
    const dbcode = (
      page.querySelector<HTMLInputElement>("#paramdbcode")?.value ||
      pageURL.searchParams.get("dbcode") ||
      page.querySelector<HTMLInputElement>("#paramdbname")?.value ||
      ""
    ).toUpperCase();
    metadata.itemType = /^(CMFD|CDFD|CDMH|CLKM)/.test(dbcode)
      ? "thesis"
      : /^(CPFD|IPFD)/.test(dbcode)
        ? "conference"
        : "journal";
    const publication = cleanNode(page.querySelector(".top-tip"));
    const publicationMatch = publication.match(
      /^(.+?)\.\s*(\d{4})(?:\s*,\s*(\d+))?(?:\s*\((\d+)\))?(?:\s*:\s*([\d,\s-]+))?/,
    );
    if (publicationMatch) {
      metadata.venue = publicationMatch[1].trim();
      metadata.date = publicationMatch[2];
      if (publicationMatch[3]) metadata.volume = publicationMatch[3];
      if (publicationMatch[4]) metadata.issue = publicationMatch[4];
      if (publicationMatch[5]) metadata.pages = publicationMatch[5].trim();
    }
    const thesisDate = cleanNode(page.querySelector("#ndate")).match(
      /\d{4}(?:[-/]\d{1,2}(?:[-/]\d{1,2})?)?/,
    );
    if (metadata.itemType === "thesis" && thesisDate)
      metadata.date = thesisDate[0];
    if (!metadata.doi) {
      for (const label of page.querySelectorAll('[class^="rowtit"]')) {
        if (text(label.textContent || "").replace(/[：:]/g, "") !== "DOI")
          continue;
        metadata.doi =
          (label.parentElement?.textContent?.match(/10\.\d{4,9}\/[^\s]+/) ||
            [])[0] || "";
        break;
      }
    }
  }
  const single: Candidate = {
    title: String(metadata.title),
    sourceUrl: pageURL.href,
    pdfUrl: pdf,
    ...(cajUrl ? { cajUrl } : {}),
    metadata,
    snapshot:
      (cnki ? page.documentElement.outerHTML : "") ||
      page.querySelector("main,article")?.outerHTML ||
      page.body?.outerHTML ||
      "",
  };
  const host = pageURL.hostname;
  const cards: Element[] = cnki
    ? Array.from(
        page.querySelectorAll(
          ".result-table-list > tbody > tr, .GridTableContent > tbody > tr",
        ),
      )
    : host.includes("scholar.google.")
      ? Array.from(page.querySelectorAll(".gs_r.gs_or"))
      : host.includes("pubmed.ncbi.nlm.nih.gov")
        ? Array.from(page.querySelectorAll(".docsum-content"))
        : host.includes("semanticscholar.org")
          ? Array.from(
              page.querySelectorAll('[data-test-id="paper-row"],.cl-paper-row'),
            )
          : host.includes("arxiv.org")
            ? Array.from(page.querySelectorAll("li.arxiv-result,.arxiv-result"))
            : [];
  const items: Candidate[] = [];
  for (const card of cards.slice(0, 100)) {
    const titleLink = card.querySelector<HTMLAnchorElement>(
      '.name a,a.fz14,h3 a,.docsum-title,a[data-test-id="title-link"],p.title a',
    );
    const arxivTitle = card.querySelector("p.title");
    const arxivLink = card.querySelector<HTMLAnchorElement>(
      'p.list-title a[href*="/abs/"]',
    );
    const sourceUrl = absolute(
      titleLink?.getAttribute("href") || arxivLink?.getAttribute("href") || "",
    );
    const itemTitle = text(
      titleLink?.textContent || arxivTitle?.textContent || "",
    );
    if (!sourceUrl || !itemTitle) continue;
    const pdfLink = card.querySelector<HTMLAnchorElement>(
      'a[href*=".pdf"],a[href*="/pdf/"],a[href*="/pdf?"]',
    );
    items.push({
      title: itemTitle,
      sourceUrl,
      pdfUrl: absolute(pdfLink?.getAttribute("href") || ""),
      metadata: { title: itemTitle, url: sourceUrl, itemType: "journal" },
      snapshot: "",
      ...(cnki ? { referrerUrl: pageURL.href } : {}),
    });
  }
  return items.length
    ? { items, kind: "list" }
    : { items: [single], kind: "single" };
}
