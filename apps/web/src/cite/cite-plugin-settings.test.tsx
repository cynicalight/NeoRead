// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { CitePluginSettings } from "./CitePluginSettings";
import type { CitePluginStatus } from "./plugins";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const word: CitePluginStatus = {
  kind: "word",
  supported: true,
  detected: true,
  available: true,
  installed: false,
};
const wps: CitePluginStatus = {
  kind: "wps",
  supported: false,
  detected: false,
  available: true,
  installed: false,
};

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as { neoreadDesktop?: unknown }).neoreadDesktop;
});
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label);

it("installs the Word plugin and reports unsupported WPS", async () => {
  const install = vi.fn(async () => [{ ...word, installed: true }, wps]);
  window.neoreadDesktop = {
    citePlugins: async () => [word, wps],
    installCitePlugin: install,
  } as unknown as typeof window.neoreadDesktop;
  await act(async () => root.render(<CitePluginSettings open />));
  expect(host.textContent).toContain("安装前请先退出 Word。");
  expect(host.textContent).toContain("当前系统暂不支持。");
  await act(async () => button("安装")!.click());
  expect(install).toHaveBeenCalledWith("word");
  expect(button("重新安装")).toBeDefined();
  expect(button("卸载")).toBeDefined();
  expect(toast.success).toHaveBeenCalled();
});

it("shows install failures", async () => {
  window.neoreadDesktop = {
    citePlugins: async () => [word, wps],
    installCitePlugin: async () => {
      throw new Error("Word 正在使用插件，请先退出 Word 再安装");
    },
  } as unknown as typeof window.neoreadDesktop;
  await act(async () => root.render(<CitePluginSettings open />));
  await act(async () => button("安装")!.click());
  expect(toast.error).toHaveBeenCalledWith(
    "Word 正在使用插件，请先退出 Word 再安装",
  );
});

it("renders nothing outside the desktop app", async () => {
  await act(async () => root.render(<CitePluginSettings open />));
  expect(host.innerHTML).toBe("");
});

it("keeps the plugin section visible when detection fails and allows retry", async () => {
  let complete!: (plugins: CitePluginStatus[]) => void;
  const query = vi
    .fn()
    .mockRejectedValueOnce(new Error("Word 启动目录配置无效"))
    .mockImplementationOnce(
      () =>
        new Promise<CitePluginStatus[]>((resolve) => {
          complete = resolve;
        }),
    );
  window.neoreadDesktop = {
    citePlugins: query,
  } as unknown as typeof window.neoreadDesktop;
  await act(async () => root.render(<CitePluginSettings open />));
  expect(host.textContent).toContain("引用插件");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Word 启动目录配置无效",
  );
  expect(button("安装")).toBeUndefined();
  await act(async () => button("重试")!.click());
  expect(host.textContent).toContain("正在检测");
  expect(query).toHaveBeenCalledTimes(2);
  await act(async () => complete([word, wps]));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(button("安装")).toBeDefined();
});

it("ignores an old detection failure after settings reopen", async () => {
  let reject!: (error: Error) => void;
  const query = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValueOnce([word, wps]);
  window.neoreadDesktop = {
    citePlugins: query,
  } as unknown as typeof window.neoreadDesktop;
  await act(async () => root.render(<CitePluginSettings open />));
  expect(host.textContent).toContain("引用插件");
  await act(async () => root.render(<CitePluginSettings open={false} />));
  await act(async () => root.render(<CitePluginSettings open />));
  await act(async () => reject(new Error("stale failure")));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(button("安装")).toBeDefined();
});

it("allows macOS Word access authorization and retries detection", async () => {
  const query = vi
    .fn()
    .mockRejectedValueOnce(new Error("WORD_ACCESS_REQUIRED:访问被拒绝"))
    .mockResolvedValueOnce([word, wps]);
  const authorize = vi.fn(async () => {});
  window.neoreadDesktop = {
    platform: "darwin",
    citePlugins: query,
    authorizeWordPluginAccess: authorize,
  } as unknown as typeof window.neoreadDesktop;
  await act(async () => root.render(<CitePluginSettings open />));
  expect(button("授权访问")).toBeDefined();
  await act(async () => button("授权访问")!.click());
  expect(authorize).toHaveBeenCalledOnce();
  expect(query).toHaveBeenCalledTimes(2);
  expect(button("安装")).toBeDefined();
});
