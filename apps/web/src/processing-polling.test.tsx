// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Processing } from "@neoread/core";
import { api } from "@neoread/api";
import { useProcessing } from "./ProcessingStatus";

vi.mock("@neoread/api", () => ({ api: { processing: vi.fn() } }));

it("keeps unchanged job snapshots stable across polling and shares unaffected document jobs", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let data = [
    { documentId: "a", phase: "ready", status: "complete" },
    { documentId: "b", phase: "ready", status: "complete" },
  ] as Processing[];
  vi.mocked(api.processing).mockImplementation(async () =>
    structuredClone(data),
  );
  let latest: Processing[] = [];
  function Consumer() {
    latest = useProcessing().jobs;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Consumer />));
    const original = latest;
    await act(async () => vi.advanceTimersByTimeAsync(2400));
    expect(api.processing).toHaveBeenCalledTimes(3);
    expect(latest).toBe(original);
    data = [{ ...data[0], status: "running" }, data[1]];
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(latest).not.toBe(original);
    expect(latest[0].status).toBe("running");
    expect(latest[1]).toBe(original[1]);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
