// @vitest-environment jsdom
import { act, useEffect, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Processing,
  type ReaderEvents,
  type ReaderAdapter,
} from "@neoread/core";
import { TooltipProvider } from "@neoread/ui/components/tooltip";
import { api } from "@neoread/api";
import { Workspace } from "./Workspace";
import { paper } from "./papers/fixtures";
import { useReaderStore } from "./store";
import { ChatSession, type ChatInput } from "./chat/chat-session";
import type { ResizablePanelGroup } from "@neoread/ui/components/resizable";
type GroupProps = ComponentProps<typeof ResizablePanelGroup>;

const reader = vi.hoisted(() => ({
  enabled: false,
  events: undefined as ReaderEvents | undefined,
  chat: undefined as ChatSession | undefined,
}));
vi.mock("./chat/session-registry", () => ({
  getChatSession: () => reader.chat,
}));
const panels = vi.hoisted(() => ({
  props: undefined as GroupProps | undefined,
}));

vi.mock("@neoread/api", () => ({
  api: {
    aiConfig: vi.fn(async () => ({
      primary: "",
      models: {},
      capabilities: {},
    })),
    recoverAnnotations: vi.fn(async () => ({ checked: true })),
    annotations: vi.fn(async () => []),
    annotationStream: vi.fn(async (_id, signal, callback) => {
      callback("revision");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }),
    navigation: vi.fn(async () => ({ revision: 0, entries: {} })),
    messages: vi.fn(async () => []),
    chatSessions: vi.fn(async () => []),
    blocks: vi.fn(async () => []),
    documentNote: vi.fn(async () => ({ body: "note", updatedAt: "" })),
    translations: vi.fn(async () => []),
  },
  setDiagnosticReporter: vi.fn(),
  reportDiagnostic: vi.fn(),
  blockImageURL: vi.fn(),
  publicationURL: vi.fn(),
}));
vi.mock("./progress", () => ({
  scheduleProgress: vi.fn(),
  flushProgress: vi.fn(async () => {}),
}));
vi.mock("@neoread/ui/components/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./translation/PDFReadingView", () => ({
  PDFReadingView: ({
    events,
    onReady,
  }: {
    events: ReaderEvents;
    onReady: (adapter: ReaderAdapter, toc: []) => void;
  }) => {
    reader.events = events;
    useEffect(() => {
      if (reader.enabled)
        onReady(
          {
            getLocation: () => ({ type: "pdf", page: 1 }),
            getContext: async () => "",
            clearSelection() {},
          } as ReaderAdapter,
          [],
        );
    }, []);
    return null;
  },
}));
vi.mock("./translation/EPUBReadingView", () => ({
  EPUBReadingView: () => null,
}));
vi.mock("./chat/AssistantPanel", () => ({ AssistantPanel: () => null }));
vi.mock("./ModelSelector", () => ({ ModelSelector: () => null }));
vi.mock("./DocumentOverview", () => ({ DocumentOverviewDialog: () => null }));
vi.mock("./ProcessingUsage", () => ({ ProcessingUsageDialog: () => null }));
vi.mock("./annotated-pdf-export", () => ({
  exportAnnotatedPDFWithToast: vi.fn(),
}));
vi.mock("./PaperNote", () => ({
  PaperNote: ({ active }: { active: boolean }) => (
    <div data-testid="paper-note" data-active={active} />
  ),
}));
vi.mock("./NotesPanel", () => ({
  NotesPanel: ({ onExport }: { onExport: () => void }) => (
    <button onClick={onExport}>导出</button>
  ),
}));
vi.mock("@neoread/ui/components/resizable", async () => {
  const { useRef } = await import("react");
  const Panel = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    ResizablePanel: Panel,
    ResizablePanelGroup: (props: GroupProps) => {
      panels.props = props;
      return <Panel>{props.children}</Panel>;
    },
    ResizableHandle: () => null,
    usePanelRef: () => useRef(null),
  };
});

const doc = paper({ id: "export-doc", title: "Export" });
const processing: Processing = {
  documentId: doc.id,
  phase: "ready",
  status: "complete",
  pagesDone: 1,
  pagesTotal: 1,
  translationsDone: 1,
  translationsTotal: 1,
  detail: "",
  updatedAt: "",
};
let root: Root, host: HTMLDivElement;
const render = (tick: number) =>
  root.render(
    <TooltipProvider>
      <Workspace
        document={doc}
        theme={defaultTheme}
        processing={{ ...processing, updatedAt: String(tick) }}
        onBack={() => {}}
        onSettings={() => {}}
      />
    </TooltipProvider>,
  );
const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === text,
  )!;
beforeEach(() => {
  vi.clearAllMocks();
  reader.enabled = false;
  reader.events = undefined;
  reader.chat = undefined;
  useReaderStore.setState({ theme: defaultTheme });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

it("restores user sidebar sizes and collapsed state without replacing expanded sizes with zero", async () => {
  function NeoRead() {
    const theme = useReaderStore((state) => state.theme);
    return (
      <TooltipProvider>
        <Workspace
          document={doc}
          theme={theme}
          onBack={() => {}}
          onSettings={() => {}}
        />
      </TooltipProvider>
    );
  }
  await act(async () => root.render(<NeoRead />));
  const change = (
    navigation: number,
    assistant: number,
    isUserInteraction: boolean,
  ) =>
    panels.props!.onLayoutChanged!(
      { navigation, assistant, reading: 100 - navigation - assistant },
      { isUserInteraction },
    );
  await act(async () => change(20, 32, true));
  await act(async () => change(0, 32, true));
  await act(async () => change(0, 40, false));
  expect(useReaderStore.getState().theme.readerLayout).toMatchObject({
    navigationWidth: 20,
    assistantWidth: 32,
    navigationOpen: false,
  });
  const saved = JSON.parse(JSON.stringify(useReaderStore.getState().theme));
  await act(async () => root.unmount());
  useReaderStore.setState({ theme: saved });
  root = createRoot(host);
  await act(async () => root.render(<NeoRead />));
  expect(panels.props!.defaultLayout).toEqual({
    navigation: 0,
    reading: 68,
    assistant: 32,
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="目录与搜索"]')!.click(),
  );
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Agent 与批注"]')!
      .click(),
  );
  expect(useReaderStore.getState().theme.readerLayout).toMatchObject({
    navigationWidth: 20,
    assistantWidth: 32,
    navigationOpen: true,
    assistantOpen: false,
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it.each(["取消", "Close"])(
  "keeps one export dialog across progress refreshes and removes it with %s",
  async (close) => {
    await act(async () => render(0));
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((el) => el.textContent?.startsWith("批注"))!
        .click(),
    );
    await act(async () => button("导出").click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const dialog = document.querySelector('[role="dialog"]');
    for (let tick = 1; tick <= 3; tick++) await act(async () => render(tick));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    await act(async () => button(close).click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    await act(async () => button("导出").click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  },
);

it("loads saved annotations without running recovery on open or progress updates", async () => {
  await act(async () => render(0));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  expect(api.annotations).toHaveBeenCalledWith(doc.id, expect.any(AbortSignal));
  expect(api.recoverAnnotations).not.toHaveBeenCalled();
  await act(async () => render(1));
  expect(api.recoverAnnotations).not.toHaveBeenCalled();
});

it("activates the independent note tab separately from annotations", async () => {
  await act(async () => render(0));
  const note = () => host.querySelector('[data-testid="paper-note"]');
  expect(note()?.getAttribute("data-active")).toBe("false");
  const tab = (name: string) =>
    [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (el) => el.textContent === name,
    )!;
  await act(async () => tab("笔记").click());
  expect(note()?.getAttribute("data-active")).toBe("true");
  await act(async () => tab("批注").click());
  expect(note()?.getAttribute("data-active")).toBe("false");
});

it("clears sent quote chips immediately while the answer is still generating and retains the request references", async () => {
  reader.enabled = true;
  let finish!: () => void;
  let captured: ChatInput | undefined;
  reader.chat = new ChatSession(doc.id, {
    messages: async () => [],
    stream: async (_id, input) => {
      captured = input;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  await reader.chat.load();
  vi.mocked(api.chatSessions).mockResolvedValueOnce([
    { id: "chat", documentId: doc.id, title: "Chat" },
  ] as never);
  vi.mocked(api.aiConfig).mockResolvedValueOnce({
    primary: "codex",
    models: {},
    capabilities: {},
  } as never);
  await act(async () => render(0));
  await act(async () =>
    reader.events!.selection({
      text: "隐藏状态 $H'$",
      location: { type: "pdf", page: 1 },
      anchor: { x: 50, top: 60, bottom: 80 },
    }),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="引用到对话"]')!.click(),
  );
  expect(host.querySelector(".quote-chips")?.textContent).toContain(
    "隐藏状态 $H'$",
  );
  const input = host.querySelector<HTMLTextAreaElement>(
    '[aria-label="向 AI 提问"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "解释这句话");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(captured?.references[0].text).toBe("隐藏状态 $H'$");
  expect(reader.chat.getSnapshot().busy).toBe(true);
  expect(host.querySelector(".quote-chips")).toBeNull();
  expect(input.value).toBe("");
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  reader.chat.dispose();
});
