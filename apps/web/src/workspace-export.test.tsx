// @vitest-environment jsdom
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme, type Processing } from "@reader/core";
import { TooltipProvider } from "@reader/ui/components/tooltip";
import { api } from "@reader/api";
import { Workspace } from "./Workspace";
import { paper } from "./papers/fixtures";
import { useReaderStore } from "./store";
import type { ResizablePanelGroup } from "@reader/ui/components/resizable";
type GroupProps = ComponentProps<typeof ResizablePanelGroup>;

const panels = vi.hoisted(() => ({
  props: undefined as GroupProps | undefined,
}));

vi.mock("@reader/api", () => ({
  api: {
    aiConfig: vi.fn(async () => ({
      primary: "",
      models: {},
      capabilities: {},
    })),
    recoverAnnotations: vi.fn(async () => ({ checked: true })),
    annotations: vi.fn(async () => []),
    messages: vi.fn(async () => []),
    blocks: vi.fn(async () => []),
    documentNote: vi.fn(async () => ({ body: "note", updatedAt: "" })),
    translations: vi.fn(async () => []),
  },
  setDiagnosticReporter: vi.fn(),
  blockImageURL: vi.fn(),
  publicationURL: vi.fn(),
}));
vi.mock("./progress", () => ({
  scheduleProgress: vi.fn(),
  flushProgress: vi.fn(async () => {}),
}));
vi.mock("./translation/PDFReadingView", () => ({ PDFReadingView: () => null }));
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
vi.mock("./NotesPanel", () => ({
  NotesPanel: ({ onExport }: { onExport: () => void }) => (
    <button onClick={onExport}>导出</button>
  ),
}));
vi.mock("@reader/ui/components/resizable", async () => {
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
  useReaderStore.setState({ theme: defaultTheme });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

it("restores user sidebar sizes and collapsed state without replacing expanded sizes with zero", async () => {
  function Reader() {
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
  await act(async () => root.render(<Reader />));
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
  await act(async () => root.render(<Reader />));
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

it("checks annotations once on opening, before loading marks, not on progress updates", async () => {
  await act(async () => render(0));
  expect(api.recoverAnnotations).toHaveBeenCalledExactlyOnceWith(doc.id);
  expect(
    vi.mocked(api.recoverAnnotations).mock.invocationCallOrder[0],
  ).toBeLessThan(vi.mocked(api.annotations).mock.invocationCallOrder[0]);
  await act(async () => render(1));
  expect(api.recoverAnnotations).toHaveBeenCalledTimes(1);
});
