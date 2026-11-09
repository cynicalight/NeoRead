// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { AICapability, AIConfig } from "@neoread/core";
import { api } from "@neoread/api";
import { Settings } from "./Settings";
import { useReaderStore } from "./store";

vi.mock("@neoread/api", () => ({
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
    testAI: vi.fn(),
    agentModels: vi.fn(async () => []),
    saveLibraryPreferences: vi.fn(async (value) => value),
  },
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
vi.mock("@neoread/ui/components/tabs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@neoread/ui/components/tabs")>();
  return {
    ...actual,
    TabsContent: (props: ComponentProps<typeof actual.TabsContent>) =>
      props.value === "display" || props.value === "papers" ? null : (
        <actual.TabsContent {...props} />
      ),
  };
});

let root: Root;
let host: HTMLDivElement;
let config: AIConfig;
let complete: (capability: AICapability) => void;
const passed = { text: true, vision: true, checkedAt: "2026-10-05" };
const render = async (open = true) => {
  await act(async () =>
    root.render(<Settings open={open} onOpenChange={() => {}} />),
  );
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  config = {
    primary: "codex",
    models: {},
    capabilities: {},
    api: { url: "", model: "", hasKey: false },
    textAPI: { url: "", model: "", hasKey: false },
    imageAPI: { url: "", model: "", hasKey: false },
  };
  useReaderStore.setState({ aiConfig: undefined, aiModelSaving: false });
  vi.mocked(api.providers).mockResolvedValue([
    { id: "codex", installed: true, authenticated: true, status: "已登录" },
    { id: "claude", installed: false, authenticated: false, status: "未安装" },
  ]);
  vi.mocked(api.aiConfig).mockImplementation(async () => config);
  vi.mocked(api.testAI).mockImplementation((_id, stage) => {
    if (stage === "vision") return Promise.resolve(config.capabilities.codex);
    return new Promise((resolve) => {
      complete = (capability) => {
        config = { ...config, capabilities: { codex: capability } };
        resolve(capability);
      };
    });
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
it("automatically checks installed agents once, even when settings reopen during a check", async () => {
  await render();
  expect(api.testAI).toHaveBeenCalledExactlyOnceWith("codex", "text");
  expect(host.querySelector('[aria-label="文本推理：检测中"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="图片理解：检测中"]')).not.toBeNull();
  await render(false);
  await render();
  expect(api.testAI).toHaveBeenCalledTimes(1);
  await act(async () => complete(passed));
  expect(host.querySelector('[data-state="passed"]')).not.toBeNull();
  expect(api.testAI).toHaveBeenNthCalledWith(2, "codex", "vision");
  expect(api.testAI).toHaveBeenCalledTimes(2);
});
it("reuses saved results after remount until an explicit retry", async () => {
  config.capabilities.codex = { ...passed, vision: false, error: "识图失败" };
  await render();
  expect(api.testAI).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="文本推理：已通过"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="图片理解：未通过"]')).not.toBeNull();
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect(api.testAI).not.toHaveBeenCalled();
  await act(async () =>
    (
      host.querySelector('[aria-label="重新检测 Agent"]') as HTMLButtonElement
    ).click(),
  );
  expect(api.testAI).toHaveBeenCalledExactlyOnceWith("codex", "text");
  await act(async () => complete(passed));
  expect(useReaderStore.getState().aiConfig?.capabilities.codex).toEqual(
    passed,
  );
});
it("keeps a saved check visible while metadata loads and reflects global failures", async () => {
  config = { ...config, capabilities: { codex: passed } };
  useReaderStore.setState({ aiConfig: config });
  let finish!: (value: AIConfig) => void;
  vi.mocked(api.aiConfig).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  expect(host.querySelector('[aria-label="文本推理：已通过"]')).not.toBeNull();
  await act(async () => finish(config));
  await act(async () =>
    useReaderStore.getState().setAIConfig({
      ...config,
      capabilities: {
        codex: { ...passed, text: false, vision: false, error: "调用失败" },
      },
    }),
  );
  expect(host.querySelector('[aria-label="文本推理：未通过"]')).not.toBeNull();
  expect(api.testAI).not.toHaveBeenCalled();
});

it("keeps successful text when the vision request disconnects", async () => {
  vi.mocked(api.testAI).mockImplementation(async (_id, stage) => {
    if (stage === "text")
      return { ...passed, vision: false, pendingVision: true };
    throw new Error("connection interrupted");
  });
  await render();
  expect(host.querySelector('[aria-label="文本推理：已通过"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="图片理解：未通过"]')).not.toBeNull();
});

it("resumes an interrupted vision check without repeating text", async () => {
  config.capabilities.codex = { ...passed, vision: false, pendingVision: true };
  vi.mocked(api.testAI).mockResolvedValue(passed);
  await render();
  expect(api.testAI).toHaveBeenCalledExactlyOnceWith("codex", "vision");
  expect(host.querySelector('[aria-label="文本推理：已通过"]')).not.toBeNull();
});

it("keeps the configured agent in front instead of a stale presentation preference", async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  await render();
  expect(
    host
      .querySelector('.agent-stack-card[data-depth="0"]')
      ?.getAttribute("data-agent"),
  ).toBe("codex");
  await act(async () => root.unmount());
  localStorage.setItem("neoread.agent-deck-front", "api");
  root = createRoot(host);
  await render();
  expect(
    host
      .querySelector('.agent-stack-card[data-depth="0"]')
      ?.getAttribute("data-agent"),
  ).toBe("codex");
  localStorage.removeItem("neoread.agent-deck-front");
});

it("preserves ready status while reopening settings refreshes metadata", async () => {
  config.capabilities.codex = passed;
  await render();
  expect(
    host.querySelector('[data-agent="codex"]')?.getAttribute("data-status"),
  ).toBe("ready");
  await render(false);
  vi.mocked(api.aiConfig).mockReturnValue(new Promise(() => {}));
  await render();
  expect(
    host.querySelector('[data-agent="codex"]')?.getAttribute("data-status"),
  ).toBe("ready");
  expect(api.testAI).not.toHaveBeenCalled();
});
