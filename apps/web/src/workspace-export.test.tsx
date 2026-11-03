// @vitest-environment jsdom
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Message,
  type Processing,
  type ReaderAdapter,
} from "@neoread/core";
import { toast } from "sonner";
import { TooltipProvider } from "@neoread/ui/components/tooltip";
import { api } from "@neoread/api";
import { Workspace } from "./Workspace";
import { paper } from "./papers/fixtures";
import { useReaderStore } from "./store";
import { ChatSession } from "./chat/chat-session";
import * as sessionRegistry from "./chat/session-registry";
import type { ChatStreamEvent } from "@neoread/api";
import { tabCloseWarning } from "./document-tab-guards";
import type { SessionPicker } from "./chat/SessionPicker";
import type { ResizablePanelGroup } from "@neoread/ui/components/resizable";
import type { AssistantPanel } from "./chat/AssistantPanel";
type GroupProps = ComponentProps<typeof ResizablePanelGroup>;

const panels = vi.hoisted(() => ({
  props: undefined as GroupProps | undefined,
  readerRenders: 0,
  assistantRenders: 0,
  sessions: undefined as ComponentProps<typeof SessionPicker> | undefined,
  readerReady: undefined as ((adapter: ReaderAdapter) => void) | undefined,
  assistant: undefined as ComponentProps<typeof AssistantPanel> | undefined,
}));

vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

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
    sessionMessages: vi.fn(async () => []),
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
vi.mock("./translation/PDFReadingView", () => ({
  PDFReadingView: ({
    onReady,
  }: {
    onReady: (adapter: ReaderAdapter, items: []) => void;
  }) => {
    panels.readerRenders++;
    panels.readerReady = (adapter) => onReady(adapter, []);
    return null;
  },
}));
vi.mock("./translation/EPUBReadingView", () => ({
  EPUBReadingView: () => null,
}));
vi.mock("./chat/AssistantPanel", () => ({
  AssistantPanel: (props: ComponentProps<typeof AssistantPanel>) => {
    panels.assistantRenders++;
    panels.assistant = props;
    return null;
  },
}));
vi.mock("./chat/SessionPicker", () => ({
  SessionPicker: (props: ComponentProps<typeof SessionPicker>) => {
    panels.sessions = props;
    return null;
  },
}));
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
  panels.readerRenders = panels.assistantRenders = 0;
  vi.mocked(api.chatSessions).mockReset().mockResolvedValue([]);
  vi.mocked(api.aiConfig)
    .mockReset()
    .mockResolvedValue({ primary: "", models: {}, capabilities: {} } as Awaited<
      ReturnType<typeof api.aiConfig>
    >);
  useReaderStore.setState({ theme: defaultTheme });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  vi.restoreAllMocks();
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

it.each(["a".repeat(9000), "中".repeat(3000)])(
  "keeps a withdrawal draft that exceeds the UTF-8 byte limit",
  async (content) => {
    vi.mocked(api.aiConfig).mockResolvedValueOnce({
      primary: "api",
      models: {},
      capabilities: {},
    } as Awaited<ReturnType<typeof api.aiConfig>>);
    await act(async () => render(0));
    await act(async () => panels.readerReady?.({} as ReaderAdapter));
    const original: Message = {
      id: "original",
      documentId: doc.id,
      role: "user",
      content,
      createdAt: "2026-10-15",
    };
    await act(async () => panels.assistant?.onWithdraw?.(original));
    await act(async () =>
      panels.assistant?.onWithdraw?.({ ...original, id: "withdrawn" }),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="发送问题"]')!.click(),
    );
    expect(toast.info).toHaveBeenCalledWith(
      "问题最多 16000 字节，请缩短后再发送",
    );
    expect(
      host.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="向 AI 提问"]',
      )!.value,
    ).toBe(`${content}\n\n${content}`);
  },
);

it("keeps a merged withdrawal draft when it exceeds the image limit", async () => {
  vi.mocked(api.aiConfig).mockResolvedValueOnce({
    primary: "api",
    models: {},
    capabilities: {},
  } as Awaited<ReturnType<typeof api.aiConfig>>);
  await act(async () => render(0));
  await act(async () => panels.readerReady?.({} as ReaderAdapter));
  const original: Message = {
    id: "draft",
    documentId: doc.id,
    role: "user",
    content: "draft question",
    createdAt: "2026-10-15",
    attachments: Array.from({ length: 4 }, (_, i) => ({
      id: `image-${i}`,
      page: 1,
      label: "image",
      caption: "",
    })),
  };
  await act(async () => panels.assistant?.onWithdraw?.(original));
  await act(async () =>
    panels.assistant?.onWithdraw?.({
      ...original,
      id: "withdrawn",
      content: "withdrawn question",
      attachments: [
        { id: "image-extra", page: 2, label: "image", caption: "" },
      ],
    }),
  );
  const composer = host.querySelector(
    'textarea[aria-label="向 AI 提问"]',
  ) as HTMLTextAreaElement;
  const send = host.querySelector(
    '[aria-label="发送问题"]',
  ) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  await act(async () => send.click());
  expect(toast.info).toHaveBeenCalledWith(
    "每次最多附加 4 张图片，请移除多余图片后再发送",
  );
  expect(composer.value).toBe("draft question\n\nwithdrawn question");
  expect(host.querySelectorAll('[aria-label^="移除附件："]')).toHaveLength(5);
});

const composer = () =>
  host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 AI 提问"]')!;
const enterPrompt = async (text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(composer(), text);
    composer().dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it("keeps typing local and preserves the latest text across workspace updates", async () => {
  vi.mocked(api.chatSessions).mockResolvedValue([
    {
      id: "typing",
      documentId: doc.id,
      title: "test",
      provider: "api",
      createdAt: "now",
      updatedAt: "now",
    },
  ]);
  vi.mocked(api.aiConfig).mockResolvedValueOnce({
    primary: "api",
    models: {},
    capabilities: {},
  } as Awaited<ReturnType<typeof api.aiConfig>>);
  await act(async () => render(0));
  await act(async () =>
    panels.readerReady?.({
      getLocation: () => undefined,
    } as unknown as ReaderAdapter),
  );
  const send = host.querySelector<HTMLButtonElement>(
    '[aria-label="发送问题"]',
  )!;
  expect(send.disabled).toBe(true);
  const emptyRenders = panels.readerRenders;
  await enterPrompt("第");
  expect(panels.readerRenders).toBe(emptyRenders);
  expect(send.disabled).toBe(false);
  expect(tabCloseWarning(doc.id)).not.toBeNull();
  const readerRenders = panels.readerRenders,
    assistantRenders = panels.assistantRenders;
  for (const text of ["第二", "第二个问题", "第二个问题\n补充条件"])
    await enterPrompt(text);
  expect(panels.readerRenders).toBe(readerRenders);
  expect(panels.assistantRenders).toBe(assistantRenders);
  await act(async () => render(1));
  expect(composer().value).toBe("第二个问题\n补充条件");
  const sent = vi
    .spyOn(ChatSession.prototype, "send")
    .mockResolvedValue(undefined);
  await act(async () => send.click());
  expect(sent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ prompt: "第二个问题\n补充条件" }),
  );
  expect(composer().value).toBe("");
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="发送问题"]')!.disabled,
  ).toBe(true);
  expect(tabCloseWarning(doc.id)).toBeNull();
});

it("restores the latest session draft and text when the composer remounts", async () => {
  vi.mocked(api.chatSessions).mockResolvedValue(
    ["draft-a", "draft-b"].map((id) => ({
      id,
      documentId: doc.id,
      title: id,
      provider: "api",
      createdAt: "now",
      updatedAt: "now",
    })),
  );
  await act(async () => render(0));
  await enterPrompt("first draft");
  await enterPrompt("first draft with latest typing");
  await act(async () => panels.sessions!.onChange("draft-b"));
  expect(composer().value).toBe("");
  await enterPrompt("second draft");
  await act(async () => panels.sessions!.onChange("draft-a"));
  expect(composer().value).toBe("first draft with latest typing");
  const tab = (name: string) =>
    [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (el) => el.textContent === name,
    )!;
  await act(async () => tab("笔记").click());
  await act(async () => tab("Agent").click());
  expect(composer().value).toBe("first draft with latest typing");
  await enterPrompt("   ");
  expect(tabCloseWarning(doc.id)).toBeNull();
});

it("keeps long Chinese composition and paste native across workspace updates", async () => {
  await act(async () => render(0));
  const long = "长中文草稿需要保留输入法候选和光标。".repeat(200);
  await enterPrompt(long);
  composer().setSelectionRange(20, 20);
  await act(async () => render(1));
  expect(composer().defaultValue).toBe("");
  expect(composer().value).toBe(long);
  expect(composer().selectionStart).toBe(20);
  const renders = panels.readerRenders;
  await act(async () => {
    composer().dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
  });
  for (const candidate of ["zh", "zhong", "中文输入"])
    await enterPrompt(long + candidate);
  await act(async () => {
    composer().dispatchEvent(
      new CompositionEvent("compositionend", {
        data: "中文输入",
        bubbles: true,
      }),
    );
  });
  expect(panels.readerRenders).toBe(renders);
  expect(composer().value).toBe(long + "中文输入");
  await enterPrompt(long + "一次粘贴大量中文。".repeat(300));
  await act(async () => render(2));
  expect(composer().defaultValue).toBe("");
  expect(composer().value).toBe(long + "一次粘贴大量中文。".repeat(300));
});

it("keeps composition and modified Enter keys from sending and submits the latest text with Enter", async () => {
  vi.mocked(api.chatSessions).mockResolvedValue([
    {
      id: "keyboard",
      documentId: doc.id,
      title: "test",
      provider: "api",
      createdAt: "now",
      updatedAt: "now",
    },
  ]);
  vi.mocked(api.aiConfig).mockResolvedValueOnce({
    primary: "api",
    models: {},
    capabilities: {},
  } as Awaited<ReturnType<typeof api.aiConfig>>);
  await act(async () => render(0));
  await act(async () =>
    panels.readerReady?.({
      getLocation: () => undefined,
    } as unknown as ReaderAdapter),
  );
  const sent = vi
    .spyOn(ChatSession.prototype, "send")
    .mockResolvedValue(undefined);
  await enterPrompt("你好");
  for (const options of [
    { isComposing: true },
    { keyCode: 229 },
    { shiftKey: true },
    { altKey: true },
    { repeat: true },
  ]) {
    await act(async () =>
      composer().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          ...options,
        }),
      ),
    );
  }
  expect(sent).not.toHaveBeenCalled();
  await enterPrompt("你好，新问题");
  await act(async () =>
    composer().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(sent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ prompt: "你好，新问题" }),
  );
  expect(composer().value).toBe("");
});

it("keeps streamed answer deltas out of the reader while accepting new draft input", async () => {
  vi.mocked(api.chatSessions).mockResolvedValue([
    {
      id: "stream",
      documentId: doc.id,
      title: "test",
      provider: "api",
      createdAt: "now",
      updatedAt: "now",
    },
  ]);
  let emit!: (event: ChatStreamEvent) => void, finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session = new ChatSession(doc.id, {
    messages: async () => [],
    stream: async (_doc, _input, _signal, callback) => {
      emit = callback;
      await waiting;
    },
  });
  vi.spyOn(sessionRegistry, "getChatSession").mockReturnValue(session);
  let running: Promise<void> | undefined;
  try {
    await act(async () => render(0));
    await act(async () =>
      panels.readerReady?.({
        getLocation: () => undefined,
      } as unknown as ReaderAdapter),
    );
    await act(async () => {
      running = session.send({
        provider: "api",
        prompt: "question",
        context: "",
        references: [],
        attachments: [],
      });
    });
    await enterPrompt("new draft");
    // Settle the reader's initial frame before measuring streamed updates.
    await act(async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const before = panels.readerRenders;
    for (const text of ["first", " second", " third"]) {
      await act(async () => {
        emit({ event: "delta", data: { text } });
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    await enterPrompt("new draft typed while streaming");
    expect(panels.readerRenders).toBe(before);
    expect(composer().value).toBe("new draft typed while streaming");
    expect(session.getSnapshot().pending?.content).toBe("first second third");
  } finally {
    await act(async () => {
      finish();
      await running;
    });
    session.dispose();
  }
});

it("appends selected chat text to the current draft without creating a document citation", async () => {
  await act(async () => render(0));
  await enterPrompt("existing draft");
  await act(async () => panels.assistant!.onQuote!("first line\nsecond line"));
  expect(composer().value).toBe(
    "existing draft\n\n> first line\n> second line\n\n",
  );
  expect(host.querySelector(".quote-chips")).toBeNull();
  expect(tabCloseWarning(doc.id)).not.toBeNull();
  await act(async () => render(1));
  expect(composer().value).toContain("> second line");
});
