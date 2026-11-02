// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { WebSearchConfig } from "@neoread/core";
import { WebSearchSettings } from "./WebSearchSettings";

const value: WebSearchConfig = {
  cliEnabled: false,
  provider: "deepseek",
  url: "https://search.example/v1",
  hasKey: true,
};
async function harness(save: (config: WebSearchConfig) => Promise<boolean>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <WebSearchSettings value={value} disabled={false} onSave={save} />,
    ),
  );
  const toggle = () => host.querySelector('[role="switch"]') as HTMLElement;
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
  return { host, toggle, url, password, type, blur, close };
}

it("saves a toggle click immediately without a Save button and preserves the masked key", async () => {
  const save = vi.fn(async () => true),
    h = await harness(save);
  try {
    expect(h.password().value).toBe("");
    expect(h.host.textContent).not.toContain("保存联网设置");
    await act(async () => h.toggle().click());
    expect(save).toHaveBeenCalledExactlyOnceWith({
      ...value,
      cliEnabled: true,
    });
    expect(h.toggle().getAttribute("aria-checked")).toBe("true");
  } finally {
    await h.close();
  }
});

it("rolls back a rejected toggle save and displays the failure", async () => {
  const save = vi.fn(async () => false),
    h = await harness(save);
  try {
    await act(async () => h.toggle().click());
    expect(h.toggle().getAttribute("aria-checked")).toBe("false");
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

it("serializes a blur and rapid toggles without losing permissions or a new key", async () => {
  const pending: Array<(result: boolean) => void> = [];
  const save = vi.fn(
    (_config: WebSearchConfig) =>
      new Promise<boolean>((resolve) => pending.push(resolve)),
  );
  const h = await harness(save);
  try {
    await act(async () => h.toggle().click());
    await h.type(h.password(), "new-key");
    await h.blur(h.password());
    await act(async () => h.toggle().click());
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => pending.shift()!(true));
    expect(save).toHaveBeenLastCalledWith({
      ...value,
      cliEnabled: true,
      key: "new-key",
      hasKey: false,
    });
    await act(async () => pending.shift()!(true));
    expect(save).toHaveBeenLastCalledWith({
      ...value,
      cliEnabled: false,
      key: undefined,
    });
    await act(async () => pending.shift()!(true));
    expect(h.toggle().getAttribute("aria-checked")).toBe("false");
    expect(h.password().value).toBe("");
    expect(h.host.querySelector('[aria-busy="true"]')).toBeNull();
  } finally {
    await h.close();
  }
});
