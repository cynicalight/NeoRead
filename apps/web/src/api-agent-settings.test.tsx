// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AIConfig, AgentModel, ProxySettingsState } from "@neoread/core";
import { api, type PaperRefreshProgress } from "@neoread/api";
import { toast } from "sonner";
import { Settings } from "./Settings";
import { useReaderStore } from "./store";

vi.mock("@neoread/api", () => ({
  api: {
    connectorStatus: vi.fn(async () => ({ available: true })),
    paperRefreshStatus: vi.fn(async () => ({
      status: "idle",
      total: 0,
      processed: 0,
      failed: 0,
      skipped: 0,
    })),
    startPaperRefresh: vi.fn(async () => ({
      status: "done",
      total: 0,
      processed: 0,
      failed: 0,
      skipped: 0,
    })),
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
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@neoread/ui/components/dialog", () => {
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
// These tests cover Agent requests and configuration, not hidden appearance or
// paper-library panels. Keep the real tabs and the controls exercised below.
const libraryPanel = vi.hoisted(() => ({ visible: false }));
vi.mock("@neoread/ui/components/tabs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@neoread/ui/components/tabs")>();
  return {
    ...actual,
    TabsContent: (props: ComponentProps<typeof actual.TabsContent>) =>
      props.value === "display" ||
      (props.value === "papers" && !libraryPanel.visible) ? null : (
        <actual.TabsContent {...props} />
      ),
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
    input("Base URL").form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
const click = async (selector: string) =>
  act(async () => (host.querySelector(selector) as HTMLButtonElement).click());
// Agent controls live in the deck, which opens from the stacked cards.
const expand = async () => {
  if (!host.querySelector('[data-tour="agent-deck"]'))
    await click('[aria-label="展开 Agent 卡片"]');
};
const openAPI = async () => {
  await expand();
  await click('[aria-label="配置 API Key"]');
};
const apiCard = '[data-tour="agent-card"][data-agent="api"]';
const selectAPI = async () => {
  await expand();
  await click(`${apiCard} [role="radio"]`);
};
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.clearAllMocks();
  // The status endpoint observes the same task state as the start endpoint.
  let paperProgress: PaperRefreshProgress = {
    status: "idle",
    total: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
  };
  vi.mocked(api.paperRefreshStatus).mockImplementation(
    async () => paperProgress,
  );
  vi.mocked(api.startPaperRefresh).mockImplementation(async () => {
    paperProgress = { ...paperProgress, status: "done" };
    return paperProgress;
  });
  config = {
    primary: "api",
    models: {},
    capabilities: {},
    api: { url: "", model: "", hasKey: false },
    textAPI: { url: "", model: "", hasKey: false },
    imageAPI: { url: "", model: "", hasKey: false },
  };
  useReaderStore.getState().setTheme({ reducedMotion: true });
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
    [...Object.keys(listed), ...(config.apiModels ?? [])].map(
      (id): AgentModel => ({
        id,
        name: id,
        description: "",
        isDefault: false,
        custom: !(id in listed),
        capability: config.capabilities[`api:${id}`],
      }),
    ),
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
  useReaderStore.getState().setTheme({ reducedMotion: false });
  host.remove();
  delete window.neoreadDesktop;
  vi.unstubAllGlobals();
});

it("groups proxy settings and log export under diagnostics without a network tab", async () => {
  const exportLogs = vi.fn(async () => true);
  window.neoreadDesktop = {
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
  expect(panel.textContent).toContain("重新识别论文标题，并查找论文信息");
  const startButton = Array.from(
    panel.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent === "开始")!;
  await act(async () => startButton.click());
  expect(api.startPaperRefresh).toHaveBeenCalled();
  expect(panel.textContent).toContain("处理完成：0/0 篇");
  const exportButton = Array.from(
    panel.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent === "导出全部日志")!;
  await act(async () => exportButton.click());
  expect(exportLogs).toHaveBeenCalledOnce();
});
// These multi-step integration cases exercise real Base UI controls and both
// capability checks; 10s is too tight on the shared CI runner.
it("saves the API endpoint and key, then tests the new connection", async () => {
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  expect(input("Base URL")).toBeNull();
  expect(api.testAI).not.toHaveBeenCalled();
  await openAPI();
  expect(input("Base URL").value).toBe("https://api.deepseek.com");
  await type("API Key", "sk-test");
  await submit();
  expect(api.saveAIConfig).toHaveBeenLastCalledWith(
    expect.objectContaining({
      api: {
        url: "https://api.deepseek.com",
        protocol: "openai",
        model: "",
        key: "sk-test",
        hasKey: false,
      },
    }),
  );
  // Each listed model is checked on its own, text first, then vision.
  for (const model of ["deepseek-flash", "deepseek-v4-pro"])
    for (const stage of ["text", "vision"])
      expect(api.testAI).toHaveBeenCalledWith("api", stage, model);
  expect(api.testAI).toHaveBeenCalledTimes(4);
  expect(
    host.querySelectorAll('.api-model-list [aria-label="图片理解：已通过"]'),
  ).toHaveLength(1);
  expect(toast.warning).not.toHaveBeenCalled();
  expect(input("API Key").value).toBe("");
  expect(input("API Key").placeholder).toBe("已保存，留空保持不变");
}, 30_000);
it("selects the API agent from its card once a model passes", async () => {
  config.primary = "";
  config.api = { url: "https://api.example.com", model: "", hasKey: true };
  config.capabilities = {
    "api:deepseek-flash": { text: true, vision: true, checkedAt: "saved" },
    "api:deepseek-v4-pro": { text: true, vision: false, checkedAt: "saved" },
  };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await selectAPI();
  expect(toast.warning).not.toHaveBeenCalled();
  expect(api.saveAIConfig).toHaveBeenLastCalledWith(
    expect.objectContaining({ primary: "api" }),
  );
  expect(host.querySelector(apiCard)?.hasAttribute("data-selected")).toBe(true);
});
it("opens the API settings from an unconfigured card", async () => {
  config.primary = "";
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await selectAPI();
  expect(input("Base URL")).not.toBeNull();
  expect(api.saveAIConfig).not.toHaveBeenCalled();
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
    const toggle = label.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    expect(useReaderStore.getState().theme.autoCopySelection).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(useReaderStore.getState().theme.autoCopySelection).toBe(false);
  } finally {
    await act(async () => useReaderStore.setState({ theme: previous }));
  }
});

it("rechecks a saved API model with a per-stage wait limit without changing configuration", async () => {
  config.api = { url: "https://api.example.com", model: "", hasKey: true };
  listed = { "slow-model": true };
  config.capabilities = {
    "api:slow-model": {
      text: false,
      vision: false,
      checkedAt: "saved",
      error: "检测超时",
    },
  };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  const retry = () =>
    host.querySelector<HTMLButtonElement>('[aria-label="重新检测 slow-model"]');
  expect(retry()).not.toBeNull();
  await type("检测等待上限（秒）", "120");
  await act(async () => retry()!.click());
  expect(api.testAI).toHaveBeenCalledWith("api", "text", "slow-model", 120);
  expect(api.testAI).toHaveBeenCalledWith("api", "vision", "slow-model", 120);
  expect(retry()).not.toBeNull();
  await type("检测等待上限（秒）", "601");
  expect(retry()!.disabled).toBe(true);
  await type("检测等待上限（秒）", "0");
  vi.mocked(api.testAI).mockClear();
  await act(async () => retry()!.click());
  expect(api.testAI).toHaveBeenCalledWith("api", "text", "slow-model");
  expect(api.saveAIConfig).not.toHaveBeenCalled();
}, 30_000);

it("shows the latest first-output observations including zero, without inventing missing timings", async () => {
  config.api = { url: "https://api.example.com", model: "", hasKey: true };
  listed = { observed: true, old: false };
  config.capabilities = {
    "api:observed": {
      text: true,
      vision: true,
      checkedAt: "saved",
      textFirstOutputMs: 0,
      visionFirstOutputMs: 1250,
    },
    "api:old": {
      text: false,
      vision: false,
      checkedAt: "saved",
      error: "连接失败",
    },
  };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await openAPI();
  const rows = host.querySelectorAll(".api-model-list li");
  expect(rows[0].textContent).toContain("文本首输出 0.00 s");
  expect(rows[0].textContent).toContain("图片首输出 1.25 s");
  expect(rows[1].textContent).not.toContain("首输出");
  expect(rows[1].textContent).toContain("连接失败");
});

it.each(["text", "vision"] as const)(
  "does not show stale observations after a %s request fails",
  async (failedStage) => {
    config.api = { url: "https://api.example.com", model: "", hasKey: true };
    listed = { observed: true };
    config.capabilities = {
      "api:observed": {
        text: true,
        vision: true,
        checkedAt: "saved",
        textFirstOutputMs: 1234,
        visionFirstOutputMs: 2345,
      },
    };
    vi.mocked(api.testAI).mockImplementation(async (_provider, stage) => {
      if (stage === failedStage) throw new Error("Failed to fetch");
      return {
        text: true,
        vision: false,
        checkedAt: "new",
        pendingVision: true,
        textFirstOutputMs: 100,
      };
    });
    await act(async () =>
      root.render(<Settings open onOpenChange={() => {}} />),
    );
    await openAPI();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="重新检测 observed"]')!
        .click(),
    );
    const row = host.querySelector(".api-model-list li")!;
    expect(row.textContent).toContain("Failed to fetch");
    expect(row.textContent).not.toContain("1.23 s");
    expect(row.textContent).not.toContain("2.35 s");
    if (failedStage === "text") expect(row.textContent).not.toContain("首输出");
    else expect(row.textContent).toContain("文本首输出 0.10 s");
  },
);

it("persists CLI web search directly from the toggle without a Save action", async () => {
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  const label = [...host.querySelectorAll("span")].find(
    (node) => node.textContent === "允许 CLI 原生联网搜索",
  )!;
  const toggle =
    label.parentElement!.querySelector<HTMLButtonElement>('[role="switch"]')!;
  vi.mocked(api.saveAIConfig).mockClear();
  await act(async () => label.click());
  await act(async () => label.parentElement!.click());
  expect(api.saveAIConfig).not.toHaveBeenCalled();
  await act(async () => toggle.click());
  expect(
    vi.mocked(api.saveAIConfig).mock.lastCall?.[0].webSearch?.cliEnabled,
  ).toBe(true);
  expect(useReaderStore.getState().aiConfig?.webSearch?.cliEnabled).toBe(true);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

it("shows only library location in the books tab for the current library", async () => {
  const previous = useReaderStore.getState().libraryPreferences;
  libraryPanel.visible = true;
  useReaderStore.setState({
    libraryPreferences: { ...previous, mode: "books", primaryMode: "papers" },
  });
  window.neoreadDesktop = {
    libraryLocation: vi.fn(async () => "/test/library"),
    moveLibrary: vi.fn(),
    importLibrary: vi.fn(),
  } as unknown as NonNullable<typeof window.neoreadDesktop>;
  try {
    await act(async () =>
      root.render(<Settings open onOpenChange={() => {}} />),
    );
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.some((tab) => tab.textContent === "论文库")).toBe(false);
    const books = tabs.find((tab) => tab.textContent === "图书库")!;
    expect(books).toBeDefined();
    await act(async () => books.click());
    const panel = host.querySelector(
      `[role="tabpanel"][aria-labelledby="${books.id}"]`,
    )!;
    expect(panel.textContent).toContain("书库位置");
    expect(panel.textContent).toContain("/test/library");
    expect(panel.querySelectorAll("section")).toHaveLength(1);
    expect(panel.textContent).not.toContain("导入设置");
    expect(panel.textContent).not.toContain("论文显示作者名字");
  } finally {
    libraryPanel.visible = false;
    await act(async () =>
      useReaderStore.setState({ libraryPreferences: previous }),
    );
  }
});

it("checks installed providers' shared catalog caches whenever settings opens", async () => {
  config.capabilities = {
    codex: { text: true, vision: true, checkedAt: "checked" },
    claude: { text: true, vision: true, checkedAt: "checked" },
  };
  vi.mocked(api.providers).mockResolvedValue([
    { id: "codex", installed: true, authenticated: true, status: "ready" },
    { id: "claude", installed: true, authenticated: true, status: "ready" },
    { id: "kimi", installed: false, authenticated: false, status: "missing" },
  ]);
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  expect(api.agentModels).toHaveBeenCalledWith("codex");
  expect(api.agentModels).toHaveBeenCalledWith("claude");
  expect(
    vi.mocked(api.agentModels).mock.calls.some(([id]) => id === "kimi"),
  ).toBe(false);
  vi.mocked(api.agentModels).mockClear();
  await act(async () =>
    root.render(<Settings open={false} onOpenChange={() => {}} />),
  );
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  expect(api.agentModels).toHaveBeenCalledWith("codex");
  expect(api.agentModels).toHaveBeenCalledWith("claude");
});

it("does not overwrite freshly updated capabilities with a slower settings snapshot", async () => {
  let release!: (providers: Awaited<ReturnType<typeof api.providers>>) => void;
  vi.mocked(api.providers).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  const updated = {
    ...config,
    capabilities: {
      ...config.capabilities,
      codex: { text: true, vision: true, checkedAt: "new-check" },
    },
  };
  await act(async () => useReaderStore.getState().setAIConfig(updated));
  await act(async () => release([]));
  expect(useReaderStore.getState().aiConfig?.capabilities.codex).toEqual(
    updated.capabilities.codex,
  );
});

it("saves the last navigated ready agent when the previous save is still running", async () => {
  config.capabilities = {
    codex: { text: true, vision: true, checkedAt: "saved" },
    claude: { text: true, vision: true, checkedAt: "saved" },
  };
  vi.mocked(api.providers).mockResolvedValue(
    (["codex", "claude"] as const).map((id) => ({
      id,
      installed: true,
      authenticated: true,
      status: "已登录",
    })),
  );
  let finishFirst!: () => void;
  vi.mocked(api.saveAIConfig).mockImplementationOnce(
    (next) =>
      new Promise((resolve) => {
        finishFirst = () => {
          config = next;
          resolve(next);
        };
      }),
  );
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  await expand();
  // Focus centres the starting card; arrow navigation performs the selection.
  await act(async () =>
    host.querySelector<HTMLElement>('[aria-label="使用 Codex"]')!.focus(),
  );
  const navigate = async (key: string) => {
    await act(async () => {
      host
        .querySelector('[role="radiogroup"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  };
  await navigate("ArrowDown");
  expect(api.saveAIConfig).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ primary: "claude" }),
  );
  await navigate("ArrowUp");
  await click('[aria-label="收起"]');
  await act(async () => finishFirst());
  expect(api.saveAIConfig).toHaveBeenLastCalledWith(
    expect.objectContaining({ primary: "codex" }),
  );
  expect(useReaderStore.getState().aiConfig?.primary).toBe("codex");
});
