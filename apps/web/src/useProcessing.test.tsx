// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Processing } from "@neoread/core";
import { useProcessing } from "./ProcessingStatus";

const completed: Processing = {
  documentId: "one",
  phase: "ready",
  status: "complete",
  pagesDone: 1,
  pagesTotal: 1,
  translationsDone: 1,
  translationsTotal: 1,
  detail: "",
  updatedAt: "2026-10-01T00:00:00Z",
};
let rows: Processing[];
let root: Root;
const commits = vi.fn<(state: ReturnType<typeof useProcessing>) => void>();
const fetchProcessing = vi.fn<typeof fetch>();
function Probe() {
  const state = useProcessing();
  useLayoutEffect(() => {
    commits(state);
  });
  return null;
}
const latest = () => commits.mock.calls.at(-1)![0];
const mount = () => act(async () => root.render(<Probe />));
const tick = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
async function visible(value: boolean) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(
    value ? "visible" : "hidden",
  );
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(document.createElement("div"));
  rows = [completed];
  commits.mockClear();
  fetchProcessing.mockReset().mockImplementation(async (url) => {
    expect(url).toBe("/api/processing");
    return Response.json(rows);
  });
  vi.stubGlobal("fetch", fetchProcessing);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps checking an idle library without committing unchanged snapshots", async () => {
  rows = Array.from({ length: 518 }, (_, i) => ({
    ...completed,
    documentId: String(i),
  }));
  await mount();
  // Flush each interval separately so React cannot batch unrelated polls together.
  for (let i = 0; i < 50; i++) await tick(1200);
  const counts = {
    requests: fetchProcessing.mock.calls.length,
    commits: commits.mock.calls.length,
  };
  expect(latest().jobs).toHaveLength(518);
  expect(counts).toEqual({ requests: 7, commits: 2 });
});

it("discovers a new queued task at idle cadence, then tracks progress every 1.2 seconds", async () => {
  rows = [];
  await mount();
  rows = [{ ...completed, phase: "learning", status: "queued" }];
  await tick(10_000);
  expect(latest().jobs).toEqual(rows);
  rows = [{ ...rows[0], status: "running", pagesDone: 0 }];
  await tick(1200);
  expect(latest().jobs).toEqual(rows);
  const count = commits.mock.calls.length;
  await tick(1200);
  expect(commits).toHaveBeenCalledTimes(count);
  rows = [];
  await tick(1200);
  expect(latest().jobs).toEqual([]);
});

it("tracks independent book layout changes even when the main job is complete", async () => {
  rows = [
    {
      ...completed,
      bookLayout: { status: "running", pagesDone: 0, pagesTotal: 2 },
    },
  ];
  await mount();
  rows = [
    {
      ...rows[0],
      bookLayout: { status: "running", pagesDone: 1, pagesTotal: 2 },
    },
  ];
  await tick(1200);
  expect(latest().jobs).toEqual(rows);
  rows = [
    {
      ...rows[0],
      bookLayout: { status: "failed", pagesDone: 1, pagesTotal: 2 },
      warning: "failed",
    },
  ];
  await tick(1200);
  expect(latest().jobs).toEqual(rows);
  const count = fetchProcessing.mock.calls.length;
  await tick(1200);
  expect(fetchProcessing).toHaveBeenCalledTimes(count);
});

it("preserves the last jobs on failure and clears the error on an identical recovery", async () => {
  rows = [
    {
      ...completed,
      phase: "translating",
      status: "running",
      translating: { status: "running", detail: "" },
    },
  ];
  await mount();
  const snapshot = latest().jobs;
  fetchProcessing
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new Error("offline"));
  await tick(1200);
  expect(latest().error).toBe("offline");
  expect(latest().jobs).toBe(snapshot);
  const count = commits.mock.calls.length;
  await tick(1200);
  expect(commits).toHaveBeenCalledTimes(count);
  await tick(1200);
  expect(latest().error).toBe("");
  expect(latest().jobs).toBe(snapshot);
  rows = [
    {
      ...rows[0],
      translating: { status: "failed", detail: "translation failed" },
    },
  ];
  await tick(1200);
  expect(latest().jobs).toEqual(rows);
});

it("does not poll while hidden, including on mount, and refreshes immediately when shown", async () => {
  await visible(false);
  await mount();
  await tick(60_000);
  expect(fetchProcessing).not.toHaveBeenCalled();
  await visible(true);
  expect(fetchProcessing).toHaveBeenCalledTimes(1);
  await visible(false);
  await tick(60_000);
  expect(fetchProcessing).toHaveBeenCalledTimes(1);
  await visible(true);
  expect(fetchProcessing).toHaveBeenCalledTimes(2);
});

it("ignores a response from before hiding and does not start a second timer", async () => {
  let finish!: (response: Response) => void;
  fetchProcessing.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  const signal = fetchProcessing.mock.calls[0][1]?.signal;
  await visible(false);
  expect(signal?.aborted).toBe(true);
  await visible(true);
  expect(latest().jobs).toEqual(rows);
  const count = commits.mock.calls.length;
  await act(async () =>
    finish(Response.json([{ ...completed, status: "failed" }])),
  );
  expect(commits).toHaveBeenCalledTimes(count);
  await tick(10_000);
  expect(fetchProcessing).toHaveBeenCalledTimes(3);
});
