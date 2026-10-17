// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Processing } from "@reader/core";
import { AssistanceControls } from "./AssistanceControls";
import { api } from "@reader/api";
import { toast } from "sonner";
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock("@reader/api", () => ({
  api: {
    assistance: vi.fn(async () => undefined),
    setAssistance: vi.fn(),
    translateRange: vi.fn(),
    translateEPUBChapter: vi.fn(),
    aiConfig: vi.fn(async () => ({ primary: "codex" })),
  },
}));
let root: Root, host: HTMLDivElement;
const paused: Processing = {
  documentId: "book",
  phase: "learning",
  status: "paused",
  enabled: false,
  pagesDone: 0,
  pagesTotal: 0,
  translationsDone: 0,
  translationsTotal: 0,
  detail: "辅助阅读未开启",
  updatedAt: "2026-10-07T00:00:00Z",
};
beforeEach(() => {
  vi.mocked(api.assistance).mockResolvedValue(undefined as never);
  vi.useFakeTimers();
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
async function render(page: number, processing: Processing = paused) {
  await act(async () =>
    root.render(
      <AssistanceControls documentId="book" processing={processing} />,
    ),
  );
}
it("opening and changing pages do not authorize processing", async () => {
  await render(1);
  await render(40);
  await act(async () => vi.advanceTimersByTime(1000));
  expect(api.setAssistance).not.toHaveBeenCalled();
  expect(host.textContent).toContain("翻译");
  vi.mocked(api.setAssistance).mockResolvedValue({
    ...paused,
    enabled: true,
    status: "queued",
    updatedAt: "2026-10-07T00:00:01Z",
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(api.setAssistance).toHaveBeenCalledWith("book", "start");
  expect(host.textContent).toContain("暂停翻译");
});
it("a paused whole-book job resumes instead of restarting its scope", async () => {
  const job: Processing = {
    ...paused,
    startedAt: "2026-10-07T00:00:01Z",
  };
  vi.mocked(api.setAssistance).mockResolvedValue({
    ...job,
    enabled: true,
    status: "queued",
  });
  await render(7, job);
  expect(host.textContent).toContain("继续翻译");
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(api.setAssistance).toHaveBeenCalledWith("book", "resume");
});

it("uses chronological status ordering for variable timestamp precision", async () => {
  const saved: Processing = {
    ...paused,
    enabled: true,
    status: "queued",
    updatedAt: "2026-10-08T00:00:00.12Z",
  };
  vi.mocked(api.assistance).mockResolvedValue(saved);
  await render(1, saved);
  await render(1, {
    ...saved,
    status: "complete",
    updatedAt: "2026-10-08T00:00:00.123Z",
  });
  expect(host.textContent).toContain("翻译完成");
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
});

it("keeps completion visible and requires confirmation before retranslation", async () => {
  const ready: Processing = {
    ...paused,
    enabled: true,
    status: "complete",
    phase: "ready",
    translationsDone: 2,
    translationsTotal: 2,
  };
  await render(1, ready);
  expect(host.textContent).toContain("翻译完成");
  const restart = () =>
    host.querySelector<HTMLButtonElement>('[aria-label="重新翻译"]')!;
  await act(async () => restart().click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "重新翻译全文？",
  );
  expect(api.setAssistance).not.toHaveBeenCalled();
  const dialogButton = (text: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="alertdialog"] button',
      ),
    ].find((b) => b.textContent === text)!;
  await act(async () => dialogButton("取消").click());
  expect(api.setAssistance).not.toHaveBeenCalled();
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  await act(async () => restart().click());
  vi.mocked(api.setAssistance).mockRejectedValueOnce(new Error("暂时无法开始"));
  await act(async () => dialogButton("开始重新翻译").click());
  expect(host.textContent).toContain("翻译完成");
  expect(toast.error).toHaveBeenCalledWith("暂时无法开始");
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  vi.mocked(api.setAssistance).mockResolvedValueOnce({
    ...ready,
    retranslating: true,
    status: "queued",
    updatedAt: "2026-10-17T00:00:00Z",
  });
  await act(async () => dialogButton("开始重新翻译").click());
  expect(api.setAssistance).toHaveBeenLastCalledWith("book", "retranslate");
  expect(host.textContent).toContain("暂停重译");
  expect(host.querySelector('[aria-label="重新翻译"]')).toBeNull();
});

it("offers continuation when an interrupted retranslation still has readable old text", async () => {
  await render(1, {
    ...paused,
    retranslating: true,
    startedAt: "2026-10-17T00:00:00Z",
  });
  expect(host.textContent).toContain("继续重译");
  expect(host.querySelector('[aria-label="重新翻译"]')).toBeNull();
});

it("a book translates the current chapter instead of the whole document", async () => {
  const ready: Processing = {
    ...paused,
    enabled: true,
    phase: "ready",
    status: "complete",
    startedAt: "2026-10-07T00:00:01Z",
  };
  vi.mocked(api.translateRange).mockResolvedValue({
    queued: 12,
    characters: 39000,
    nextPage: 31,
    parsing: false,
  });
  vi.mocked(api.assistance)
    .mockResolvedValueOnce(ready)
    .mockResolvedValueOnce({
      ...ready,
      phase: "translating",
      status: "queued",
      updatedAt: "2026-10-07T00:00:02Z",
    });
  await act(async () =>
    root.render(
      <AssistanceControls
        documentId="book"
        processing={ready}
        library="books"
        chapter={() => ({ fromPage: 20, toPage: 45 })}
      />,
    ),
  );
  expect(host.textContent).toContain("翻译本章");
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(api.translateRange).toHaveBeenCalledWith("book", 20, 45);
  expect(api.setAssistance).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(expect.stringContaining("第 31 页"));
  expect(host.textContent).toContain("暂停翻译");
});

it("a failed paper job offers a retry", async () => {
  await render(1, { ...paused, enabled: true, status: "failed" });
  expect(host.textContent).toContain("重试翻译");
  vi.mocked(api.setAssistance).mockResolvedValue({
    ...paused,
    enabled: true,
    status: "queued",
    updatedAt: "2026-10-07T00:00:01Z",
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(api.setAssistance).toHaveBeenCalledWith("book", "resume");
});

it("EPUB legacy jobs request a chapter without restarting old whole-book work", async () => {
  const location = { type: "epub" as const, href: "a.xhtml#two" };
  const job: Processing = {
    ...paused,
    startedAt: "2026-10-08T00:00:00Z",
    translating: { status: "complete", detail: "请按章节翻译" },
  };
  vi.mocked(api.translateEPUBChapter).mockResolvedValue({
    queued: 2,
    characters: 80,
    hasMore: false,
  });
  await act(async () =>
    root.render(
      <AssistanceControls
        documentId="book"
        processing={job}
        library="books"
        epubChapter={() => location}
      />,
    ),
  );
  expect(host.textContent).toContain("翻译本章");
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(api.translateEPUBChapter).toHaveBeenCalledWith("book", location);
  expect(api.setAssistance).not.toHaveBeenCalled();
  expect(api.translateRange).not.toHaveBeenCalled();
});

it("offers manual translation after local parsing instead of resuming a translation", async () => {
  await render(1, {
    ...paused,
    phase: "translating",
    pagesDone: 60,
    pagesTotal: 60,
    startedAt: "2026-10-16T00:00:00Z",
    manualTranslation: true,
  });
  expect(host.textContent).toContain("翻译");
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(api.setAssistance).toHaveBeenCalledWith("book", "start");
});
