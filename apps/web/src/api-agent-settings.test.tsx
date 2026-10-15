// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AIConfig, AgentModel, ProxySettingsState } from "@reader/core";
import { api } from "@reader/api";
import { toast } from "sonner";
import { Settings } from "./Settings";
import { useReaderStore } from "./store";

vi.mock("@reader/api", () => ({
  api: {
    connectorStatus: vi.fn(async () => ({ available: true })),
    journalRankConfig: vi.fn(async () => ({
      enabled: true,
      hasKey: false,
      selected: [],
      available: [],
    })),
    providers: vi.fn(),
    aiConfig: vi.fn(),
    saveAIConfig: vi.fn(),
    testAI: vi.fn(),
    agentModels: vi.fn(async () => []),
    saveLibraryPreferences: vi.fn(async (value) => value),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock("@reader/ui/components/dialog", () => {
  const Content = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: Content,
    DialogHeader: Content,
    DialogTitle: Content,
    DialogDescription: Content,
  };
});
let root: Root;
let host: HTMLDivElement;
let config: AIConfig;
// Listed by the endpoint; the value says whether the model passes vision.
let listed: Record<string, boolean>;
const input = (label: string) =>
  host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const type = async (label: string, value: string) => {
  const element = input(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = async () =>
  act(async () =>
    input("API 地址").form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
const openAPI = async () =>
  act(async () =>
    (
      host.querySelector('[aria-label="配置 API Key"]') as HTMLButtonElement
    ).click(),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.clearAllMocks();
  config = {
    primary: "api",
    models: {},
    capabilities: {},
    api: { url: "", model: "", hasKey: false },
    textAPI: { url: "", model: "", hasKey: false },
    imageAPI: { url: "", model: "", hasKey: false },
  };
  useReaderStore.setState({ aiConfig: undefined, aiModelSaving: false });
  vi.mocked(api.providers).mockImplementation(async () => [
    {
      id: "api",
      installed: !!config.api.url,
      authenticated: config.api.hasKey,
      status: config.api.url ? "已配置" : "未配置",
    },
  ]);
  vi.mocked(api.aiConfig).mockImplementation(async () => config);
  listed = { "deepseek-flash": true, "deepseek-v4-pro": false };
  vi.mocked(api.saveAIConfig).mockImplementation(async (next) => {
    const { key, ...rest } = next.api;
    const changed = next.api.url !== config.api.url || !!key;
    config = {
      ...next,
      api: { ...rest, hasKey: !!key || next.api.hasKey },
      capabilities: changed ? {} : next.capabilities,
    };
    return config;
  });
  vi.mocked(api.agentModels).mockImplementation(async () =>
    [
      ...new Set([
        ...Object.keys(listed),
        ...(config.apiModels ?? []),
        ...(config.apiEnabledModels ?? []),
      ]),
    ].map((id): AgentModel => ({
      id,
      name: id,
      description: "",
      isDefault: false,
      custom: !(id in listed),
      capability: config.capabilities[`api:${id}`],
    })),
  );
  vi.mocked(api.testAI).mockImplementation(async (_provider, stage, model) => {
    const capability = {
      text: true,
      vision: stage === "vision" && !!listed[model!],
      checkedAt: "2026-10-09",
      pendingVision: stage === "text",
    };
    config = {
      ...config,
      capabilities: { ...config.capabilities, [`api:${model}`]: capability },
    };
    return capability;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.readerDesktop;
  vi.unstubAllGlobals();
});

it("groups proxy settings and log export under diagnostics without a network tab", async () => {
  const exportLogs = vi.fn(async () => true);
  window.readerDesktop = {
    platform: "darwin",
    proxySettings: vi.fn(async (): Promise<ProxySettingsState> => ({
      settings: { mode: "manual", host: "127.0.0.1", port: 7890 },
      restartRequired: false,
    })),
    saveProxySettings: vi.fn(),
    checkProxy: vi.fn(),
    restart: vi.fn(),
    exportDiagnostics: exportLogs,
    checkForUpdates: vi.fn(),
    writeClipboardText: vi.fn(),
    setAppearance: vi.fn(),
    importFiles: vi.fn(),
    importLargePapers: vi.fn(),
    showDocumentFile: vi.fn(),
    openDocumentFile: vi.fn(),
    openExternal: vi.fn(),
    onBeforeClose: vi.fn(),
    onLibraryChanged: vi.fn(),
  };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  const tabs = Array.from(
    host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  expect(tabs.map((tab) => tab.textContent)).not.toContain("网络");
  const diagnostics = tabs.find((tab) => tab.textContent === "诊断")!;
  await act(async () => diagnostics.click());
  const panel = input("代理地址").closest('[role="tabpanel"]')!;
  expect(panel.getAttribute("aria-labelledby")).toBe(diagnostics.id);
  expect(panel.textContent).toContain("chatgpt.com/robots.txt");
  const exportButton = Array.from(
    panel.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent === "导出全部日志")!;
  await act(async () => exportButton.click());
  expect(exportLogs).toHaveBeenCalledOnce();
});
it("saves the API endpoint and key without starting paid probes", async () => {
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  expect(host.textContent).toContain("未配置");
  expect(host.textContent).toContain("点击卡片配置你的apikey");
  expect(input("API 地址")).toBeNull();
  expect(api.testAI).not.toHaveBeenCalled();
  await openAPI();
  expect(input("API 地址").value).toBe("https://api.deepseek.com");
  await type("API Key", "sk-test");
  await submit();
  expect(api.saveAIConfig).toHaveBeenLastCalledWith(
    expect.objectContaining({
      api: {
        url: "https://api.deepseek.com",
        protocol: "auto",
        model: "",
        key: "sk-test",
        hasKey: false,
      },
    }),
  );
  expect(api.testAI).not.toHaveBeenCalled();
  expect(input("API Key").value).toBe("");
  expect(input("API Key").placeholder).toBe("已保存，留空保持不变");
  await act(async () =>
    (
      host.querySelector('[aria-label="返回 Agent 设置"]') as HTMLButtonElement
    ).click(),
  );
  expect(input("API 地址")).toBeNull();
  expect(host.textContent).not.toContain("点击卡片查看 API 配置");
  const card = host.querySelector('[aria-label="配置 API Key"]')!;
  expect(card.querySelector('[aria-label="文本推理：已通过"]')).toBeNull();
  expect(card.querySelector('[aria-label="图片理解：已通过"]')).toBeNull();
});
it("keeps the saved key when changing only the API endpoint without probing", async () => {
  config.api = { url: "https://api.deepseek.com", model: "", hasKey: true };
  config.capabilities = {
    "api:deepseek-flash": { text: true, vision: true, checkedAt: "saved" },
    "api:deepseek-v4-pro": { text: true, vision: false, checkedAt: "saved" },
  };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  expect(input("API Key").value).toBe("");
  expect(input("API Key").placeholder).toBe("已保存，留空保持不变");
  expect(api.testAI).not.toHaveBeenCalled();
  // Editing only the address keeps the saved key without resending it.
  await type("API 地址", "https://api.deepseek.com/v1");
  await submit();
  expect(api.saveAIConfig).toHaveBeenLastCalledWith(
    expect.objectContaining({
      api: {
        url: "https://api.deepseek.com/v1",
        protocol: "auto",
        model: "",
        key: undefined,
        hasKey: true,
      },
    }),
  );
  expect(api.testAI).not.toHaveBeenCalled();
  expect(config.api).toEqual({
    url: "https://api.deepseek.com/v1",
    protocol: "auto",
    model: "",
    hasKey: true,
  });
  expect(
    host.querySelectorAll('.api-model-list [aria-label="图片理解：已通过"]'),
  ).toHaveLength(0);
});
it("runs vision probes only after an explicit vision action", async () => {
  config.api = { url: "https://api.example.com", model: "", hasKey: true };
  listed = { "text-only": false };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  expect(input("API 地址").value).toBe("https://api.example.com");
  expect(api.testAI).not.toHaveBeenCalled();
  await clickButton("检测已启用模型的文本");
  expect(api.testAI).toHaveBeenCalledExactlyOnceWith(
    "api",
    "text",
    "text-only",
  );
  await clickButton("检测已启用模型的图片");
  expect(api.testAI).toHaveBeenCalledWith("api", "vision", "text-only");
  expect(toast.warning).not.toHaveBeenCalled();
  await act(async () =>
    (
      host.querySelector('[aria-label="返回 Agent 设置"]') as HTMLButtonElement
    ).click(),
  );
  const card = host.querySelector('[aria-label="配置 API Key"]')!;
  expect(card.querySelector('[aria-label="文本推理：已通过"]')).not.toBeNull();
  expect(card.querySelector('[aria-label="图片理解：未通过"]')).not.toBeNull();
});
it("adds and removes a model ID by hand without checking it automatically", async () => {
  config.api = { url: "https://api.example.com", model: "", hasKey: true };
  config.capabilities = {
    "api:deepseek-flash": { text: true, vision: true, checkedAt: "saved" },
    "api:deepseek-v4-pro": { text: true, vision: false, checkedAt: "saved" },
  };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  expect(api.testAI).not.toHaveBeenCalled();
  await type("添加模型 ID", "my-model");
  await act(async () =>
    input("添加模型 ID").form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(config.apiModels).toEqual(["my-model"]);
  expect(api.testAI).not.toHaveBeenCalled();
  await act(async () =>
    (
      host.querySelector('[aria-label="移除 my-model"]') as HTMLButtonElement
    ).click(),
  );
  expect(config.apiModels).toEqual([]);
  expect(host.textContent).not.toContain("my-model");
});

it("keeps selection auto-copy opt-in and lets reading settings toggle it", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const previous = useReaderStore.getState().theme;
  useReaderStore.setState({
    theme: { ...previous, autoCopySelection: undefined },
  });
  try {
    await act(async () =>
      root.render(<Settings open onOpenChange={() => {}} />),
    );
    const reading = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((tab) => tab.textContent === "阅读")!;
    await act(async () => reading.click());
    const label = [...host.querySelectorAll("label")].find((node) =>
      node.textContent?.includes("自动复制选中文字"),
    )!;
    const checkbox =
      label.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await act(async () => checkbox.click());
    expect(useReaderStore.getState().theme.autoCopySelection).toBe(true);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    await act(async () => checkbox.click());
    expect(useReaderStore.getState().theme.autoCopySelection).toBe(false);
  } finally {
    await act(async () => useReaderStore.setState({ theme: previous }));
  }
});

it("does not expose automatic chapter context", async () => {
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  expect(host.querySelector('[aria-label="提问时附带本章原文"]')).toBeNull();
});

const clickButton = async (label: string) =>
  act(async () => {
    const button = host.querySelector<HTMLButtonElement>(
      `[aria-label="${label}"]`,
    );
    expect(button, label).not.toBeNull();
    button!.click();
  });

it("opening and refetching settings never probes API models", async () => {
  config.api = { url: "https://api.example.com", model: "", hasKey: true };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  expect(api.testAI).not.toHaveBeenCalled();
  await clickButton("刷新模型列表");
  expect(api.testAI).not.toHaveBeenCalled();
});

it("checks enabled models only with at most two requests in flight", async () => {
  config.api = { url: "https://api.example.com", model: "", hasKey: true };
  config.apiEnabledModels = ["a", "b", "c"];
  listed = { a: true, b: true, c: true, disabled: true };
  let active = 0,
    peak = 0;
  const finish: Array<() => void> = [];
  vi.mocked(api.testAI).mockImplementation(async (_provider, stage, model) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => finish.push(resolve));
    active--;
    return { text: true, vision: false, checkedAt: model! };
  });
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  expect(api.testAI).not.toHaveBeenCalled();
  await clickButton("检测已启用模型的文本");
  expect(api.testAI).toHaveBeenCalledTimes(2);
  await act(async () => finish.shift()!());
  expect(api.testAI).toHaveBeenCalledTimes(3);
  await act(async () => finish.splice(0).forEach((resolve) => resolve()));
  expect(peak).toBe(2);
  expect(vi.mocked(api.testAI).mock.calls.map((call) => call.slice(1))).toEqual(
    [
      ["text", "a"],
      ["text", "b"],
      ["text", "c"],
    ],
  );
});

it("first enable edit retains legacy task choices and manual IDs then allows disabling all", async () => {
  config.api = { url: "https://api.example.com", model: "", hasKey: true };
  config.models = { api: "legacy-chat" };
  config.visionModels = { api: "legacy-vision" };
  config.translationModels = { api: "legacy-translation" };
  config.apiModels = ["manual"];
  listed = { a: true };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  await clickButton("启用 a");
  expect(config.apiEnabledModels).toEqual(
    expect.arrayContaining([
      "legacy-chat",
      "legacy-vision",
      "legacy-translation",
      "manual",
    ]),
  );
  expect(config.apiEnabledModels).not.toContain("a");
  await clickButton("停用全部模型");
  expect(config.apiEnabledModels).toEqual([]);
  expect(api.testAI).not.toHaveBeenCalled();
});

it("saves independent text and vision probe timeouts", async () => {
  config.api = { url: "https://api.example.com", model: "", hasKey: true };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  expect(input("文本检测时限（秒）").value).toBe("45");
  expect(input("图片检测时限（秒）").value).toBe("90");
  await type("文本检测时限（秒）", "120");
  await type("图片检测时限（秒）", "240");
  await submit();
  expect(config.api).toMatchObject({
    textProbeTimeoutSeconds: 120,
    visionProbeTimeoutSeconds: 240,
    hasKey: true,
  });
  expect(api.testAI).not.toHaveBeenCalled();
});

it("removes an enabled manual ID atomically while retaining its missing task choice", async () => {
  config.api = { url: "https://api.example.com", model: "", hasKey: true };
  config.apiModels = ["manual"];
  config.apiEnabledModels = [];
  config.models = { api: "manual" };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  await clickButton("启用 manual");
  expect(config.apiEnabledModels).toEqual(["manual"]);
  await clickButton("移除 manual");
  expect(config.apiModels).toEqual([]);
  expect(config.apiEnabledModels).toEqual([]);
  expect(config.models.api).toBe("manual");
  expect(
    host.querySelector('.api-model-list [aria-label="启用 manual"]'),
  ).toBeNull();
  expect(api.saveAIConfig).toHaveBeenLastCalledWith(
    expect.objectContaining({
      apiModels: [],
      apiEnabledModels: [],
      models: { api: "manual" },
    }),
  );
  expect(api.testAI).not.toHaveBeenCalled();
});

it("creates and renames a stable provider, saves its endpoint and deletes it without rerouting tasks", async () => {
  config.api = { url: "https://default.example", model: "", hasKey: true };
  config = { ...config, apiProviders: [{ id: "default", name: "Original", connection: config.api, models: [] }] } as AIConfig;
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  const add = host.querySelector('[aria-label="添加 API 提供商"]') as HTMLButtonElement;
  expect(add).not.toBeNull();
  await act(async () => add.click());
  await type("提供商名称", "Second");
  await act(async () => (host.querySelector('[aria-label="保存提供商名称"]') as HTMLButtonElement).click());
  await type("API 地址", "https://second.example");
  await type("API Key", "second-key");
  await type("首个输出时限（秒）", "75");
  await submit();
  const state = config as AIConfig & { apiProviders: { id: string; name: string; connection: Record<string, unknown> }[] };
  const second = state.apiProviders.find((p) => p.name === "Second")!;
  expect(second.connection.url).toBe("https://second.example");
  expect(second.connection.firstOutputTimeoutSeconds).toBe(75);
  expect(state.apiProviders.find((p) => p.id === "default")!.connection.url).toBe("https://default.example");
  config.models.api = `${second.id}::same`;
  await act(async () => (host.querySelector('[aria-label="删除 API 提供商"]') as HTMLButtonElement).click());
  expect((config as typeof state).apiProviders.some((p) => p.id === second.id)).toBe(false);
  expect(config.models.api).toBe(`${second.id}::same`);
  expect(api.testAI).not.toHaveBeenCalled();
});

it("saves provider pricing and model overrides without turning cleared fields into zero", async () => {
  config.api = { url: "https://pricing.example", model: "", hasKey: false };
  config.apiProviders = [
    {
      id: "default",
      name: "P",
      connection: config.api,
      models: ["deepseek-flash"],
    },
  ];
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  expect(input("提供商 输入价格")).not.toBeNull();
  await type("提供商 输入价格", "2");
  await type("提供商 输出价格", "8");
  await act(async () =>
    input("提供商 输入价格").form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(config.apiProviders?.[0].pricing).toMatchObject({
    currency: "CNY",
    input: 2,
    output: 8,
  });
  await type("deepseek-flash 输出价格", "0");
  await act(async () =>
    input("deepseek-flash 输出价格").form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(
    config.apiProviders?.[0].modelOverrides?.["deepseek-flash"].pricing?.output,
  ).toBe(0);
  await type("deepseek-flash 输出价格", "");
  await act(async () =>
    input("deepseek-flash 输出价格").form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(
    config.apiProviders?.[0].modelOverrides?.["deepseek-flash"].pricing?.output,
  ).toBeUndefined();
  expect(input("deepseek-flash 输出价格").placeholder).toContain("8");
  expect(api.testAI).not.toHaveBeenCalled();
});

it("switching a model currency clears amounts and prevents incompatible inherited placeholders", async () => {
  config.api = { url: "https://pricing.example", model: "", hasKey: false };
  config.apiProviders = [
    {
      id: "default",
      name: "P",
      connection: config.api,
      models: ["deepseek-flash"],
      pricing: { currency: "CNY", input: 2, output: 8 },
      modelOverrides: {
        "deepseek-flash": { pricing: { currency: "CNY", output: 0 } },
      },
    },
  ];
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  expect(input("deepseek-flash 输入价格").placeholder).toBe("继承 2");
  await act(async () =>
    (
      host.querySelector(
        '[aria-label="deepseek-flash 价格币种"]',
      ) as HTMLButtonElement
    ).click(),
  );
  const usd = Array.from(document.querySelectorAll('[role="option"]')).find(
    (item) => item.textContent === "USD",
  ) as HTMLElement;
  await act(async () => {
    usd.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    usd.click();
  });
  expect(input("deepseek-flash 输出价格").value).toBe("");
  expect(input("deepseek-flash 输入价格").placeholder).toBe("未知");
  await type("deepseek-flash 输出价格", "-1");
  await act(async () =>
    input("deepseek-flash 输出价格").form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.saveAIConfig).not.toHaveBeenCalled();
  await type("deepseek-flash 输出价格", "3");
  await act(async () =>
    input("deepseek-flash 输出价格").form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(
    config.apiProviders?.[0].modelOverrides?.["deepseek-flash"].pricing,
  ).toEqual({ currency: "USD", output: 3 });
});
