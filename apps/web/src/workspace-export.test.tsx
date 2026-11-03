// @vitest-environment jsdom
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Processing,
  type ReaderEvents,
} from "@neoread/core";
import { TooltipProvider } from "@neoread/ui/components/tooltip";
import { api } from "@neoread/api";
import { Workspace } from "./Workspace";
import { paper } from "./papers/fixtures";
import { useReaderStore } from "./store";
import type { ResizablePanelGroup } from "@neoread/ui/components/resizable";
type GroupProps = ComponentProps<typeof ResizablePanelGroup>;

const panels = vi.hoisted(() => ({
  props: undefined as GroupProps | undefined,
  readerEvents: undefined as ReaderEvents | undefined,
  readerRenders: 0,
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
  PDFReadingView: ({ events }: { events: ReaderEvents }) => {
    panels.readerRenders++;
    panels.readerEvents = events;
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  useReaderStore.setState({ theme: defaultTheme });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

it("updates the active outline heading when reading moves within one PDF page", async () => {
  vi.mocked(api.blocks).mockResolvedValueOnce(
    [0.1, 0.7].map((y, i) => ({
      id: `heading-${i}`,
      page: 1,
      label: "paragraph_title",
      text: `Section ${i + 1}`,
      bounds: { x: 0.1, y, width: 0.8, height: 0.05 },
    })),
  );
  await act(async () => render(0));
  const heading = (name: string) =>
    host.querySelector<HTMLElement>(`[aria-label="目录：${name}"]`)!;
  await act(async () =>
    panels.readerEvents!.location(
      { type: "pdf", page: 1, x: 0.1, y: 0.12 },
      0.5,
    ),
  );
  expect(heading("Section 1").classList.contains("selected")).toBe(true);
  const renders = panels.readerRenders;
  for (let i = 0; i < 30; i++)
    await act(async () =>
      panels.readerEvents!.location(
        { type: "pdf", page: 1, x: 0.1, y: 0.15 + i * 0.019 },
        0.5,
      ),
    );
  expect(panels.readerRenders).toBe(renders);
  await act(async () =>
    panels.readerEvents!.location(
      { type: "pdf", page: 1, x: 0.1, y: 0.72 },
      0.5,
    ),
  );
  expect(heading("Section 2").classList.contains("selected")).toBe(true);
  expect(heading("Section 1").classList.contains("selected")).toBe(false);
});

it("dismisses stale selection toolbars on collapse or outside clicks while keeping toolbar actions usable", async () => {
  await act(async () => render(0));
  const text = document.createElement("p");
  text.textContent = "selected reading text";
  host.append(text);
  const select = async () => {
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () =>
      panels.readerEvents!.selection({
        text: text.textContent!,
        location: { type: "pdf", page: 1 },
        anchor: { x: 30, top: 20, bottom: 40 },
      }),
    );
    expect(host.querySelector(".selection-bar")).not.toBeNull();
  };
  await select();
  await act(async () =>
    host
      .querySelector(".selection-bar button")!
      .dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      ),
  );
  expect(host.querySelector(".selection-bar")).not.toBeNull();
  await act(async () => {
    window.getSelection()!.collapseToStart();
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(host.querySelector(".selection-bar")).toBeNull();
  await select();
  await act(async () =>
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    ),
  );
  expect(host.querySelector(".selection-bar")).toBeNull();
  await select();
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(host.querySelector(".selection-bar")).toBeNull();
  window.getSelection()!.removeAllRanges();
  text.remove();
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
