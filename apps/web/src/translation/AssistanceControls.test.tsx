// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Processing } from "@neoread/core";
import { AssistanceControls } from "./AssistanceControls";
import { api } from "@neoread/api";
import { toast } from "sonner";
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock("@neoread/api", () => ({
  api: {
    assistance: vi.fn(async () => undefined),
    setAssistance: vi.fn(),
    aiConfig: vi.fn(async () => ({ primary: "codex" })),
  },
}));
let root: Root, host: HTMLDivElement;
const paused: Processing = {
  documentId: "book",
  phase: "translating",
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

it.each(["queued", "running"] as const)(
  "keeps mandatory paper parsing %s without a pause action",
  async (status) => {
    await render(1, { ...paused, phase: "learning", enabled: true, status });
    expect(host.textContent).toContain(
      status === "queued" ? "等待解析" : "解析中",
    );
    const button = host.querySelector<HTMLButtonElement>("button")!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(api.setAssistance).not.toHaveBeenCalled();
  },
);

it("retries paper parsing without labelling it as translation", async () => {
  await render(1, {
    ...paused,
    enabled: true,
    phase: "learning",
    status: "failed",
    autoTranslateMaxPages: 0,
  });
  expect(host.textContent).toContain("重试解析");
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(api.setAssistance).toHaveBeenCalledWith("book", "resume");
});
