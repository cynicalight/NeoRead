// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { useAnnotationUpdates } from "./useAnnotationUpdates";
import { useTranslations } from "./translation/useTranslations";

vi.mock("@neoread/api", () => ({
  api: {
    annotationStream: vi.fn(),
    translationStream: vi.fn(),
    annotations: vi.fn(async () => []),
  },
  reportDiagnostic: vi.fn(),
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps connection slots available across three retained tabs and refreshes on return", async () => {
  vi.useFakeTimers();
  const connections: {
    id: string;
    signal: AbortSignal;
    receive: (value: any) => void;
    kind: string;
  }[] = [];
  for (const [kind, mock] of [
    ["annotation", api.annotationStream],
    ["translation", api.translationStream],
  ] as const) {
    vi.mocked(mock).mockImplementation(
      (id, signal, receive) =>
        new Promise<void>((resolve) => {
          connections.push({ id, signal, receive, kind });
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
  }
  const updates = vi.fn();
  function Tab({ id, active }: { id: string; active: boolean }) {
    useAnnotationUpdates(
      id,
      (items) => updates(id, items),
      () => {},
      active,
    );
    const { translations } = useTranslations(id, undefined, active);
    return (
      <span data-id={id}>
        {translations.map((item) => item.sourceHash).join(",")}
      </span>
    );
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = async (active: string, ids: string[]) =>
    act(async () =>
      root.render(
        <>
          {ids.map((id) => (
            <Tab key={id} id={id} active={active === id} />
          ))}
        </>,
      ),
    );
  const live = () => connections.filter((c) => !c.signal.aborted);
  const snapshot = (sourceHash: string) => ({
    event: "snapshot",
    data: [{ blockId: "b", sourceHash, status: "complete", sentences: [] }],
  });
  try {
    await render("a", ["a"]);
    await act(async () =>
      live()
        .find((c) => c.kind === "translation")!
        .receive(snapshot("old")),
    );
    await render("b", ["a", "b"]);
    await render("c", ["a", "b", "c"]);
    // Six HTTP/1.1 streams would leave no slot for the third document's file/layout requests.
    expect(live().length).toBeLessThan(6);
    expect(live().map((c) => c.id)).toEqual(["c", "c"]);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(live()).toHaveLength(2);
    expect(host.querySelector('[data-id="a"]')!.textContent).toBe("old");
    await render("a", ["a", "b", "c"]);
    expect(live().map((c) => c.id)).toEqual(["a", "a"]);
    await act(async () => {
      live()
        .find((c) => c.kind === "translation")!
        .receive(snapshot("current"));
      // A late callback from the cancelled stream must not overwrite resumed data.
      connections
        .find((c) => c.id === "a" && c.kind === "translation")!
        .receive(snapshot("stale"));
      live()
        .find((c) => c.kind === "annotation")!
        .receive("changed-while-hidden");
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(host.querySelector('[data-id="a"]')!.textContent).toBe("current");
    expect(updates).toHaveBeenLastCalledWith("a", []);
  } finally {
    await act(async () => root.unmount());
    expect(live()).toHaveLength(0);
    vi.useRealTimers();
    vi.clearAllMocks();
  }
});

it("cancels queued reconnects when a tab is hidden and waits until reactivation", async () => {
  vi.useFakeTimers();
  vi.mocked(api.annotationStream).mockRejectedValue(new Error("offline"));
  vi.mocked(api.translationStream).mockRejectedValue(new Error("offline"));
  const reset = vi.fn();
  function Tab({ active }: { active: boolean }) {
    useAnnotationUpdates("a", () => {}, reset, active);
    useTranslations("a", ["chapter.xhtml"], active);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Tab active={false} />));
    expect(api.annotationStream).not.toHaveBeenCalled();
    expect(api.translationStream).not.toHaveBeenCalled();
    await act(async () => root.render(<Tab active />));
    expect(api.annotationStream).toHaveBeenCalledTimes(1);
    expect(api.translationStream).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Tab active={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.annotationStream).toHaveBeenCalledTimes(1);
    expect(api.translationStream).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Tab active />));
    expect(api.annotationStream).toHaveBeenCalledTimes(2);
    expect(api.translationStream).toHaveBeenLastCalledWith(
      "a",
      expect.any(AbortSignal),
      expect.any(Function),
      ["chapter.xhtml"],
    );
    expect(reset).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.clearAllMocks();
  }
});
