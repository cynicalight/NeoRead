import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Candidate } from "./detect";
const { findPublishedCopy } = vi.hoisted(() => ({ findPublishedCopy: vi.fn() }));
vi.mock("./publishedCopy", async (original) => {
  const actual = await original<Record<string, unknown>>();
  return { ...actual, findPublishedCopy };
});
let listener: (
  message: unknown,
  sender: unknown,
  respond: (result: unknown) => void,
) => boolean | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let rules: ReturnType<typeof vi.fn>;
let session: Record<string, unknown>;
let tabs: Map<number, chrome.tabs.Tab>;
let createTab: ReturnType<typeof vi.fn>;
let inspect: ReturnType<typeof vi.fn>;
let tabActivated: (event: { tabId: number }) => void;
let tabUpdated: (tabId: number, change: chrome.tabs.OnUpdatedInfo) => void;
let tabRemoved: (tabId: number) => void;
const sender = { id: "neoread-extension", url: "chrome-extension://neoread-extension/popup.html" };
const candidate: Candidate = {
  title: "论文",
  sourceUrl: "https://kns.cnki.net/kcms2/article/abstract?v=example",
  pdfUrl: "https://kns.cnki.net/download?id=example",
  metadata: { title: "论文" },
  snapshot: "",
};
const dispatch = (message: unknown) =>
  new Promise<Record<string, unknown>>((resolve) =>
    listener(message, sender, (result) =>
      resolve(result as Record<string, unknown>),
    ),
  );
beforeEach(async () => {
  vi.resetModules();
  findPublishedCopy.mockReset().mockResolvedValue(null);
  rules = vi.fn().mockResolvedValue(undefined);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  session = {};
  tabs = new Map();
  createTab = vi.fn(async ({ url, active }: chrome.tabs.CreateProperties) => {
    const id = tabs.size + 10;
    const tab = { id, url, active, status: "loading" } as chrome.tabs.Tab;
    tabs.set(id, tab);
    return tab;
  });
  inspect = vi.fn(async ({ target }: { target: { tabId: number } }) => [
    { result: { url: tabs.get(target.tabId)?.url, type: "application/pdf" } },
  ]);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "neoread-extension",
      getURL: (name: string) => `chrome-extension://neoread-extension/${name}`,
      getPlatformInfo: vi.fn().mockResolvedValue({}),
      onMessage: {
        addListener: (fn: typeof listener) => {
          listener = fn;
        },
      },
    },
    storage: {
      local: { get: vi.fn().mockResolvedValue({ secret: "test-secret" }) },
      session: {
        get: async (key: string) => structuredClone({ [key]: session[key] }),
        set: async (data: object) => Object.assign(session, structuredClone(data)),
        remove: async (key: string) => { delete session[key]; },
      },
    },
    tabs: {
      create: createTab,
      get: async (id: number) => {
        if (!tabs.has(id)) throw new Error("Tab closed");
        return tabs.get(id);
      },
      remove: async (id: number) => { tabs.delete(id); },
      onActivated: { addListener: (fn: typeof tabActivated) => { tabActivated = fn; } },
      onUpdated: { addListener: (fn: typeof tabUpdated) => { tabUpdated = fn; } },
      onRemoved: { addListener: (fn: typeof tabRemoved) => { tabRemoved = fn; } },
    },
    scripting: { executeScript: inspect },
    declarativeNetRequest: {
      updateSessionRules: rules,
      RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      HeaderOperation: { SET: "set" },
      ResourceType: { XMLHTTPREQUEST: "xmlhttprequest" },
    },
  });
  await import("./worker");
});
afterEach(() => vi.unstubAllGlobals());
it("returns a verification error through the real save listener without importing HTML", async () => {
  fetchMock.mockResolvedValue(new Response("<title>安全验证</title>"));
  expect(await dispatch({ type: "save", candidate })).toMatchObject({
    ok: false,
    code: "cnki-verification",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(rules.mock.calls[0][0]).toEqual({ removeRuleIds: [17841] });
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
});
it("uploads only the validated PDF and preserves NeoRead labels and library choices", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response("%PDF-1.7\nbody"))
    .mockResolvedValueOnce(
      Response.json({ document: { id: "saved", title: "论文" } }),
    );
  expect(
    await dispatch({
      type: "save",
      candidate,
      folders: ["科研"],
      tags: ["安全"],
      library: "books",
      allowLarge: true,
    }),
  ).toMatchObject({ ok: true, document: { id: "saved" } });
  const [url, options] = fetchMock.mock.calls[1];
  expect(url).toBe("http://127.0.0.1:17841/v1/import");
  expect(options.headers).toEqual({ Authorization: "Bearer test-secret" });
  const form = options.body as FormData;
  expect(await (form.get("pdf") as Blob).text()).toBe("%PDF-1.7\nbody");
  expect(form.get("folders")).toBe('["科研"]');
  expect(form.get("tags")).toBe('["安全"]');
  expect(form.get("library")).toBe("books");
  expect(form.get("allowLarge")).toBe("1");
});
it("returns detail-page HTML through the authenticated CNKI message path", async () => {
  fetchMock.mockResolvedValue(new Response("<h1>详情页</h1>"));
  expect(
    await dispatch({
      type: "cnki-page",
      url: candidate.sourceUrl,
      sourceUrl: "https://kns.cnki.net/kns8s/defaultresult/",
    }),
  ).toMatchObject({ ok: true, html: "<h1>详情页</h1>" });
});

const publisher = "https://www.sciencedirect.com/science/article/pii";
const pii = "S0167572925000172";
const otherPII = "S0167572925000173";
const signedPDF = `https://pdf.sciencedirectassets.com/271446/1-s2.0-${pii}/1-s2.0-${pii}/main.pdf?X-Amz-Signature=ephemeral`;
const article: Candidate = {
  title: "ScienceDirect paper",
  sourceUrl: `${publisher}/${pii}?via=ihub`,
  pdfUrl: `${publisher}/${pii}/pdfft?download=true`,
  metadata: { title: "ScienceDirect paper", doi: "10.0000/example" },
  snapshot: "<article>Research</article>",
  referrerUrl: "https://example.org/?state=temporary-referrer",
};
function challenge() {
  return new Response("<title>Just a moment...</title>", {
    status: 403,
    headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
  });
}
async function begin(paper = article) {
  const tabId = 10 + tabs.size;
  tabs.set(tabId, { id: tabId, url: paper.pdfUrl, active: true, status: "loading" } as chrome.tabs.Tab);
  const result = await dispatch({
    type: "save",
    viewerTabId: tabId,
    candidate: paper,
    folders: ["科研"],
    tags: ["物理"],
  });
  expect(result).toMatchObject({ pending: { status: "waiting" } });
  tabs.get(tabId)!.active = false;
  return tabId;
}
const status = (tabId: number) => dispatch({ type: "sciencedirect-status", tabId });
const resume = (tabId: number, options = {}) =>
  dispatch({ type: "sciencedirect-resume", tabId, ...options });
function navigate(tabId: number, url: string, status: "loading" | "complete" = "complete") {
  Object.assign(tabs.get(tabId)!, { url, status });
  tabUpdated(tabId, { status });
}
function activate(tabId: number) {
  tabs.get(tabId)!.active = true;
  tabActivated({ tabId });
}

it.each(["loaded PDF", "expired XML"])("recovers the standalone %s using only the paper identifier", async mode => {
  const tabId = 42;
  const sourceUrl = `${publisher}/${pii}`;
  tabs.set(tabId, { id: tabId, active: true, status: "complete", url: signedPDF } as chrome.tabs.Tab);
  const copyURL = "https://publikationen.bibliothek.kit.edu/123/456";
  const doi = "10.1016/j.surfrep.2025.100669";
  findPublishedCopy.mockResolvedValue({ url: copyURL, blob: new Blob(["%PDF-1.7\npublished"]) });
  if (mode === "loaded PDF") fetchMock.mockResolvedValueOnce(new Response("Expired", { status: 403 }));
  else inspect.mockResolvedValueOnce([{ result: { url: signedPDF, type: "application/xml" } }]);
  fetchMock.mockResolvedValueOnce(Response.json({ message: { "total-results": 1, items: [
      { DOI: doi, title: ["Original title"], "alternative-id": [pii] },
    ] } }))
    .mockResolvedValueOnce(Response.json({ document: { id: "recovered", title: "Original title" } }));
  const result = await dispatch({ type: "save", viewerTabId: tabId, folders: ["科研"], tags: ["材料"],
    candidate: { title: pii, sourceUrl, pdfUrl: "", snapshot: "", metadata: { title: pii, url: sourceUrl } } });
  expect(result.pending).toMatchObject({ status: "done", title: "Original title", warnings: [expect.stringContaining(copyURL)] });
  const calls = fetchMock.mock.calls;
  expect(calls.some(([url]) => url === signedPDF)).toBe(mode === "loaded PDF");
  const lookup = new URL(calls.at(-2)![0]);
  expect(lookup.hostname).toBe("api.crossref.org");
  expect(lookup.searchParams.get("filter")).toBe(`alternative-id:${pii}`);
  const form = calls.at(-1)![1].body as FormData;
  expect(JSON.parse(String(form.get("metadata")))).toMatchObject({ title: "Original title", doi });
  expect(form.get("sourceUrl")).toBe(sourceUrl);
  expect(form.get("folders")).toBe('["科研"]');
  expect(form.get("tags")).toBe('["材料"]');
  expect(JSON.stringify([lookup.href, session])).not.toContain("ephemeral");
  expect(createTab).not.toHaveBeenCalled();
});

it("collects an already-open publisher PDF in its original tab, waiting there if it still shows HTML", async () => {
  const tabId = 41;
  tabs.set(tabId, { id: tabId, active: true, status: "complete", url: article.pdfUrl } as chrome.tabs.Tab);
  inspect.mockResolvedValueOnce([{ result: { url: article.pdfUrl, type: "text/html" } }]);
  const sourceUrl = `${publisher}/${pii}`;
  const result = await dispatch({
    type: "save", viewerTabId: tabId, candidate: { ...article, sourceUrl, pdfUrl: "" },
    folders: ["科研"], tags: ["物理"],
  });
  expect(result.pending).toMatchObject({ status: "waiting" });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(createTab).not.toHaveBeenCalled();
  expect(JSON.stringify(session)).not.toContain("ephemeral");
  fetchMock
    .mockResolvedValueOnce(new Response("%PDF-1.7\ncurrent viewer"))
    .mockResolvedValueOnce(Response.json({ document: { id: "direct", title: "Paper" } }));
  navigate(tabId, signedPDF);
  await vi.waitFor(async () => expect(await status(tabId)).toMatchObject({ pending: { status: "done" } }));
  expect(fetchMock.mock.calls[0][0]).toBe(signedPDF);
  const form = fetchMock.mock.calls[1][1].body as FormData;
  expect(form.get("sourceUrl")).toBe(sourceUrl);
  expect(form.get("tags")).toBe('["物理"]');
  expect(form.get("folders")).toBe('["科研"]');
});

it("only resumes a visible, complete same-article PDF and preserves the original import choices", async () => {
  const tabId = await begin();
  expect(createTab).not.toHaveBeenCalled();
  expect(JSON.stringify(session)).not.toMatch(/via=ihub|temporary-referrer|ephemeral/);
  navigate(tabId, article.pdfUrl);
  expect(await status(tabId)).toEqual({
    pending: { title: article.title, status: "waiting" },
  });
  expect(fetchMock).not.toHaveBeenCalled();

  inspect.mockResolvedValueOnce([{ result: { url: article.pdfUrl, type: "text/html" } }]);
  activate(tabId);
  await status(tabId);
  expect(fetchMock).not.toHaveBeenCalled();
  navigate(tabId, `${publisher}/${pii}`);
  expect(await resume(tabId)).toMatchObject({ ok: false, pending: { status: "waiting" } });
  navigate(tabId, signedPDF.replace("pdf.sciencedirectassets.com", "evil.invalid"));
  expect(await resume(tabId)).toMatchObject({ ok: false, pending: { status: "waiting" } });
  navigate(tabId, signedPDF.replaceAll(pii, otherPII));
  expect(await resume(tabId)).toMatchObject({ ok: false, pending: { status: "waiting" } });
  navigate(tabId, signedPDF, "loading");
  expect(await resume(tabId)).toMatchObject({ ok: false, pending: { status: "waiting" } });
  expect(fetchMock).not.toHaveBeenCalled();

  fetchMock
    .mockResolvedValueOnce(new Response("%PDF-1.7\narticle"))
    .mockResolvedValueOnce(Response.json({ document: { id: "sd", title: "Final title" } }));
  navigate(tabId, signedPDF);
  tabUpdated(tabId, { status: "complete" });
  await vi.waitFor(async () => {
    expect(await status(tabId)).toEqual({ pending: { title: "Final title", status: "done" } });
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0]).toEqual([signedPDF, expect.objectContaining({ redirect: "error" })]);
  const form = fetchMock.mock.calls[1][1].body as FormData;
  expect(form.get("sourceUrl")).toBe(`${publisher}/${pii}`);
  expect(form.get("snapshot")).toBe(article.snapshot);
  expect(form.get("metadata")).toBe(JSON.stringify(article.metadata));
  expect(form.get("folders")).toBe('["科研"]');
  expect(form.get("tags")).toBe('["物理"]');
  expect(session[`sciencedirect:${tabId}`]).toEqual({
    pending: { title: "Final title", status: "done" },
  });
  expect(await dispatch({ type: "sciencedirect-dismiss", tabId })).toEqual({ ok: true });
  expect(await status(tabId)).toEqual({});
});

it.each([403, 200])("keeps a failed resumed download (%s HTML) for explicit retry without re-opening tabs", async (httpStatus) => {
  const tabId = await begin();
  navigate(tabId, signedPDF);
  await status(tabId);
  inspect.mockRejectedValueOnce(new Error("Chrome PDF viewer cannot be scripted"));
  fetchMock.mockResolvedValueOnce(new Response("<h1>HTML, not PDF</h1>", { status: httpStatus }));
  activate(tabId);
  await vi.waitFor(async () => {
    expect(await status(tabId)).toMatchObject({ pending: { status: "error" } });
  });
  tabUpdated(tabId, { status: "complete" });
  tabActivated({ tabId });
  await status(tabId);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(createTab).not.toHaveBeenCalled();
  expect(JSON.stringify(session)).not.toContain("ephemeral");

  fetchMock
    .mockResolvedValueOnce(new Response("%PDF-1.7\nretry"))
    .mockResolvedValueOnce(Response.json({ document: { id: "retried", title: article.title } }));
  expect(await resume(tabId)).toMatchObject({ ok: true, pending: { status: "done" } });
  expect(createTab).not.toHaveBeenCalled();
});

it("keeps independent tasks across worker restarts, including large-paper confirmation", async () => {
  const first = await begin();
  const second = await begin({
    ...article,
    title: "Another paper",
    sourceUrl: `${publisher}/${otherPII}`,
    pdfUrl: `${publisher}/${otherPII}/pdfft?download=true`,
  });
  vi.resetModules();
  // Reload the worker so its in-memory state is gone while storage.session remains.
  await import("./worker");
  expect(await status(first)).toMatchObject({ pending: { title: article.title, status: "waiting" } });
  expect(await status(second)).toMatchObject({ pending: { title: "Another paper", status: "waiting" } });

  navigate(first, signedPDF);
  fetchMock
    .mockResolvedValueOnce(new Response("%PDF-1.7"))
    .mockResolvedValueOnce(Response.json({ code: "large-paper", pages: 123 }, { status: 409 }));
  expect(await resume(first)).toMatchObject({ pending: { status: "large-paper", pages: 123 } });
  expect(await resume(first)).toMatchObject({ pending: { status: "large-paper" } });
  expect(fetchMock).toHaveBeenCalledTimes(2);

  fetchMock
    .mockResolvedValueOnce(new Response("%PDF-1.7"))
    .mockResolvedValueOnce(Response.json({ document: { id: "large", title: article.title } }));
  expect(await resume(first, { allowLarge: true, library: "books" })).toMatchObject({
    ok: true,
    pending: { status: "done" },
  });
  const form = fetchMock.mock.calls[3][1].body as FormData;
  expect(form.get("allowLarge")).toBe("1");
  expect(form.get("library")).toBe("books");
  expect(form.get("tags")).toBe('["物理"]');
  expect(await status(second)).toMatchObject({ pending: { status: "waiting" } });
  tabs.delete(second);
  tabRemoved(second);
  expect(await status(second)).toEqual({});
});

it("aborts a download after its verification tab closes and does not resurrect the task", async () => {
  const tabId = await begin();
  navigate(tabId, signedPDF);
  let complete!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
  const attempt = resume(tabId);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  tabs.delete(tabId);
  tabRemoved(tabId);
  expect(await status(tabId)).toEqual({});
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  complete(new Response("%PDF-1.7"));
  await attempt;
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(session).toEqual({});
});

it("ignores ScienceDirect controls from website or content-script contexts", async () => {
  const tabId = await begin();
  const sendResponse = vi.fn();
  for (const type of ["sciencedirect-status", "sciencedirect-resume", "sciencedirect-dismiss"]) {
    expect(listener({ type, tabId }, { ...sender, url: signedPDF }, sendResponse)).toBeUndefined();
    expect(listener({ type, tabId }, { ...sender, id: "different-extension" }, sendResponse)).toBeUndefined();
  }
  expect(sendResponse).not.toHaveBeenCalled();
  expect(await status(tabId)).toMatchObject({ pending: { status: "waiting" } });
});

it("uploads a verified published copy with the original citation and labels, without opening a PDF tab", async () => {
  const url = "https://publikationen.bibliothek.kit.edu/1000000001/100000001";
  findPublishedCopy.mockResolvedValue({ blob: new Blob(["%PDF-1.7\npublished copy"]), url });
  fetchMock.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(
    Response.json({ document: { id: "saved", title: article.title } }, { status: 201 }),
  );
  const result = await dispatch({ type: "save", candidate: article, folders: ["科研"], tags: ["材料"] });
  expect(findPublishedCopy).toHaveBeenCalledWith(article.metadata.doi, undefined);
  expect(result).toMatchObject({ ok: true, warnings: [expect.stringContaining(url)] });
  const [bridgeURL, { body }] = fetchMock.mock.calls[1];
  expect(bridgeURL).toBe("http://127.0.0.1:17841/v1/import");
  expect(await body.get("pdf").text()).toBe("%PDF-1.7\npublished copy");
  expect(JSON.parse(body.get("metadata"))).toEqual(article.metadata);
  expect(body.get("snapshot")).toBe(article.snapshot);
  expect(body.get("folders")).toBe('["科研"]');
  expect(body.get("tags")).toBe('["材料"]');
  expect(createTab).not.toHaveBeenCalled();
});

it("returns a final result without opening a tab if neither source supplies an attachment", async () => {
  fetchMock.mockResolvedValueOnce(challenge());
  const result = await dispatch({ type: "save", candidate: { ...article, metadata: {} } });
  expect(result).toMatchObject({ ok: false, code: "pdf-unavailable" });
  expect(createTab).not.toHaveBeenCalled();
  expect(session).toEqual({});
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not automatically repeat an upload with an unknown outcome after worker suspension", async () => {
  const tabId = await begin();
  const task = session[`sciencedirect:${tabId}`] as { pending: { status: string } };
  task.pending.status = "saving";
  vi.resetModules();
  // Recreate only the service worker, preserving the previous attempt's record.
  await import("./worker");
  navigate(tabId, signedPDF);
  activate(tabId);
  expect(await status(tabId)).toMatchObject({ pending: { status: "error" } });
  expect(fetchMock).not.toHaveBeenCalled();
});
