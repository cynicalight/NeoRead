import { defaultTreeAdapter, parse, type DefaultTreeAdapterTypes } from "parse5";

const doiOrigin = "https://doi.org";
const kitOrigin = "https://publikationen.bibliothek.kit.edu";
const metadataLimit = 512 * 1024;
const pdfLimit = 50 * 1024 * 1024;
const lookupTimeoutMs = 20_000;

// Only accept credential-free HTTPS URLs with no query or fragment. For KITopen
// file links, resolve relative references against the canonical record URL.
function trustedURL(value: unknown, origin: string, base?: string): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, base);
    return url.origin === origin && url.href === `${origin}${url.pathname}` ? url : null;
  } catch {
    return null;
  }
}

function kitRecordIDs(work: unknown, doi: string): string[] {
  if (!work || typeof work !== "object" || !("doi" in work) ||
      trustedURL(work.doi, doiOrigin)?.pathname.toLowerCase() !== `/${doi}` ||
      !("locations" in work) || !Array.isArray(work.locations)) return [];

  const ids = new Set<string>();
  for (const location of work.locations) {
    if (location?.is_oa !== true) continue;
    const url = trustedURL(location.landing_page_url, doiOrigin);
    const id = url?.pathname.match(/^\/10\.5445\/ir\/([0-9]+)$/i)?.[1];
    if (id) ids.add(id);
    if (ids.size === 4) break;
  }
  return [...ids];
}

function kitPublishedPDF(html: string, id: string, doi: string, recordURL: string): string | null {
  const nodes: DefaultTreeAdapterTypes.ChildNode[] = [...parse(html).childNodes];
  let matchesOriginal = false;
  let pdfURL: string | null = null;
  while (nodes.length) {
    const node = nodes.pop()!;
    if (!defaultTreeAdapter.isElementNode(node) || node.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
        node.attrs.some(({ name }) => name === "hidden")) continue;
    if (node.tagName !== "a") {
      for (const child of node.childNodes) nodes.push(child);
      continue;
    }
    // KITopen uses these two literal link labels. Neither a citation URL nor
    // a separately labelled link can establish the version of this file.
    const [text] = node.childNodes;
    if (node.childNodes.length !== 1 || !text || !defaultTreeAdapter.isTextNode(text)) continue;
    const label = text.value.trim();
    const href = node.attrs.find(({ name }) => name === "href")?.value;
    if (label === "Originalveröffentlichung") {
      if (trustedURL(href, doiOrigin)?.pathname.toLowerCase() !== `/${doi}`) return null;
      matchesOriginal = true;
    } else if (label === "Verlagsausgabe") {
      const url = trustedURL(href, kitOrigin, recordURL);
      const path = url?.pathname.split("/");
      if (!url || path?.length !== 3 || path[1] !== id || !/^[0-9]+$/.test(path[2]) ||
          (pdfURL !== null && pdfURL !== url.href)) return null;
      pdfURL = url.href;
    }
  }
  return matchesOriginal ? pdfURL : null;
}

async function publicBody(url: string, type: string, limit: number, signal: AbortSignal): Promise<Blob | null> {
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    signal,
  });
  const body = response.body;
  if (!body) return null;
  if (response.status !== 200 || response.redirected || (response.url && response.url !== url) ||
      response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== type ||
      Number(response.headers.get("content-length")) > limit) {
    await body.cancel();
    return null;
  }

  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return new Blob(chunks, { type });
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function citationForPII(pii: string, signal: AbortSignal): Promise<{ doi: string; title: string } | null> {
  if (!/^(?:S[0-9X]{16}|B[0-9X]{19})$/.test(pii)) return null;
  const url = new URL("https://api.crossref.org/works");
  url.search = new URLSearchParams({ filter: `alternative-id:${pii}`, rows: "2", select: "DOI,title,alternative-id" }).toString();
  try {
    const data = await publicBody(url.href, "application/json", metadataLimit,
      AbortSignal.any([signal, AbortSignal.timeout(8000)]));
    if (!data) return null;
    const { message } = JSON.parse(await data.text());
    if (message?.["total-results"] !== 1 || message.items?.length !== 1) return null;
    const item = message.items[0];
    if (!Array.isArray(item?.["alternative-id"]) || !item["alternative-id"].includes(pii) ||
        typeof item.DOI !== "string" || !/^10\.\d{4,9}\/\S+$/i.test(item.DOI)) return null;
    const title = item.title?.[0];
    return { doi: item.DOI, title: typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 300) : "" };
  } catch {
    return null;
  }
}

/** Resolve a public publisher-version PDF, never an accepted manuscript. */
export async function findPublishedCopy(doi: string, cancel?: AbortSignal): Promise<{ blob: Blob; url: string } | null> {
  const original = doi.trim().toLowerCase();
  if (original.length > 512 || !/^10\.[0-9]{4,9}\/[a-z0-9._;()+/-]+$/.test(original) ||
      original.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), lookupTimeoutMs);
  const signal = cancel ? AbortSignal.any([cancel, controller.signal]) : controller.signal;
  try {
    const work = await publicBody(
      `https://api.openalex.org/works/${doiOrigin}/${original}?select=doi%2Clocations`,
      "application/json", metadataLimit, signal,
    );
    if (!work) return null;
    for (const id of kitRecordIDs(JSON.parse(await work.text()), original)) {
      if (signal.aborted) return null;
      try {
        const recordURL = `${kitOrigin}/${id}`;
        const record = await publicBody(recordURL, "text/html", metadataLimit, signal);
        if (!record) continue;
        const url = kitPublishedPDF(await record.text(), id, original, recordURL);
        if (!url) continue;
        const blob = await publicBody(url, "application/pdf", pdfLimit, signal);
        if (blob && await blob.slice(0, 5).text() === "%PDF-") return { blob, url };
      } catch {
        // A stale/unavailable public copy doesn't rule out another KITopen record.
      }
    }
  } catch {
    // Failing closed leaves the established publisher flow available.
  } finally {
    clearTimeout(timeout);
  }
  return null;
}
