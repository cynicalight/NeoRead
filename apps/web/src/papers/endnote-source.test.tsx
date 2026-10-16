// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { EndNoteSourcePicker } from "./EndNoteSourcePicker";
let root: Root, host: HTMLDivElement;
const confirm = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  confirm.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.readerDesktop;
  vi.useRealTimers();
});
async function render(search: ReturnType<typeof vi.fn>) {
  window.readerDesktop = {
    findEndNoteLibraries: search,
    cancelEndNoteSearch: vi.fn(async () => {}),
  } as unknown as Window["readerDesktop"];
  await act(async () =>
    root.render(<EndNoteSourcePicker busy={false} onConfirm={confirm} />),
  );
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  )!;
}
it("stops after ten seconds and ignores late candidates without replacing manual input", async () => {
  let resolve!: (v: unknown) => void;
  await render(
    vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
  );
  await act(async () => vi.advanceTimersByTime(9999));
  expect(host.textContent).toContain("正在搜索");
  await act(async () => vi.advanceTimersByTime(1));
  expect(host.textContent).toContain("未找到 EndNote");
  const input = host.querySelector<HTMLInputElement>("#endnote-path")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "/manual/My.enl");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    resolve({
      candidates: [{ name: "late.enl", path: "/late.enl" }],
      timedOut: false,
    }),
  );
  expect(input.value).toBe("/manual/My.enl");
  expect(host.textContent).not.toContain("late.enl");
  expect(window.readerDesktop!.cancelEndNoteSearch).toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});
it("requires explicit confirmation of an automatically found library", async () => {
  await render(
    vi.fn(async () => ({
      candidates: [{ name: "Mine.enl", path: "/docs/Mine.enl" }],
      timedOut: false,
    })),
  );
  expect(host.textContent).toContain("/docs/Mine.enl");
  expect(confirm).not.toHaveBeenCalled();
  await act(async () => button("使用这个文献库").click());
  expect(confirm).toHaveBeenCalledWith("/docs/Mine.enl");
});
it("manual selection cancels searching and prevents later errors from changing the form", async () => {
  let reject!: (e: Error) => void;
  await render(
    vi.fn(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    ),
  );
  await act(async () => button("手动选择位置").click());
  await act(async () => {
    reject(new Error("late"));
    vi.advanceTimersByTime(10000);
  });
  expect(host.querySelector("#endnote-path")).not.toBeNull();
  expect(host.textContent).not.toContain("无法自动搜索");
});
it("multiple candidates are not silently selected", async () => {
  await render(
    vi.fn(async () => ({
      candidates: [
        { name: "A.enl", path: "/a/A.enl" },
        { name: "B.enl", path: "/b/B.enl" },
      ],
      timedOut: false,
    })),
  );
  expect(button("使用这个文献库").disabled).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
});
