import { afterEach, expect, it, vi } from "vitest";
const update = vi.hoisted(() => vi.fn());
vi.mock("@neoread/api", () => ({ api: { update } }));
afterEach(() => {
  vi.resetModules();
  update.mockReset();
  vi.useRealTimers();
});
it("flushes a pending location before desktop shutdown and awaits the server", async () => {
  vi.useFakeTimers();
  let acknowledge!: () => void;
  update.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const { scheduleProgress, flushProgress } = await import("./progress");
  scheduleProgress(
    "book",
    {
      progress: { type: "epub", href: "chapter2.xhtml", progression: 0.5 },
      percentage: 0.4,
    },
    () => {},
  );
  let finished = false;
  const flush = flushProgress().then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(update).toHaveBeenCalledOnce();
  expect(finished).toBe(false);
  acknowledge();
  await flush;
  expect(finished).toBe(true);
});
it("serializes in-flight progress writes so an older position cannot win", async () => {
  vi.useFakeTimers();
  let first!: () => void;
  update
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          first = resolve;
        }),
    )
    .mockResolvedValue({});
  const { scheduleProgress, flushProgress } = await import("./progress");
  scheduleProgress(
    "pdf",
    { progress: { type: "pdf", page: 1 }, percentage: 0.1 },
    () => {},
  );
  const a = flushProgress();
  await vi.advanceTimersByTimeAsync(0);
  scheduleProgress(
    "pdf",
    { progress: { type: "pdf", page: 2 }, percentage: 0.2 },
    () => {},
  );
  const b = flushProgress();
  await vi.advanceTimersByTimeAsync(0);
  expect(update).toHaveBeenCalledTimes(1);
  first();
  await Promise.all([a, b]);
  expect(update.mock.calls[1][1].progress.page).toBe(2);
});
it("never retries an older failed location after a newer save succeeds", async () => {
  vi.useFakeTimers();
  let rejectFirst!: (error: Error) => void;
  update
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    )
    .mockResolvedValue({});
  const { scheduleProgress, flushProgress } = await import("./progress");
  scheduleProgress(
    "pdf",
    { progress: { type: "pdf", page: 1 }, percentage: 0.1 },
    () => {},
  );
  const first = flushProgress().catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  scheduleProgress(
    "pdf",
    { progress: { type: "pdf", page: 2 }, percentage: 0.2 },
    () => {},
  );
  const second = flushProgress();
  rejectFirst(new Error("transient error"));
  await Promise.all([first, second]);
  expect(update.mock.calls.map((call) => call[1].progress.page)).toEqual([
    1, 2,
  ]);
});

it("keeps the latest position of every document when tabs change before the debounce", async () => {
  vi.useFakeTimers();
  update.mockResolvedValue({});
  const { scheduleProgress, flushProgress } = await import("./progress");
  scheduleProgress(
    "a",
    { progress: { type: "pdf", page: 2 }, percentage: 0.2 },
    () => {},
  );
  scheduleProgress(
    "b",
    { progress: { type: "epub", href: "ch3.xhtml" }, percentage: 0.3 },
    () => {},
  );
  scheduleProgress(
    "a",
    { progress: { type: "pdf", page: 5 }, percentage: 0.5 },
    () => {},
  );
  await flushProgress();
  expect(update.mock.calls.map(([id, patch]) => [id, patch.progress])).toEqual([
    ["a", { type: "pdf", page: 5 }],
    ["b", { type: "epub", href: "ch3.xhtml" }],
  ]);
});
it("saves other tabs even when one document fails and retries only its newest position", async () => {
  update.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
  const { scheduleProgress, flushProgress } = await import("./progress");
  scheduleProgress(
    "a",
    { progress: { type: "pdf", page: 2 }, percentage: 0.2 },
    () => {},
  );
  scheduleProgress(
    "b",
    { progress: { type: "pdf", page: 3 }, percentage: 0.3 },
    () => {},
  );
  await expect(flushProgress()).rejects.toThrow("offline");
  expect(update).toHaveBeenCalledTimes(2);
  scheduleProgress(
    "a",
    { progress: { type: "pdf", page: 4 }, percentage: 0.4 },
    () => {},
  );
  await flushProgress();
  expect(
    update.mock.calls.map(([id, patch]) => [id, patch.progress.page]),
  ).toEqual([
    ["a", 2],
    ["b", 3],
    ["a", 4],
  ]);
});

it("discards deleted documents without losing another tab's pending position", async () => {
  update.mockResolvedValue({});
  const { scheduleProgress, flushProgress, forgetProgress } =
    await import("./progress");
  scheduleProgress(
    "deleted",
    { progress: { type: "pdf", page: 2 }, percentage: 0.2 },
    () => {},
  );
  scheduleProgress(
    "kept",
    { progress: { type: "pdf", page: 3 }, percentage: 0.3 },
    () => {},
  );
  forgetProgress(["deleted"]);
  await flushProgress();
  expect(update.mock.calls.map(([id]) => id)).toEqual(["kept"]);
});
