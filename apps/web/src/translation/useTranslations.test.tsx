// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { useTranslations } from "./useTranslations";
vi.mock("@neoread/api", () => ({ api: { translationStream: vi.fn() } }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
it("does not drive annotation refresh from chapter snapshots or translation events", async () => {
  let receive!: Parameters<typeof api.translationStream>[2];
  vi.mocked(api.translationStream).mockImplementation(
    async (_id, signal, callback) => {
      receive = callback;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
  const changed = vi.fn();
  window.addEventListener("neoread:annotations-changed", changed);
  function Fixture() {
    useTranslations("doc");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Fixture />));
    const data = {
      blockId: "p1-b1",
      sourceHash: "hash",
      status: "complete" as const,
      sentences: [],
    };
    await act(async () => receive({ event: "snapshot", data: [data] }));
    expect(changed).not.toHaveBeenCalled();
    await act(async () => receive({ event: "translation", data }));
    expect(changed).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    window.removeEventListener("neoread:annotations-changed", changed);
  }
});

it("replaces the subscription and drops old translations when the layout revision changes", async () => {
  const receivers: Parameters<typeof api.translationStream>[2][] = [];
  const signals: AbortSignal[] = [];
  vi.mocked(api.translationStream).mockReset();
  vi.mocked(api.translationStream).mockImplementation(
    async (_id, signal, callback) => {
      receivers.push(callback);
      signals.push(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
  let seen: string[] = [];
  function Fixture({ revision }: { revision: string }) {
    seen = useTranslations("doc", undefined, true, revision).translations.map(
      (t) => `${t.blockId}:${t.status}`,
    );
    return null;
  }
  const block = (status: "complete" | "pending") => ({
    blockId: "p1-b1",
    sourceHash: status,
    status,
    sentences: [],
  });
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Fixture revision="old" />));
    await act(async () =>
      receivers[0]({ event: "snapshot", data: [block("complete")] }),
    );
    expect(seen).toEqual(["p1-b1:complete"]);
    await act(async () => root.render(<Fixture revision="new" />));
    expect(seen).toEqual([]);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    await act(async () =>
      receivers[0]({ event: "translation", data: block("complete") }),
    );
    expect(seen).toEqual([]);
    await act(async () =>
      receivers[1]({ event: "snapshot", data: [block("pending")] }),
    );
    expect(seen).toEqual(["p1-b1:pending"]);
  } finally {
    await act(async () => root.unmount());
  }
});
