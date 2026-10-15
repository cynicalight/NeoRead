// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import type { AIConfig, AgentModel } from "@reader/core";
import { TaskModels, taskChoice } from "./TaskModels";
import { useReaderStore } from "./store";
vi.mock("@reader/api", () => ({
  api: { agentModels: vi.fn(), aiConfig: vi.fn(), saveAIConfig: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
// The first Base UI select also pays jsdom warm-up; CI runners exceed 5 s.
vi.setConfig({ testTimeout: 20_000 });
const models: AgentModel[] = [
  { id: "opus", name: "Opus", description: "", isDefault: true },
  {
    id: "fable",
    name: "Fable",
    description: "",
    isDefault: false,
    recommendedFor: ["chat"],
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: "",
    isDefault: false,
    recommendedFor: ["translation"],
  },
];
let root: Root;
let host: HTMLDivElement;
let config: AIConfig;
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
    primary: "claude",
    models: { claude: "opus" },
    efforts: { claude: { opus: "high" } },
    capabilities: {},
    api: { url: "", model: "", hasKey: false },
    textAPI: { url: "", model: "", hasKey: false },
    imageAPI: { url: "", model: "", hasKey: false },
  };
  useReaderStore.setState({ aiConfig: config, aiModelSaving: false });
  vi.mocked(api.agentModels).mockResolvedValue(models);
  vi.mocked(api.aiConfig).mockImplementation(async () => config);
  vi.mocked(api.saveAIConfig).mockImplementation(async (value) => {
    config = value;
    return value;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const trigger = (label: string) =>
  host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
async function choose(label: string, text: string) {
  await act(async () => trigger(label).click());
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (item) => item.textContent === text,
  ) as HTMLElement;
  expect(option).toBeDefined();
  await act(async () => {
    option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    option.click();
  });
}
it("defaults effort to medium and keys choices per task", () => {
  expect(taskChoice(config, "chat")).toEqual({ model: "opus", effort: "high" });
  expect(taskChoice(config, "translation")).toEqual({
    model: "",
    effort: "medium",
  });
});
it("saves the translation model without touching chat", async () => {
  await act(async () => root.render(<TaskModels disabled={false} />));
  await choose("翻译模型", "Fable");
  expect(config.translationModels).toEqual({ claude: "fable" });
  expect(config.models).toEqual({ claude: "opus" });
});
it("saves the translation effort without touching chat", async () => {
  config.translationModels = { claude: "fable" };
  useReaderStore.setState({ aiConfig: config });
  await act(async () => root.render(<TaskModels disabled={false} />));
  await choose("翻译 Effort", "Low");
  expect(config.translationEfforts).toEqual({ claude: { fable: "low" } });
  expect(config.efforts).toEqual({ claude: { opus: "high" } });
});
it("persists an explicitly selected recommended model", async () => {
  config.translationModels = { claude: "fable" };
  useReaderStore.setState({ aiConfig: config });
  await act(async () => root.render(<TaskModels disabled={false} />));
  await choose("翻译模型", "Sonnet");
  expect(config.translationModels).toEqual({ claude: "sonnet" });
});
const checked = { checkedAt: "2026-10-09" };
const apiModels: AgentModel[] = [
  {
    id: "deepseek-flash",
    name: "Flash",
    description: "",
    isDefault: false,
    recommendedFor: ["translation", "vision"],
    capability: { text: true, vision: true, ...checked },
  },
  {
    id: "deepseek-v4-pro",
    name: "Pro",
    description: "",
    isDefault: false,
    recommendedFor: ["chat"],
    capability: { text: true, vision: false, ...checked },
  },
  {
    id: "broken",
    name: "Broken",
    description: "",
    isDefault: false,
    custom: true,
    capability: { text: false, vision: false, ...checked },
  },
];
// Closed Base UI menus stay mounted in jsdom; read the latest one.
const optionNames = () =>
  Array.from(
    Array.from(document.querySelectorAll('[role="listbox"]'))
      .at(-1)!
      .querySelectorAll('[role="option"]'),
  ).map((item) => item.textContent);
it("offers API models only for the tasks whose checks they passed", async () => {
  config = { ...config, primary: "api", models: {}, efforts: {} };
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.agentModels).mockResolvedValue(apiModels);
  await act(async () => root.render(<TaskModels disabled={false} />));
  expect(trigger("问答模型").textContent).toContain("Pro");
  expect(trigger("图片模型").textContent).toContain("Flash");
  await act(async () => trigger("问答模型").click());
  expect(optionNames()).toEqual(["自动选择（Pro）", "Flash", "Pro"]);
  await act(async () => trigger("图片模型").click());
  expect(optionNames()).toEqual(["自动选择（Flash）", "Flash"]);
});
it("leaves the API image model empty when no model passed vision", async () => {
  config = { ...config, primary: "api", models: {}, efforts: {} };
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.agentModels).mockResolvedValue(
    apiModels.slice(1).map((model) => ({
      ...model,
      recommendedFor: model.recommendedFor?.filter((t) => t !== "vision"),
    })),
  );
  await act(async () => root.render(<TaskModels disabled={false} />));
  expect(trigger("图片模型").textContent).toContain("无可用模型");
  expect(trigger("图片模型").disabled).toBe(true);
  expect(host.textContent).toContain(
    "图片用途需先在 API 设置中启用模型并通过图片测试",
  );
});

it("disables effort for fixed models and shows the actual mapping for tunable models", async () => {
  config.primary = "api";
  config.models = { api: "fixed" };
  config.translationModels = { api: "tunable" };
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.agentModels).mockResolvedValue([
    {
      id: "fixed",
      name: "Fixed",
      description: "",
      isDefault: true,
      capability: { text: true, vision: false, checkedAt: "now" },
      effortInfo: { mode: "fixed", note: "固定模式" },
    },
    {
      id: "tunable",
      name: "Tunable",
      description: "",
      isDefault: false,
      capability: { text: true, vision: false, checkedAt: "now" },
      effortInfo: {
        mode: "levels",
        note: "官方映射",
        mappings: { medium: "high" },
      },
    },
  ]);
  await act(async () => root.render(<TaskModels disabled={false} />));
  expect(trigger("问答 Effort").disabled).toBe(true);
  expect(trigger("问答 Effort").textContent).toContain("固定／自动");
  expect(trigger("翻译 Effort").disabled).toBe(false);
  expect(host.textContent).toContain("medium → high");
});

it("persists the recommended API model despite unrelated failed or untested checks", async () => {
  config = { ...config, primary: "api", models: {}, efforts: {} };
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.agentModels).mockResolvedValue([
    ...apiModels.map((model) => ({
      ...model,
      capability: { ...model.capability!, tools: "failed" as const },
    })),
    { id: "untested", name: "Untested", description: "", isDefault: false },
    { ...apiModels[0]!, id: "disabled", name: "Disabled", enabled: false },
  ]);
  await act(async () => root.render(<TaskModels disabled={false} />));
  expect(trigger("问答模型").disabled).toBe(false);
  await choose("问答模型", "Pro");
  expect(config.models.api).toBe("deepseek-v4-pro");
  await act(async () => trigger("问答模型").click());
  expect(optionNames()).toEqual(["自动选择（Pro）", "Flash", "Pro"]);
});

it("uses automatic selection only when explicitly chosen", async () => {
  config.translationModels = { claude: "fable" };
  useReaderStore.setState({ aiConfig: config });
  await act(async () => root.render(<TaskModels disabled={false} />));
  await choose("翻译模型", "自动选择（Sonnet）");
  expect(config.translationModels).toEqual({ claude: "" });
});
