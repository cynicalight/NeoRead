/// <reference types="chrome" />
import type { Candidate } from "./detect";
import { isScienceDirectPDFLocation } from "./scienceDirect";

export type ScienceDirectPending = {
  title: string;
  status: "waiting" | "saving" | "done" | "error" | "large-paper";
  error?: string;
  pages?: number;
};
export type ImportResult = {
  ok: boolean;
  error?: string;
  code?: string;
  pages?: number;
  warnings?: string[];
  document?: { id: string; title: string };
};
type Library = "papers" | "books";
type SaveRequest = {
  candidate: Candidate;
  folders: string[];
  tags: string[];
  allowLarge: boolean;
  library: Library;
};
type Task = { pending: ScienceDirectPending; request?: SaveRequest };
type Attempt = { signal: AbortSignal; pdfUrl: string };
type Retry = { allowLarge?: boolean; library?: Library };
type Reply = { pending?: ScienceDirectPending; ok?: boolean; error?: string };
type Started = { controller: AbortController; pdfUrl: string; title: string; request: SaveRequest };
const noPDF = "请在此标签页打开该论文的 PDF 并等待加载完成，再重试";
const downloadFailed = "插件无法下载此 PDF；请在网站确认能正常打开后重试，或手动下载后导入";
const interrupted = "上一次收录已中断；请先检查 NeoRead 中是否已收录，再重试";

// Session storage survives MV3 worker suspension, but not a browser restart.
// Keys are per verification tab, and only public article data and selections
// are retained. The current PDF URL stays in the active attempt, never storage.
export function createScienceDirectResume(
  save: (request: SaveRequest, attempt: Attempt) => Promise<ImportResult>,
) {
  const running = new Map<number, { controller: AbortController; pdfUrl: string }>();
  const locks = new Map<number, Promise<unknown>>();
  const key = (tabId: number) => `sciencedirect:${tabId}`;
  function withTab<T>(tabId: number, work: () => Promise<T>): Promise<T> {
    const run = (locks.get(tabId) ?? Promise.resolve()).catch(() => {}).then(work);
    locks.set(tabId, run);
    const clear = () => { if (locks.get(tabId) === run) locks.delete(tabId); };
    void run.then(clear, clear);
    return run;
  }
  async function read(tabId: number): Promise<Task | undefined> {
    const name = key(tabId);
    const data = await chrome.storage.session.get(name);
    return data[name] as Task | undefined;
  }
  function write(tabId: number, task: Task) {
    return chrome.storage.session.set({ [key(tabId)]: task });
  }
  function pending(tabId: number, task: Task): ScienceDirectPending {
    return task.pending.status === "saving" && !running.has(tabId)
      ? { title: task.pending.title, status: "error", error: interrupted }
      : task.pending;
  }
  const tabInfo = (tabId: number) => chrome.tabs.get(tabId).catch(() => undefined);
  const dismiss = (tabId: number) => {
    running.get(tabId)?.controller.abort();
    return withTab(tabId, async () => {
      running.get(tabId)?.controller.abort();
      running.delete(tabId);
      await chrome.storage.session.remove(key(tabId));
      return { ok: true };
    });
  };

  async function begin(request: SaveRequest, sourceUrl: string) {
    const tab = await chrome.tabs.create({ url: `${sourceUrl}/pdfft`, active: false });
    if (tab.id === undefined) throw new Error("Missing verification tab ID");
    const tabId = tab.id;
    try {
      await withTab(tabId, async () => {
        if (!(await tabInfo(tabId))) throw new Error("Verification tab closed");
        const { title, metadata, snapshot, snapshotWarnings } = request.candidate;
        await write(tabId, {
          pending: { title, status: "waiting" },
          request: {
            ...request,
            candidate: {
              title, metadata, snapshot, snapshotWarnings,
              sourceUrl,
              pdfUrl: "",
            },
          },
        });
      });
    } catch (error) {
      await chrome.tabs.remove(tabId).catch(() => {});
      throw error;
    }
    return tabId;
  }

  async function currentPDF(tabId: number, sourceUrl: string, manual: boolean) {
    const tab = await tabInfo(tabId);
    if (
      !tab?.url || tab.status !== "complete" || tab.pendingUrl ||
      (!manual && !tab.active) || !isScienceDirectPDFLocation(tab.url, sourceUrl)
    ) return;

    // Even the final CDN .pdf path may show a verification page. Don't fetch
    // it automatically until Chrome has loaded a PDF document, not HTML.
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ url: location.href, type: document.contentType }),
    }).catch(() => null);
    const page = frames?.[0]?.result;
    if (page) {
      if (page.url !== tab.url || page.type !== "application/pdf") return;
    } else if (frames && !manual) {
      // No document was inspected. If Chrome refused injection (as it can
      // for its PDF viewer), allow one validated fetch at the matching URL.
      return;
    }
    return tab.url;
  }

  async function resume(tabId: number, retry?: Retry): Promise<Reply> {
    const next = await withTab<Started | { reply: Reply }>(tabId, async () => {
      const task = await read(tabId);
      if (!task) return { reply: {} };
      if (!task.request) return { reply: { pending: task.pending } };
      const status = pending(tabId, task);
      if (
        status.status === "saving" || (!retry && status.status !== "waiting") ||
        (status.status === "large-paper" && !retry?.allowLarge)
      ) return { reply: { pending: status } };
      const pdfUrl = await currentPDF(tabId, task.request.candidate.sourceUrl, !!retry);
      if (!pdfUrl) {
        return { reply: { pending: status, ...(retry && { ok: false, error: noPDF }) } };
      }
      const controller = new AbortController();
      running.set(tabId, { controller, pdfUrl });
      try {
        await write(tabId, { ...task, pending: { title: status.title, status: "saving" } });
      } catch (error) {
        running.delete(tabId);
        throw error;
      }
      return {
        controller, pdfUrl, title: status.title,
        request: {
          ...task.request,
          library: retry?.library ?? task.request.library,
          allowLarge: retry?.allowLarge === true || task.request.allowLarge,
        },
      };
    });
    if ("reply" in next) return next.reply;

    const { controller, pdfUrl, title, request } = next;
    try {
      const tab = await tabInfo(tabId);
      if (!tab || tab.url !== pdfUrl || tab.pendingUrl || tab.status !== "complete") {
        controller.abort();
        return {};
      }
      if (controller.signal.aborted) return {};
      const result = await save(request, { pdfUrl, signal: controller.signal })
        .catch((): ImportResult => ({ ok: false, error: downloadFailed }));
      return await withTab(tabId, async () => {
        if (controller.signal.aborted) return {};
        const update: ScienceDirectPending = result.ok
          ? { title: result.document?.title || title, status: "done" }
          : result.code === "large-paper"
            ? { title, status: "large-paper", pages: result.pages }
            : { title, status: "error", error: result.error || downloadFailed };
        await write(tabId, result.ok ? { pending: update } : { pending: update, request });
        return { pending: update, ok: result.ok, error: update.error };
      });
    } finally {
      if (running.get(tabId)?.controller === controller) running.delete(tabId);
    }
  }

  function autoResume(tabId: number) { void resume(tabId).catch(() => {}); }
  chrome.tabs.onActivated.addListener(({ tabId }) => autoResume(tabId));
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    const attempt = running.get(tabId);
    if (attempt && (change.status === "loading" || (change.url && change.url !== attempt.pdfUrl)))
      attempt.controller.abort();
    if (change.status === "complete") autoResume(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => { void dismiss(tabId).catch(() => {}); });

  return {
    begin, dismiss, resume,
    status: (tabId: number): Promise<Reply> => withTab(tabId, async () => {
      const task = await read(tabId);
      return task ? { pending: pending(tabId, task) } : {};
    }),
  };
}
