// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { openExternalLink } from "./reading-links";
import { PiConnectionPanel } from "./PiConnectionPanel";

vi.mock("@neoread/api", () => ({
  api: {
    connectPiProvider: vi.fn(),
    submitPiLoginInput: vi.fn(),
    disconnectPiProvider: vi.fn(),
  },
}));
vi.mock("./reading-links", () => ({ openExternalLink: vi.fn() }));

type Emit = Parameters<typeof api.connectPiProvider>[2];
type Login = {
  signal: AbortSignal;
  emit: Emit;
  finish: () => void;
  fail: (error: Error) => void;
};

let host: HTMLDivElement;
let root: Root;
let logins: Login[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  logins = [];
  vi.mocked(api.connectPiProvider).mockImplementation(
    (_provider, signal, emit) =>
      new Promise<void>((finish, fail) =>
        logins.push({ signal, emit, finish, fail }),
      ),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const render = async (
  props: { connected?: boolean; autoConnect?: boolean } = {},
) => {
  const onChange = vi.fn();
  const onBack = vi.fn();
  await act(async () =>
    root.render(
      <StrictMode>
        <PiConnectionPanel
          provider="claude"
          connected={props.connected ?? false}
          autoConnect={props.autoConnect ?? true}
          onBack={onBack}
          onChange={onChange}
        />
      </StrictMode>,
    ),
  );
  await act(async () => vi.runAllTimers());
  return { onChange, onBack };
};
const button = (label: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === label,
  );

it("starts one browser login on entry and closes itself once connected", async () => {
  const { onChange, onBack } = await render();
  expect(api.connectPiProvider).toHaveBeenCalledTimes(1);
  const [login] = logins;
  const url = "https://claude.ai/oauth/authorize?state=1";
  await act(async () => {
    login.emit({ type: "auth_url", url });
    login.emit({ type: "auth_url", url });
  });
  expect(openExternalLink).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "请在浏览器中完成授权",
  );
  // Progress sits outside the actions; only the reopen and cancel remain.
  expect(button("重新打开授权页面")).toBeDefined();
  expect(button("取消")).toBeDefined();
  // Nothing asks the user to paste a code or callback.
  expect(host.querySelector("input")).toBeNull();

  await act(async () =>
    login.emit({ type: "progress", phase: "exchanging" }),
  );
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "正在完成连接",
  );
  expect(button("重新打开授权页面")).toBeUndefined();
  expect(onChange).not.toHaveBeenCalled();

  await act(async () => login.finish());
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onBack).toHaveBeenCalledTimes(1);
});

it("does not start a login for a connected provider", async () => {
  await render({ connected: true, autoConnect: false });
  expect(api.connectPiProvider).not.toHaveBeenCalled();
  expect(button("重新登录")).toBeDefined();
  expect(button("断开连接")).toBeDefined();
});

it("ignores a cancelled login and does not restart it", async () => {
  const { onChange, onBack } = await render();
  const [login] = logins;
  await act(async () => button("取消")!.click());
  expect(login.signal.aborted).toBe(true);
  await act(async () => {
    login.emit({ type: "auth_url", url: "https://claude.ai/oauth/late" });
    login.finish();
  });
  await act(async () => vi.runAllTimers());
  expect(openExternalLink).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
  expect(onBack).not.toHaveBeenCalled();
  expect(api.connectPiProvider).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("已取消登录");

  await act(async () => button("重新登录")!.click());
  expect(api.connectPiProvider).toHaveBeenCalledTimes(2);
});

it("shows a failure with retry and aborts the login on close", async () => {
  await render();
  await act(async () => logins[0].fail(new Error("授权被拒绝")));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "授权被拒绝",
  );
  await act(async () => button("重新登录")!.click());
  const retry = logins[1];
  act(() => root.unmount());
  expect(retry.signal.aborted).toBe(true);
  root = createRoot(host);
});
