// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProxySettingsState, ProxyCheckResult } from "@neoread/core";
import { ProxySettings } from "./ProxySettings";

let host: HTMLDivElement;
let root: Root;
let state: ProxySettingsState;
const get = vi.fn();
const save = vi.fn();
const check = vi.fn();
const restart = vi.fn();
const input = (label: string) =>
  host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const button = (label: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (element) => element.textContent === label,
  )!;
const click = async (label: string) => act(async () => button(label).click());
const type = async (label: string, value: string) =>
  act(async () => {
    const element = input(label);
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
const render = async (open = true) =>
  act(async () => root.render(<ProxySettings open={open} />));
const chooseMode = async (label: string) => {
  await act(async () =>
    (
      host.querySelector(
        '[aria-labelledby="proxy-mode-label"]',
      ) as HTMLButtonElement
    ).click(),
  );
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (element) => element.textContent === label,
  ) as HTMLElement;
  expect(option).toBeDefined();
  await act(async () => {
    option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    option.click();
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  state = {
    settings: { mode: "manual", host: "127.0.0.1", port: 7890 },
    restartRequired: false,
  };
  get.mockImplementation(async () => state);
  save.mockImplementation(async (settings) => ({
    settings,
    restartRequired: true,
  }));
  check.mockResolvedValue({
    connected: true,
    route: "proxy",
    status: 403,
    elapsedMs: 18,
  });
  restart.mockResolvedValue(undefined);
  window.neoreadDesktop = {
    platform: "win32",
    proxySettings: get,
    saveProxySettings: save,
    checkProxy: check,
    restart,
    checkForUpdates: vi.fn(),
    writeClipboardText: vi.fn(),
    writeClipboardImage: vi.fn(),
    setAppearance: vi.fn(),
    importFiles: vi.fn(),
    importLargePapers: vi.fn(),
    showDocumentFile: vi.fn(),
    openDocumentFile: vi.fn(),
    openExternal: vi.fn(),
    onBeforeClose: vi.fn(),
    onLibraryChanged: vi.fn(),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.neoreadDesktop;
  vi.unstubAllGlobals();
});

it("checks ChatGPT with the unsaved draft without calling save", async () => {
  await render();
  expect(host.textContent).toContain("chatgpt.com/robots.txt");
  expect(input("检测地址")).toBeNull();
  await type("代理端口", "7897");
  await click("检测连接");
  expect(check).toHaveBeenCalledWith({
    mode: "manual",
    host: "127.0.0.1",
    port: 7897,
  });
  expect(save).not.toHaveBeenCalled();
  expect(host.textContent).toContain("HTTP 403 · 18 ms · 经代理");
  expect(host.textContent).toContain("不代表 ChatGPT");
  await type("代理端口", "7898");
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("shows restart only after successful persistence and never restarts automatically", async () => {
  await render();
  expect(button("保存代理设置").disabled).toBe(true);
  await type("代理端口", "7897");
  await click("保存代理设置");
  expect(save).toHaveBeenCalledWith({
    mode: "manual",
    host: "127.0.0.1",
    port: 7897,
  });
  expect(host.textContent).toContain("代理配置已变化，重启 NeoRead 后生效。");
  expect(restart).not.toHaveBeenCalled();
  await click("重启 NeoRead");
  expect(restart).toHaveBeenCalledOnce();
});

it("reloads a completed save after closing and reopening settings", async () => {
  let finish!: () => void;
  let pendingSave: Promise<ProxySettingsState> | undefined;
  save.mockImplementationOnce((settings) => {
    pendingSave = new Promise((resolve) => {
      finish = () => {
        state = { settings, restartRequired: true };
        resolve(state);
      };
    });
    return pendingSave;
  });
  // The desktop state getter waits for queued persistence before returning.
  get.mockImplementation(async () => {
    await pendingSave;
    return state;
  });
  await render();
  await type("代理端口", "7897");
  await click("保存代理设置");
  await render(false);
  await render();
  expect(button("检测连接").disabled).toBe(true);
  await act(async () => finish());
  expect(input("代理端口").value).toBe("7897");
  expect(button("重启 NeoRead")).toBeDefined();
});

it("offers restart in system mode and tests the active configuration", async () => {
  state = { settings: { mode: "system" }, restartRequired: false };
  await render();
  expect(host.textContent).toContain("切换系统代理后，请重启 NeoRead 再检测。");
  expect(button("重启 NeoRead").disabled).toBe(false);
  await click("重启 NeoRead");
  expect(restart).toHaveBeenCalledOnce();
});

it.each([
  ["proxy", "经代理", 12001, "连接超时"],
  ["proxy", "经代理", 4, "连接失败"],
  ["direct", "直连", 16, "无法解析目标地址"],
  ["proxy", "经代理", 90, "TLS 证书验证失败"],
  ["proxy", "经代理", 3, "代理要求身份认证"],
  ["unknown", "路由未知", 5, "无法完成连接检测"],
])(
  "shows route and duration for a failed %s probe: %s",
  async (route, label, elapsedMs, message) => {
    check.mockResolvedValueOnce({
      connected: false,
      route,
      elapsedMs,
      message,
    });
    await render();
    await click("检测连接");
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      `${message} · ${elapsedMs} ms · ${label}`,
    );
  },
);

it("keeps unsaved fields and allows retry when saving fails", async () => {
  await render();
  save.mockRejectedValueOnce(new Error("无法保存代理设置"));
  await type("代理端口", "7897");
  await click("保存代理设置");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "无法保存代理设置",
  );
  expect(input("代理端口").value).toBe("7897");
  expect(button("保存代理设置").disabled).toBe(false);
  expect(button("重启 NeoRead")).toBeUndefined();
  await click("保存代理设置");
  expect(button("重启 NeoRead")).toBeDefined();
});

it("rejects a nonnumeric port before calling the desktop", async () => {
  await render();
  await type("代理端口", "7e3");
  await click("检测连接");
  expect(check).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("整数");
});

it("prevents concurrent checks and drops results from an earlier settings session", async () => {
  let complete!: (result: ProxyCheckResult) => void;
  check.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  await click("检测连接");
  expect(button("检测连接").disabled).toBe(true);
  expect(input("代理端口").disabled).toBe(true);
  await render(false);
  await render();
  await act(async () =>
    complete({
      connected: true,
      route: "proxy",
      status: 200,
      elapsedMs: 2,
    }),
  );
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("shows system-reading warnings in settings and is absent in the web app", async () => {
  state = {
    settings: { mode: "system" },
    restartRequired: false,
    warning: "无法读取系统代理",
  };
  await render();
  expect(host.textContent).toContain("无法读取系统代理");
  delete window.neoreadDesktop;
  await render();
  expect(host.textContent).toBe("");
});

it("switches between system, manual and direct modes using the real select", async () => {
  state = { settings: { mode: "system" }, restartRequired: false };
  await render();
  expect(input("代理地址")).toBeNull();
  await chooseMode("手动 HTTP 代理");
  expect(input("代理地址").value).toBe("127.0.0.1");
  expect(input("代理端口").value).toBe("7890");
  await chooseMode("直连");
  await click("保存代理设置");
  expect(save).toHaveBeenLastCalledWith({ mode: "direct" });
});
