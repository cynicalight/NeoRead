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

it("keeps only the visible tab's passive streams open even after six documents have been visited", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const signals: AbortSignal[] = [];
  const subscribe = (_id: string, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      signals.push(signal);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  vi.mocked(api.annotationStream).mockImplementation(subscribe);
  vi.mocked(api.translationStream).mockImplementation(subscribe);
  function Tab({ id, active }: { id: string; active: boolean }) {
    useAnnotationUpdates(
      id,
      () => {},
      () => {},
      active,
    );
    useTranslations(id, undefined, active);
    return null;
  }
  function Tabs({ active }: { active: number }) {
    return Array.from({ length: 6 }, (_, index) => (
      <Tab key={index} id={String(index)} active={index === active} />
    ));
  }
  const root = createRoot(document.createElement("div"));
  try {
    for (const index of [0, 1, 2, 3, 4, 5, 0]) {
      await act(async () => root.render(<Tabs active={index} />));
      expect(signals.filter((signal) => !signal.aborted)).toHaveLength(2);
    }
    expect(api.annotationStream).toHaveBeenCalledTimes(7);
    expect(api.translationStream).toHaveBeenCalledTimes(7);
  } finally {
    await act(async () => root.unmount());
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    vi.unstubAllGlobals();
  }
});
