const origin = "https://www.sciencedirect.com";
const publisherOrigins = [origin, "https://sciencedirect.com"];
const pdfCDNOrigin = "https://pdf.sciencedirectassets.com";

function httpsURL(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

// Keep the article-path check in sync with the self-contained detectPage.
function articlePII(url: URL | null): string | undefined {
  if (!url || !publisherOrigins.includes(url.origin)) return;
  return url.pathname.match(/^\/science\/article\/(?:abs\/)?pii\/(S[0-9X]{16}|B[0-9X]{19})\/?$/)?.[1];
}

export function scienceDirectArticleURL(sourceUrl: string): string | null {
  const pii = articlePII(httpsURL(sourceUrl));
  return pii ? `${origin}/science/article/pii/${pii}` : null;
}

export function scienceDirectDownloadURL(sourceUrl: string): string | null {
  const article = scienceDirectArticleURL(sourceUrl);
  return article ? `${article}/pdfft?download=true` : null;
}

function hasVerificationQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (/^__cf_chl_/i.test(key)) return true;
  }
  return false;
}

function isPublisherPDFPath(url: URL, pii: string): boolean {
  if (publisherOrigins.includes(url.origin))
    return url.pathname === `/science/article/pii/${pii}/pdfft`;
  if (url.origin !== pdfCDNOrigin) return false;
  const match = url.pathname.match(
    /^\/\d+\/1-s2\.0-(?:S[0-9X]{16}|B[0-9X]{19})\/1-s2\.0-(S[0-9X]{16}|B[0-9X]{19})\/main\.pdf$/,
  );
  return match?.[1] === pii;
}

// A verification location is only useful for classifying a response from an
// already validated PDF request. It must not be returned or used to resume.
export function classifyScienceDirectPDFLocation(
  value: string,
  sourceUrl: string,
): "pdf" | "verification" | null {
  const pii = articlePII(httpsURL(sourceUrl));
  const url = httpsURL(value);
  if (!pii || !url || (!publisherOrigins.includes(url.origin) && url.origin !== pdfCDNOrigin))
    return null;
  if (isPublisherPDFPath(url, pii)) return hasVerificationQuery(url) ? "verification" : "pdf";
  if (/^\/cdn-cgi\/challenge-platform(?:\/|$)/.test(url.pathname) ||
      (articlePII(url) === pii && hasVerificationQuery(url))) return "verification";
  return null;
}

export function isScienceDirectPDFLocation(value: string, sourceUrl: string): boolean {
  return classifyScienceDirectPDFLocation(value, sourceUrl) === "pdf";
}
