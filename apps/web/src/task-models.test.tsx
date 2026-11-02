// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import type { AIConfig, AgentModel } from "@neoread/core";
import { TaskModels, taskChoice } from "./TaskModels";
import { useReaderStore } from "./store";
vi.mock("@neoread/api", () => ({
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
it("returns translation to automatic selection", async () => {
  config.translationModels = { claude: "fable" };
  useReaderStore.setState({ aiConfig: config });
  await act(async () => root.render(<TaskModels disabled={false} />));
  await choose("翻译模型", "Sonnet");
  expect(config.translationModels).toEqual({ claude: "" });
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
  expect(host.textContent).toContain("没有通过图片理解检测的模型");
});

it("disables effort for fixed models and keeps tunable models selectable", async () => {
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
});
