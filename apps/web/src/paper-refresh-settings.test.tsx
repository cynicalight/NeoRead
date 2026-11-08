// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { api, type PaperRefreshProgress } from "@neoread/api";
import { PaperRefreshSettings } from "./PaperRefreshSettings";
vi.mock("@neoread/api", () => ({
  api: { paperRefreshStatus: vi.fn(), startPaperRefresh: vi.fn() },
}));
vi.mock("./store", () => ({
  refreshLibrary: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@neoread/ui/components/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
const idle: PaperRefreshProgress = {
  status: "idle",
  total: 0,
  processed: 0,
  failed: 0,
  skipped: 0,
};
const done: PaperRefreshProgress = { ...idle, status: "done" };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  root = createRoot(host);
  let progress = idle;
  vi.mocked(api.paperRefreshStatus)
    .mockReset()
    .mockImplementation(async () => progress);
  vi.mocked(api.startPaperRefresh)
    .mockReset()
    .mockImplementation(async () => {
      progress = done;
      return progress;
    });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const mount = () => act(async () => root.render(<PaperRefreshSettings open />));
const start = () => act(async () => host.querySelector("button")!.click());
it("keeps completed state across later polls", async () => {
  await mount();
  await start();
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(api.paperRefreshStatus).toHaveBeenCalledTimes(4);
  expect(host.textContent).toContain("处理完成：0/0 篇");
});
it.each([false, true])(
  "ignores a stale poll after starting, rejected=%s",
  async (rejected) => {
    await mount();
    let resolve!: (value: PaperRefreshProgress) => void,
      reject!: (error: Error) => void;
    vi.mocked(api.paperRefreshStatus).mockImplementationOnce(
      () =>
        new Promise<PaperRefreshProgress>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await start();
    await act(async () => {
      if (rejected) reject(new Error("old poll"));
      else resolve(idle);
    });
    expect(host.textContent).toContain("处理完成：0/0 篇");
    expect(host.textContent).not.toContain("无法读取");
  },
);
it("pauses polling while start is pending and resumes after it fails", async () => {
  await mount();
  let reject!: (error: Error) => void;
  vi.mocked(api.startPaperRefresh).mockImplementationOnce(
    () =>
      new Promise<PaperRefreshProgress>((_, no) => {
        reject = no;
      }),
  );
  await start();
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(api.paperRefreshStatus).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("failed start")));
  expect(host.textContent).toContain("无法启动");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(api.paperRefreshStatus).toHaveBeenCalledTimes(2);
  expect(host.querySelector("button")!.disabled).toBe(false);
});
it("does not overlap polls or apply a response from a closed view", async () => {
  await mount();
  let resolve!: (value: PaperRefreshProgress) => void;
  vi.mocked(api.paperRefreshStatus).mockImplementationOnce(
    () =>
      new Promise<PaperRefreshProgress>((yes) => {
        resolve = yes;
      }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(api.paperRefreshStatus).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<PaperRefreshSettings open={false} />));
  vi.mocked(api.paperRefreshStatus).mockResolvedValue(done);
  await mount();
  await act(async () => resolve(idle));
  expect(host.textContent).toContain("处理完成：0/0 篇");
});
it("ignores a start result from a previous open cycle", async () => {
  await mount();
  let resolve!: (value: PaperRefreshProgress) => void;
  vi.mocked(api.startPaperRefresh).mockImplementationOnce(
    () =>
      new Promise<PaperRefreshProgress>((yes) => {
        resolve = yes;
      }),
  );
  await start();
  await act(async () => root.render(<PaperRefreshSettings open={false} />));
  await mount();
  await act(async () => resolve(done));
  expect(host.textContent).not.toContain("处理完成");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(api.paperRefreshStatus).toHaveBeenCalledTimes(2);
  expect(host.querySelector("button")!.disabled).toBe(false);
});
