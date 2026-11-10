import { afterEach, expect, it, vi } from "vitest";
import type { ChatRun } from "@neoread/core";
import type { ChatStreamEvent } from "@neoread/api";
import { watchRunWithReconnect } from "./run-stream";
const run: ChatRun = {
  id: "run",
  sessionId: "session",
  documentId: "doc",
  userMessageId: "question",
  provider: "api",
  status: "running",
  startedAt: "now",
};
const prefix: ChatStreamEvent[] = [
  { event: "delta", data: { text: "first " } },
  {
    event: "tool",
    data: {
      id: "tool",
      kind: "web",
      tool: "web_fetch",
      title: "读取",
      status: "completed",
      startedAt: "now",
    },
  },
];
afterEach(() => vi.useRealTimers());
it("reattaches the same run and skips the replayed prefix without duplicate text or tools", async () => {
  vi.useFakeTimers();
  const emit = vi.fn();
  const watch = vi
    .fn()
    .mockImplementationOnce(async (_run, _signal, onEvent) => {
      prefix.forEach(onEvent);
      throw new Error("disconnected");
    })
    .mockImplementationOnce(async (_run, _signal, onEvent) => {
      prefix.forEach(onEvent);
      onEvent({ event: "delta", data: { text: "last" } });
      onEvent({ event: "done", data: { ok: true } });
    });
  const latest = vi.fn().mockResolvedValue(run);
  const completion = watchRunWithReconnect(
    run,
    new AbortController().signal,
    emit,
    watch,
    latest,
  );
  await vi.advanceTimersByTimeAsync(1000);
  await completion;
  expect(watch).toHaveBeenCalledTimes(2);
  expect(watch.mock.calls.map((call) => call[0].id)).toEqual(["run", "run"]);
  expect(
    emit.mock.calls
      .filter(([e]) => e.event === "delta")
      .map(([e]) => e.data.text)
      .join(""),
  ).toBe("first last");
  expect(emit.mock.calls.filter(([e]) => e.event === "tool")).toHaveLength(1);
});
it("cancels reconnect backoff and never attaches to another run or question", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const watch = vi.fn().mockRejectedValue(new Error("disconnected"));
  const latest = vi.fn().mockResolvedValue({ ...run, id: "other" });
  const result = watchRunWithReconnect(
    run,
    controller.signal,
    vi.fn(),
    watch,
    latest,
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  await result;
  await vi.advanceTimersByTimeAsync(10000);
  expect(watch).toHaveBeenCalledTimes(1);
  expect(latest).not.toHaveBeenCalled();
  const wrong = watchRunWithReconnect(
    run,
    new AbortController().signal,
    vi.fn(),
    watch,
    latest,
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await wrong).toBeInstanceOf(Error);
  expect(watch).toHaveBeenCalledTimes(2);
});
it("stops after bounded reconnect attempts and rejects divergent replay", async () => {
  vi.useFakeTimers();
  const latest = vi.fn().mockResolvedValue(run);
  const watch = vi.fn().mockRejectedValue(new Error("offline"));
  const result = watchRunWithReconnect(
    run,
    new AbortController().signal,
    vi.fn(),
    watch,
    latest,
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(7000);
  expect(await result).toBeInstanceOf(Error);
  expect(watch).toHaveBeenCalledTimes(4);
  const divergent = vi
    .fn()
    .mockImplementationOnce(async (_run, _signal, onEvent) => {
      onEvent(prefix[0]);
      throw new Error("drop");
    })
    .mockImplementationOnce(async (_run, _signal, onEvent) => {
      onEvent({ event: "delta", data: { text: "different" } });
    });
  const failed = watchRunWithReconnect(
    run,
    new AbortController().signal,
    vi.fn(),
    divergent,
    latest,
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await failed).toBeInstanceOf(Error);
  expect(divergent).toHaveBeenCalledTimes(2);
});
