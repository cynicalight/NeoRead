// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { WebSearchConfig } from "@neoread/core";
import { WebSearchSettings } from "./WebSearchSettings";

const value: WebSearchConfig = {
  provider: "deepseek",
  url: "https://search.example/v1",
  hasKey: true,
};
async function harness(
  save: (config: WebSearchConfig) => Promise<boolean>,
  initial = value,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <WebSearchSettings value={initial} disabled={false} onSave={save} />,
    ),
  );
  const choose = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.trim() === label,
    )!;
  const url = () => host.querySelector('input[id$="-url"]') as HTMLInputElement;
  const password = () =>
    host.querySelector("input[type=password]") as HTMLInputElement;
  const type = async (element: HTMLInputElement, text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(element, text);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const blur = async (element: HTMLInputElement) =>
    act(async () => {
      element.focus();
      element.blur();
    });
  const close = async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  };
  return { host, choose, url, password, type, blur, close };
}

it("saves a search provider change immediately without a Save button and preserves the masked key", async () => {
  const save = vi.fn(async () => true),
    h = await harness(save);
  try {
    expect(h.password().value).toBe("");
    expect(h.host.textContent).not.toContain("保存联网设置");
    await act(async () => h.choose("关闭").click());
    expect(save).toHaveBeenCalledExactlyOnceWith({
      ...value,
      provider: "",
    });
    expect(h.choose("关闭").getAttribute("aria-selected")).toBe("true");
  } finally {
    await h.close();
  }
});

it("rolls back a rejected toggle save and displays the failure", async () => {
  const save = vi.fn(async () => false),
    h = await harness(save);
  try {
    await act(async () => h.choose("关闭").click());
    expect(h.choose("DeepSeek").getAttribute("aria-selected")).toBe("true");
    expect(h.host.querySelector('[role="alert"]')?.textContent).toContain(
      "保存失败",
    );
  } finally {
    await h.close();
  }
});

it("auto-saves a changed address only with a replacement key, retains failed edits and removes a key immediately", async () => {
  const save = vi.fn(async () => false),
    h = await harness(save);
  try {
    await h.type(h.url(), "https://other.example");
    await h.blur(h.url());
    expect(save).not.toHaveBeenCalled();
    expect(h.host.textContent).toContain("填写此服务的 API Key 后自动保存");
    await h.type(h.password(), "replacement");
    await h.blur(h.password());
    expect(save).toHaveBeenLastCalledWith({
      ...value,
      url: "https://other.example",
      key: "replacement",
      hasKey: false,
    });
    expect(h.password().value).toBe("replacement");
    save.mockResolvedValue(true);
    await act(async () =>
      [...h.host.querySelectorAll("button")]
        .find((button) => button.textContent === "移除搜索密钥")!
        .click(),
    );
    expect(save).toHaveBeenLastCalledWith({
      ...value,
      provider: "",
      key: undefined,
      hasKey: false,
    });
  } finally {
    await h.close();
  }
});

it("switches to keyless Keenable without carrying a saved key to another address", async () => {
  const save = vi.fn(async () => true),
    h = await harness(save);
  try {
    await act(async () => h.choose("Keenable").click());
    expect(save).toHaveBeenLastCalledWith({
      ...value,
      provider: "keenable",
      url: "https://api.keenable.ai",
      hasKey: false,
    });
    expect(h.url()).toBeNull();
    expect(h.host.textContent).toContain("无需 API Key");
    await act(async () => h.choose("DeepSeek").click());
    expect(save).toHaveBeenLastCalledWith({
      ...value,
      provider: "deepseek",
      url: "https://api.deepseek.com",
      hasKey: false,
    });
  } finally {
    await h.close();
  }
});

it("does not save a DeepSeek key to Keenable while the provider switch is pending", async () => {
  const keenable: WebSearchConfig = {
    provider: "keenable",
    url: "https://api.keenable.ai",
    hasKey: false,
  };
  const pending: Array<(ok: boolean) => void> = [];
  const save = vi.fn(
      () => new Promise<boolean>((resolve) => pending.push(resolve)),
    ),
    h = await harness(save, keenable);
  try {
    await act(async () => h.choose("DeepSeek").click());
    expect(h.url().value).toBe("https://api.deepseek.com");
    await h.type(h.password(), "deepseek-key");
    await h.blur(h.password());
    await act(async () => pending.shift()!(true));
    await act(async () => pending.shift()!(true));
    expect(save).toHaveBeenLastCalledWith({
      provider: "deepseek",
      url: "https://api.deepseek.com",
      key: "deepseek-key",
      hasKey: false,
    });
  } finally {
    await h.close();
  }
});

it("keeps Keenable on when its optional key is removed", async () => {
  const keyed: WebSearchConfig = {
    provider: "keenable",
    url: "https://api.keenable.ai",
    hasKey: true,
  };
  const save = vi.fn(async () => true),
    h = await harness(save, keyed);
  try {
    await act(async () =>
      [...h.host.querySelectorAll("button")]
        .find((button) => button.textContent === "移除搜索密钥")!
        .click(),
    );
    expect(save).toHaveBeenCalledExactlyOnceWith({
      ...keyed,
      key: undefined,
      hasKey: false,
    });
    expect(h.choose("Keenable").getAttribute("aria-selected")).toBe("true");
  } finally {
    await h.close();
  }
});
