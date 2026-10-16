// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReaderSelection } from "@reader/core";
import { api } from "@reader/api";
import { SelectionTranslation } from "./SelectionTranslation";
vi.mock("@reader/api", () => ({ api: { translateSelection: vi.fn() } }));
const first: ReaderSelection = {
  text: "one",
  context: { before: "before", after: "after" },
  location: { type: "pdf", page: 1 },
  anchor: { x: 100, top: 80, bottom: 100 },
};
const second = { ...first, text: "two" };
let root: Root, host: HTMLDivElement;
const close = vi.fn();
const render = async (selection: ReaderSelection | null) => {
  await act(async () =>
    root.render(<SelectionTranslation selection={selection} onClose={close} />),
  );
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(api.translateSelection).mockReset();
  close.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("cancels replaced and closed requests and ignores late results", async () => {
  const pending: ((value: { text: string }) => void)[] = [];
  vi.mocked(api.translateSelection).mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  await render(first);
  expect(api.translateSelection).toHaveBeenCalledWith(
    first,
    expect.any(AbortSignal),
  );
  await render(second);
  expect(vi.mocked(api.translateSelection).mock.calls[0][1].aborted).toBe(true);
  await act(async () => pending[0]({ text: "旧结果" }));
  expect(document.body.textContent).not.toContain("旧结果");
  await act(async () => pending[1]({ text: "新结果" }));
  expect(document.body.textContent).toContain("新结果");
  await render(null);
  expect(vi.mocked(api.translateSelection).mock.calls[1][1].aborted).toBe(true);
});
it("shows failures and closes on scroll without action buttons", async () => {
  vi.mocked(api.translateSelection).mockRejectedValueOnce(
    new Error("模型不可用"),
  );
  await render(first);
  expect(document.body.textContent).toContain("模型不可用");
  expect(
    document.querySelector("[data-selection-translation] button"),
  ).toBeNull();
  expect(api.translateSelection).toHaveBeenCalledTimes(1);
  await act(async () => window.dispatchEvent(new Event("scroll")));
  expect(close).toHaveBeenCalledOnce();
});
