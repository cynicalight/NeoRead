import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { citationForPII, findPublishedCopy } from "./publishedCopy";

const doi = "10.1016/j.surfrep.2025.100669";
const doiURL = `https://doi.org/${doi}`;
const workURL = `https://api.openalex.org/works/${doiURL}?select=doi%2Clocations`;
const kitOrigin = "https://publikationen.bibliothek.kit.edu";
const recordURL = `${kitOrigin}/1000189161`;
const pdfURL = `${recordURL}/171376216`;
const kitLanding = "https://doi.org/10.5445/ir/1000189161";
const original = `<a class="downloadTextLink" href="${doiURL}" rel="noopener">Originalveröffentlichung</a>`;
const published = `<a
  href="${pdfURL}"
  class="downloadTextLink"
  target="_blank"
>
  Verlagsausgabe
</a>`;
const fetchMock = vi.fn<typeof fetch>();

function discovery(landing_page_url = kitLanding, is_oa = true, workDOI = doiURL): Response {
  return Response.json({
    doi: workDOI,
    locations: [
      { is_oa: true, landing_page_url: doiURL, version: "publishedVersion" },
      { is_oa, landing_page_url, version: null },
    ],
  });
}

function record(html = `${original}${published}`): Response {
  return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
}

function pdf(body = "%PDF-1.7\narticle bytes", headers: Record<string, string> = {}): Response {
  return new Response(body, { headers: { "Content-Type": "application/pdf", ...headers } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([[2, "S0167572925000172"], [1, "S0167572925000173"]])(
  "rejects ambiguous or mismatched Crossref identities", async (count, alternativeID) => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: { "total-results": count,
      items: [{ DOI: doi, "alternative-id": [alternativeID], title: ["Paper"] }] } }));
    expect(await citationForPII("S0167572925000172", new AbortController().signal)).toBeNull();
  },
);

it("uses the explicit KITopen publisher-version file even when OpenAlex does not classify its version", async () => {
  fetchMock.mockResolvedValueOnce(discovery()).mockResolvedValueOnce(record()).mockResolvedValueOnce(pdf());

  const result = await findPublishedCopy(doi.toUpperCase());

  expect(result?.url).toBe(pdfURL);
  expect(result?.blob.type).toBe("application/pdf");
  expect(await result?.blob.text()).toBe("%PDF-1.7\narticle bytes");
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([workURL, recordURL, pdfURL]);
  for (const [, options] of fetchMock.mock.calls) {
    expect(options).toEqual({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  }
});

it("uses the returned record and matching numeric file for another DOI", async () => {
  const anotherDOI = "10.1016/j.example.2026.30";
  const anotherDOIURL = `https://doi.org/${anotherDOI}`;
  fetchMock
    .mockResolvedValueOnce(discovery("https://doi.org/10.5445/IR/1234", true, anotherDOIURL))
    .mockResolvedValueOnce(record(`<a href="${anotherDOIURL}">Originalveröffentlichung</a>
      <a href="/1234/8999">Verlagsausgabe</a>`))
    .mockResolvedValueOnce(pdf());

  expect((await findPublishedCopy(anotherDOI))?.url).toBe(`${kitOrigin}/1234/8999`);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    `https://api.openalex.org/works/${anotherDOIURL}?select=doi%2Clocations`,
    `${kitOrigin}/1234`,
    `${kitOrigin}/1234/8999`,
  ]);
});

it.each([
  `${doi}?access_token=private`,
  `${doi}#private`,
  `https://doi.org/${doi}`,
  "10.1016/../private",
])("does not send a non-bare DOI or a path traversal: %s", async (invalidDOI) => {
  expect(await findPublishedCopy(invalidDOI)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  () => discovery(kitLanding, true, `${doiURL}0`),
  () => discovery(kitLanding, false),
  () => discovery(`${kitLanding}?token=private`),
  () => discovery(kitLanding.replace("doi.org", "doi.org.example")),
  () => discovery(kitLanding.replace("doi.org", "secret@doi.org")),
  () => new Response("{", { headers: { "Content-Type": "application/json" } }),
])("ignores untrusted or malformed discovery data", async (work) => {
  fetchMock.mockResolvedValueOnce(work());
  expect(await findPublishedCopy(doi)).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  ["publisher DOI is different", `${original.replace(doiURL, `${doiURL}0`)}${published}`],
  ["only DOI metadata is present", `<meta name="citation_doi" content="${doi}">${published}`],
  ["original DOI links conflict", `${original}${original.replace(doiURL, `${doiURL}0`)}${published}`],
  ["a citation URL points to a manuscript", `${original}<meta name="citation_pdf_url" content="${pdfURL}">
    ${published.replace("Verlagsausgabe", "Akzeptiertes Manuskript")}`],
  ["label is not attached to the file", `${original}<span>Verlagsausgabe</span>
    ${published.replace("Verlagsausgabe", "PDF Download")}`],
  ["publisher markup is inert", `${original}<!--${published}--><script>${published}</script>
    <template>${published}</template><noscript>${published}</noscript><div hidden>${published}</div>`],
  ["the file is on another record", `${original}${published.replace("1000189161", "1000189162")}`],
  ["the file is on a lookalike host", `${original}${published.replace(kitOrigin, `${kitOrigin}.example`)}`],
  ["the file carries URL credentials", `${original}${published.replace("https://", "https://secret@")}`],
  ["the file carries a query", `${original}${published.replace(pdfURL, `${pdfURL}?token=private`)}`],
  ["different files have the same label", `${original}${published}${published.replace("171376216", "99999")}`],
])("rejects the KITopen attachment when %s", async (_reason, html) => {
  fetchMock.mockResolvedValueOnce(discovery()).mockResolvedValueOnce(record(html));
  expect(await findPublishedCopy(doi)).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([
  () => pdf("<html>Verification</html>"),
  () => new Response("%PDF-1.7", { status: 206, headers: { "Content-Type": "application/pdf" } }),
  () => new Response(null, { status: 302, headers: { Location: "https://example.com/pdf" } }),
  () => Object.defineProperty(pdf(), "url", { value: `${recordURL}/9999` }),
  () => pdf("%PDF-1.7", { "Content-Length": `${50 * 1024 * 1024 + 1}` }),
])("does not return an invalid, redirected, partial or oversized PDF", async (file) => {
  fetchMock.mockResolvedValueOnce(discovery()).mockResolvedValueOnce(record()).mockResolvedValueOnce(file());
  expect(await findPublishedCopy(doi)).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("cancels an oversized metadata stream even with no declared length", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new Uint8Array(512 * 1024 + 1)),
    cancel,
  });
  fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "application/json" } }));
  expect(await findPublishedCopy(doi)).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});

it("aborts stalled body reads within the lookup deadline", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementationOnce(async (_url, options) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        options?.signal?.addEventListener("abort", () => controller.error(options.signal?.reason));
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  });

  const result = findPublishedCopy(doi);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await result).toBeNull();
  expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it("skips an unrelated record and uses another verified KITopen result", async () => {
  const id = "1234";
  const anotherRecord = `${kitOrigin}/${id}`;
  const anotherPDF = `${anotherRecord}/8999`;
  fetchMock
    .mockResolvedValueOnce(Response.json({
      doi: doiURL,
      locations: [
        { is_oa: true, landing_page_url: kitLanding },
        { is_oa: true, landing_page_url: kitLanding },
        { is_oa: true, landing_page_url: `https://doi.org/10.5445/IR/${id}` },
      ],
    }))
    .mockResolvedValueOnce(record(`${original.replace(doiURL, `${doiURL}0`)}${published}`))
    .mockResolvedValueOnce(record(`${original}${published.replace(pdfURL, anotherPDF)}`))
    .mockResolvedValueOnce(pdf());

  expect((await findPublishedCopy(doi))?.url).toBe(anotherPDF);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([workURL, recordURL, anotherRecord, anotherPDF]);
});
