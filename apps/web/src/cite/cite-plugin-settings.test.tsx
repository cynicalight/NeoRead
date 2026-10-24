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
