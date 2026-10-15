// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import type { AIConfig, AgentModel } from "@reader/core";
import { ModelSelector, selectedAgentModel } from "./ModelSelector";
import { useReaderStore } from "./store";
vi.mock("@reader/api", () => ({
  api: { agentModels: vi.fn(), aiConfig: vi.fn(), saveAIConfig: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
// Branding has its own tests. Keep model interactions independent of Lobe's
// avatar style runtime, while exercising the real Base UI popover/select/slider.
vi.mock("./ProviderIdentity", () => ({ ProviderIcon: () => <span /> }));
const models: AgentModel[] = [
  {
    id: "model-a",
    name: "Model A",
    description: "First model",
    isDefault: true,
    aliases: ["fast"],
  },
  {
    id: "model-b",
    name: "Model B",
    description: "Second model",
    isDefault: false,
  },
];
let root: Root;
let host: HTMLDivElement;
let config: AIConfig;
const onSettings = vi.fn();
async function render() {
  await act(async () =>
    root.render(<ModelSelector disabled={false} onSettings={onSettings} />),
  );
}
async function open() {
  if (!document.querySelector(".effort-panel")) {
    await act(async () =>
      (
        host.querySelector(
          '[aria-label="选择模型和 Effort"]',
        ) as HTMLButtonElement
      ).click(),
    );
  }
  await act(async () =>
    (
      document.querySelector('[aria-label="选择模型"]') as HTMLButtonElement
    ).click(),
  );
}
async function chooseB() {
  await open();
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (item) => item.textContent?.includes("Model B"),
  )!;
  expect(option).toBeDefined();
  await act(async () => {
    option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    (option as HTMLElement).click();
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  config = {
    primary: "codex",
    models: { codex: "model-a", claude: "sonnet" },
    capabilities: {},
    api: { url: "", model: "", hasKey: false },
    textAPI: { url: "", model: "", hasKey: false },
    imageAPI: { url: "", model: "", hasKey: false },
  };
  useReaderStore.setState({ aiConfig: config, aiModelSaving: false });
  vi.mocked(api.agentModels).mockResolvedValue(models);
  vi.mocked(api.aiConfig).mockImplementation(async () => config);
  vi.mocked(api.saveAIConfig).mockImplementation(async (value) => value);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("saves the selected model while preserving the latest SDK and API configuration", async () => {
  await render();
  config = {
    ...config,
    textAPI: {
      url: "https://example.test/v1",
      model: "external-model",
      hasKey: true,
    },
  };
  await chooseB();
  expect(api.saveAIConfig).toHaveBeenCalledWith({
    ...config,
    models: { ...config.models, codex: "model-b" },
  });
  expect(host.querySelector(".model-trigger-name")?.textContent).toBe(
    "Model B",
  );
  expect(useReaderStore.getState().aiModelSaving).toBe(false);
});
it("keeps the previous model after a failed save", async () => {
  vi.mocked(api.saveAIConfig).mockRejectedValue(new Error("save failed"));
  await render();
  await chooseB();
  expect(host.querySelector(".model-trigger-name")?.textContent).toBe(
    "Model A",
  );
  expect(useReaderStore.getState().aiConfig?.models.codex).toBe("model-a");
  expect(useReaderStore.getState().aiModelSaving).toBe(false);
});
it("rejects a model save when the SDK changed elsewhere", async () => {
  await render();
  config = { ...config, primary: "claude" };
  await chooseB();
  expect(api.saveAIConfig).not.toHaveBeenCalled();
  expect(useReaderStore.getState().aiConfig?.primary).toBe("claude");
});
it("does not replace the new SDK catalog with a late response", async () => {
  let finish!: (value: AgentModel[]) => void;
  vi.mocked(api.agentModels).mockImplementation((provider) =>
    provider === "codex"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve([
          { id: "sonnet", name: "Sonnet", description: "", isDefault: true },
        ]),
  );
  await render();
  const signal = vi.mocked(api.agentModels).mock.calls[0]![1]!;
  await act(async () =>
    useReaderStore.getState().setAIConfig({ ...config, primary: "claude" }),
  );
  await act(async () => finish(models));
  expect(signal.aborted).toBe(true);
  expect(host.querySelector(".model-trigger-name")?.textContent).toBe("Sonnet");
});
it("resolves aliases and preserves custom model IDs", () => {
  expect(selectedAgentModel(models, "fast")?.id).toBe("model-a");
  expect(selectedAgentModel(models, "custom-model")?.id).toBe("custom-model");
  expect(selectedAgentModel(models, "")?.id).toBe("model-a");
  const recommended = [
    models[0]!,
    { ...models[1]!, recommendedFor: ["chat" as const] },
  ];
  expect(selectedAgentModel(recommended, "")?.id).toBe("model-b");
  expect(selectedAgentModel(recommended, "", "translation")?.id).toBe(
    "model-a",
  );
});

async function openEffort() {
  await act(async () =>
    (
      host.querySelector(
        '[aria-label="选择模型和 Effort"]',
      ) as HTMLButtonElement
    ).click(),
  );
}
async function effortKey(key: string) {
  const slider = document.querySelector('input[type="range"]')!;
  await act(async () => {
    slider.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    slider.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  });
}
it.each(["codex", "claude", "kimi"])(
  "always offers four effort levels for %s",
  async (provider) => {
    config = {
      ...config,
      primary: provider,
      models: { [provider]: "model-a" },
    };
    useReaderStore.setState({ aiConfig: config });
    await render();
    await openEffort();
    const slider = document.querySelector('input[type="range"]')!;
    expect(slider.getAttribute("min")).toBe("0");
    expect(slider.getAttribute("max")).toBe("3");
    expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
    await effortKey("End");
    expect(api.saveAIConfig).toHaveBeenCalledWith({
      ...config,
      efforts: { [provider]: { "model-a": "max" } },
    });
    expect(document.querySelector(".effort-title")?.textContent).toBe("Max");
  },
);
it("restores the previous effort if saving fails", async () => {
  config = { ...config, efforts: { codex: { "model-a": "high" } } };
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.saveAIConfig).mockRejectedValue(new Error("save failed"));
  await render();
  await openEffort();
  await effortKey("Home");
  expect(document.querySelector(".effort-title")?.textContent).toBe("High");
  expect(useReaderStore.getState().aiModelSaving).toBe(false);
});
it("resets to Medium while preserving other model preferences", async () => {
  config = {
    ...config,
    efforts: {
      codex: { "model-a": "max", "model-b": "low" },
      claude: { sonnet: "high" },
    },
  };
  useReaderStore.setState({ aiConfig: config });
  await render();
  await openEffort();
  await act(async () =>
    (
      document.querySelector(
        '[aria-label="恢复默认 Effort"]',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(api.saveAIConfig).toHaveBeenCalledWith({
    ...config,
    efforts: {
      ...config.efforts,
      codex: { "model-a": "medium", "model-b": "low" },
    },
  });
  expect(document.querySelector(".effort-title")?.textContent).toBe("Medium");
});
it("does not save effort to a model that changed elsewhere", async () => {
  await render();
  await openEffort();
  config = { ...config, models: { ...config.models, codex: "model-b" } };
  await effortKey("End");
  expect(api.saveAIConfig).not.toHaveBeenCalled();
  expect(useReaderStore.getState().aiConfig?.models.codex).toBe("model-b");
});

it("drags the thumb through effort levels and saves only on release", async () => {
  await render();
  await openEffort();
  const thumb = document.querySelector(
    '[data-slot="slider-thumb"]',
  ) as HTMLElement;
  const control = thumb.parentElement!;
  const rect = (left: number, width: number) => ({
    x: left,
    y: 0,
    left,
    right: left + width,
    top: 0,
    bottom: 32,
    width,
    height: 32,
    toJSON() {},
  });
  vi.spyOn(control, "getBoundingClientRect").mockReturnValue(rect(0, 300));
  vi.spyOn(thumb, "getBoundingClientRect").mockImplementation(() => {
    const value = Number(
      (thumb.querySelector("input") as HTMLInputElement).value,
    );
    return rect((272 * value) / 3, 28);
  });
  const pointer = (type: string, x: number, buttons = 1) =>
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      clientX: x,
      clientY: 16,
    });
  await act(async () => {
    thumb.dispatchEvent(pointer("pointerdown", 105));
  });
  await act(async () => {
    document.dispatchEvent(pointer("pointermove", 196));
  });
  expect(document.querySelector(".effort-title")?.textContent).toBe("High");
  expect(api.saveAIConfig).not.toHaveBeenCalled();
  await act(async () => {
    document.dispatchEvent(pointer("pointermove", 287));
  });
  expect(document.querySelector(".effort-title")?.textContent).toBe("Max");
  await act(async () => {
    document.dispatchEvent(pointer("pointerup", 287, 0));
  });
  expect(api.saveAIConfig).toHaveBeenCalledExactlyOnceWith({
    ...config,
    efforts: { codex: { "model-a": "max" } },
  });
});

it("keeps the slider interactive during saving and persists the latest choice", async () => {
  let finish!: (value: AIConfig) => void;
  vi.mocked(api.saveAIConfig).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await openEffort();
  const panel = document.querySelector(".effort-panel");
  await effortKey("End");
  expect(useReaderStore.getState().aiModelSaving).toBe(true);
  expect(
    (document.querySelector('input[type="range"]') as HTMLInputElement)
      .disabled,
  ).toBe(false);
  expect(document.querySelector(".effort-panel")).toBe(panel);
  await effortKey("Home");
  expect(document.querySelector(".effort-title")?.textContent).toBe("Low");
  expect(api.saveAIConfig).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({ ...config, efforts: { codex: { "model-a": "max" } } }),
  );
  expect(api.saveAIConfig).toHaveBeenCalledTimes(2);
  expect(useReaderStore.getState().aiConfig?.efforts?.codex?.["model-a"]).toBe(
    "low",
  );
  expect(document.querySelector(".effort-title")?.textContent).toBe("Low");
  expect(useReaderStore.getState().aiModelSaving).toBe(false);
});

it("excludes disabled API candidates even when their checks passed", async () => {
  const { usableModels } = await import("./ModelSelector");
  const models = [
    {
      id: "disabled",
      name: "disabled",
      description: "",
      isDefault: true,
      enabled: false,
      capability: { text: true, vision: true, checkedAt: "saved" },
    },
    {
      id: "enabled",
      name: "enabled",
      description: "",
      isDefault: false,
      enabled: true,
      capability: { text: true, vision: true, checkedAt: "saved" },
    },
  ];
  expect(usableModels("api", models, "chat").map((model) => model.id)).toEqual([
    "enabled",
  ]);
  expect(
    usableModels("api", models, "vision").map((model) => model.id),
  ).toEqual(["enabled"]);
});

it("pins the recommended API model without requiring other model or tool checks", async () => {
  config = { ...config, primary: "api", models: {} };
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.agentModels).mockResolvedValue([
    {
      ...models[1]!,
      recommendedFor: ["chat"],
      capability: {
        text: true,
        vision: false,
        tools: "failed",
        checkedAt: "now",
      },
    },
    {
      ...models[0]!,
      capability: { text: false, vision: false, checkedAt: "now" },
    },
    { id: "unknown", name: "Unknown", description: "", isDefault: false },
    { ...models[1]!, id: "disabled", name: "Disabled", enabled: false },
  ]);
  await render();
  await chooseB();
  expect(useReaderStore.getState().aiConfig?.models.api).toBe("model-b");
  expect(
    Array.from(document.querySelectorAll('[role="option"]')).map(
      (option) => option.textContent,
    ),
  ).toEqual(["Model B"]);
});
