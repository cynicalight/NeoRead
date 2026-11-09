// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Processing } from "@neoread/core";
import { api, type ChapterTranslationStatus } from "@neoread/api";
import { BookChapterControls, completionLabelMs } from "./BookChapterControls";
import {
  chapterPhase,
  useChapterTranslation,
  type ChapterQuery,
} from "./chapterTranslation";
import { chapterTitle } from "./chapters";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock("@neoread/api", () => ({
  api: {
    assistance: vi.fn(),
    setAssistance: vi.fn(),
    chapterTranslationStatus: vi.fn(),
  },
}));

let root: Root, host: HTMLDivElement;
const job: Processing = {
  documentId: "book",
  phase: "ready",
  status: "complete",
  enabled: true,
  pagesDone: 0,
  pagesTotal: 0,
  translationsDone: 0,
  translationsTotal: 0,
  detail: "",
  updatedAt: "2026-11-08T00:00:00Z",
};
const counts = (
  value: Partial<ChapterTranslationStatus>,
): ChapterTranslationStatus => ({
  key: "c1",
  title: "第一章",
  total: 4,
  idle: 0,
  pending: 0,
  running: 0,
  complete: 0,
  failed: 0,
  unparsed: 0,
  parsing: false,
  ...value,
});
const onRequest = vi.fn(async () => {});
const onChange = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.assistance).mockResolvedValue(job);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});
async function render(
  status?: ChapterTranslationStatus,
  processing = job,
  title?: string,
) {
  await act(async () =>
    root.render(
      <BookChapterControls
        documentId="book"
        processing={processing}
        status={status}
        title={title}
        onRequest={onRequest}
        onChange={onChange}
      />,
    ),
  );
}
const button = () => host.querySelector<HTMLButtonElement>("button")!;

it("derives the button from the chapter, treating failed paragraphs as done", () => {
  expect(chapterPhase(counts({ idle: 1, complete: 3 }), true)).toBe(
    "untranslated",
  );
  expect(chapterPhase(counts({ unparsed: 2 }), true)).toBe("untranslated");
  expect(chapterPhase(counts({ pending: 1, idle: 3 }), true)).toBe(
    "translating",
  );
  expect(chapterPhase(counts({ parsing: true, unparsed: 3 }), true)).toBe(
    "translating",
  );
  expect(chapterPhase(counts({ running: 1 }), false)).toBe("paused");
  expect(chapterPhase(counts({ complete: 3, failed: 1 }), true)).toBe(
    "complete",
  );
});

it("waits for the chapter, then requests it", async () => {
  await render(undefined);
  expect(button().disabled).toBe(true);
  await render(counts({ idle: 4 }));
  expect(host.textContent).toBe("翻译本章");
  await act(async () => button().click());
  expect(onRequest).toHaveBeenCalledOnce();
  expect(api.setAssistance).not.toHaveBeenCalled();
  expect(onChange).toHaveBeenCalled();
});

it("pauses a chapter in progress and continues it through a chapter request", async () => {
  await render(counts({ pending: 2, complete: 2 }));
  expect(host.textContent).toBe("暂停翻译");
  await act(async () => button().click());
  expect(api.setAssistance).toHaveBeenCalledWith("book", "pause");
  await render(counts({ pending: 2, complete: 2 }), {
    ...job,
    enabled: false,
    status: "paused",
  });
  expect(host.textContent).toBe("继续翻译");
  await act(async () => button().click());
  expect(onRequest).toHaveBeenCalledOnce();
});

it("names a completion seen in view for three seconds, then keeps only the check", async () => {
  await render(counts({ running: 1, complete: 3 }));
  await render(counts({ complete: 3, failed: 1 }));
  expect(host.textContent).toBe("翻译完成");
  expect(button().getAttribute("aria-label")).toBe("翻译完成：第一章");
  await act(async () => vi.advanceTimersByTime(completionLabelMs));
  expect(host.textContent).toBe("");
  expect(button().querySelector("svg")).not.toBeNull();
});

it("shows only the check when arriving at a finished chapter", async () => {
  await render(counts({ key: "c1", idle: 4 }));
  await render(counts({ key: "c2", complete: 4 }), job, "第 3–9 页");
  expect(host.textContent).toBe("");
  expect(button().getAttribute("aria-label")).toBe("翻译完成：第 3–9 页");
  await act(async () => button().click());
  expect(onRequest).not.toHaveBeenCalled();
});

it("names PDF chapters by outline title or page range", () => {
  const item = (id: string, label: string, page: number) => ({
    id,
    label,
    location: { type: "pdf" as const, page },
    children: [],
  });
  const toc = [item("0", "Intro", 1), item("1", "Methods", 5)];
  expect(chapterTitle(toc, { fromPage: 5, toPage: 9 })).toBe("Methods");
  expect(chapterTitle([], { fromPage: 3, toPage: 9 })).toBe("第 3–9 页");
  expect(chapterTitle([], { fromPage: 4, toPage: 4 })).toBe("第 4 页");
});

it("does not act on counts fetched for an earlier anchor", async () => {
  await act(async () =>
    root.render(
      <BookChapterControls
        documentId="book"
        processing={job}
        status={counts({ pending: 1 })}
        stale
        onRequest={onRequest}
        onChange={onChange}
      />,
    ),
  );
  expect(button().disabled).toBe(true);
});

it("hides counts once the anchor leaves their file and marks moves within it stale", async () => {
  vi.mocked(api.chapterTranslationStatus).mockImplementation(
    async (_id, query) =>
      counts({
        key: "location" in query ? query.location.href : "",
        complete: 4,
      }),
  );
  let seen: ReturnType<typeof useChapterTranslation> | undefined;
  function Probe({ query }: { query: ChapterQuery }) {
    seen = useChapterTranslation("book", query, "r");
    return null;
  }
  const at = (href: string, blockId: string): ChapterQuery => ({
    location: { type: "epub", href, blockId },
  });
  const show = (query: ChapterQuery) =>
    act(async () => root.render(<Probe query={query} />));
  await show(at("a.xhtml", "a1"));
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(seen?.status?.key).toBe("a.xhtml");
  expect(seen?.stale).toBe(false);
  await show(at("a.xhtml", "a2"));
  expect(seen?.status?.key).toBe("a.xhtml");
  expect(seen?.stale).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(seen?.stale).toBe(false);
  await show(at("b.xhtml", "b1"));
  expect(seen?.status).toBeUndefined();
  expect(seen?.stale).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(seen?.status?.key).toBe("b.xhtml");
});
