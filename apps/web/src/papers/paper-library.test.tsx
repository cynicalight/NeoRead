// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import type { Document, Processing } from "@neoread/core";
import { useReaderStore } from "../store";
import { PaperLibrary } from "./PaperLibrary";
import { doubleClickWindow } from "../DetailSheet";
import { PaperSidebar } from "./PaperSidebar";
import { usePaperUI } from "./state";
import { useAttachments } from "./attachments";
import * as attachments from "./attachments";
import { paper } from "./fixtures";
import { exportAnnotatedPDFWithToast } from "../annotated-pdf-export";
vi.mock("../annotated-pdf-export", () => ({
  exportAnnotatedPDFWithToast: vi.fn(async () => 1),
}));
vi.mock("@neoread/api", () => ({
  api: {
    paperAttachments: vi.fn(async () => []),
    snapshotStatus: vi.fn(async () => ({ available: false })),
    journalRankConfig: vi.fn(async () => ({
      enabled: true,
      hasKey: false,
      selected: [],
      available: [],
    })),
    update: vi.fn(async () => ({})),
    documents: vi.fn(async () => []),
    trash: vi.fn(async () => []),
    trashDocument: vi.fn(),
    restoreDocument: vi.fn(),
    saveLibraryPreferences: vi.fn(async (value) => value),
    changeLibraryTag: vi.fn(async () => ({ changed: 1 })),
    changeLibraryFolder: vi.fn(async () => ({ changed: 1 })),
    mergeDocuments: vi.fn(async () => ({ trashed: [] })),
    relateDocuments: vi.fn(async () => ({})),
    unrelateDocuments: vi.fn(async () => ({})),
    process: vi.fn(async () => ({})),
    setAssistance: vi.fn(async () => ({})),
  },
}));
vi.mock("./AttachmentPreview", () => ({
  default: () => <div role="dialog">Attachment preview</div>,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
const docs: Document[] = [
  paper({
    id: "a",
    title: "Attention Is All You Need",
    folders: ["ML"],
    metadata: {
      creators: [{ given: "Ashish", family: "Vaswani" }],
      date: "2017",
      venue: "NeurIPS",
      abstract: "The dominant sequence transduction models…",
    },
  }),
  paper({ id: "b", title: "Graph Attention Networks", readingStatus: "done" }),
];
let root: Root, host: HTMLDivElement;
const open = vi.fn();
let jobs = new Map<string, Processing>();
const openMany = vi.fn();
function Harness({ navOpen = true }: { navOpen?: boolean } = {}) {
  const documents = useReaderStore((s) => s.documents);
  return (
    <>
      {navOpen && (
        <PaperSidebar
          documents={documents}
          jobs={jobs}
          trashCount={0}
          openDocument={open}
          onNewCategory={() => {}}
        />
      )}
      <PaperLibrary
        documents={documents}
        trash={[]}
        jobs={jobs}
        loading={false}
        openDocument={open}
        openDocuments={openMany}
        moveToBooks={() => {}}
        navOpen={navOpen}
        onToggleNav={() => {}}
      />
    </>
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  vi.mocked(api.paperAttachments).mockResolvedValue([]);
  jobs = new Map();
  useAttachments.setState({
    items: {},
    errors: {},
    uploads: {},
    expanded: new Set(),
    selected: null,
    preview: null,
    adding: null,
  });
  vi.mocked(api.documents).mockImplementation(
    async () => useReaderStore.getState().documents,
  );
  useReaderStore.setState({
    documents: docs,
    libraryPreferences: { mode: "papers", papers: { sort: "title" } },
  });
  usePaperUI.setState({
    view: "all",
    query: "",
    tagFilter: { tags: [], match: "all" },
    selectedId: null,
    picking: false,
    picked: new Set(),
    anchor: null,
    naming: null,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const row = (title: string) =>
  host.querySelector<HTMLElement>(`[aria-label="${title}"][data-paper-id]`)!;
const navButton = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(".paper-nav-item")].find((b) =>
    b.textContent?.includes(label),
  )!;
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) =>
      b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  )!;

const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  )!;

it("shows details on click and saves an edited field as manual metadata", async () => {
  await act(async () => row("Attention Is All You Need").click());
  const detail = host.querySelector(".paper-detail")!;
  const venue = detail.querySelector<HTMLInputElement>('[aria-label="出处"]')!;
  expect(venue.value).toBe("NeurIPS");
  venue.value = "NIPS 2017";
  await act(async () => {
    venue.focus();
    venue.blur();
  });
  expect(api.update).toHaveBeenCalledExactlyOnceWith("a", {
    metadata: { venue: "NIPS 2017" },
  });
});

it("selects all visible papers and changes their status together", async () => {
  await act(async () =>
    row("Attention Is All You Need").dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true }),
    ),
  );
  expect(host.textContent).toContain("已选 2 篇");
  await act(async () => row("Attention Is All You Need").click());
  expect(host.textContent).toContain("已选 1 篇");
  const star = [...host.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === "星标",
  )!;
  await act(async () => star.click());
  expect(api.update).toHaveBeenCalledExactlyOnceWith("b", { favorite: true });
});

it("leaves batch mode after selected papers move to the trash", async () => {
  vi.mocked(api.trashDocument).mockResolvedValue(docs[0]);
  await act(async () => button("批量").click());
  await act(async () => row("Attention Is All You Need").click());
  expect(host.textContent).toContain("已选 1 篇");

  await act(async () => button("移到回收站").click());

  expect(usePaperUI.getState().picking).toBe(false);
  expect(usePaperUI.getState().picked.size).toBe(0);
  expect(button("批量")).toBeDefined();
});

it("leaves batch mode after trashing selected papers from their context menu", async () => {
  vi.mocked(api.trashDocument).mockResolvedValue(docs[0]);
  await act(async () => button("批量").click());
  await act(async () => row("Attention Is All You Need").click());
  await act(async () =>
    row("Attention Is All You Need").dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    ),
  );
  const trash = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent?.includes("移到回收站"))!;

  await act(async () => trash.click());

  expect(usePaperUI.getState().picking).toBe(false);
  expect(usePaperUI.getState().picked.size).toBe(0);
});

it("keeps failed papers selected in batch mode for retry", async () => {
  await act(async () =>
    row("Attention Is All You Need").dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true }),
    ),
  );
  vi.mocked(api.trashDocument).mockImplementation(async (id) => {
    if (id === "b") throw Error("offline");
    return docs[0];
  });

  await act(async () => button("移到回收站").click());

  expect(usePaperUI.getState().picking).toBe(true);
  expect([...usePaperUI.getState().picked]).toEqual(["b"]);
  expect(host.textContent).toContain("已选 1 篇");
});

it("renames a category everywhere through the library endpoint", async () => {
  await act(async () =>
    navButton("ML").dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    ),
  );
  const rename = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent === "改名")!;
  await act(async () => rename.click());
  const input = host.querySelector<HTMLInputElement>('[aria-label="分类名"]')!;
  input.value = "Machine learning";
  await act(async () =>
    input.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.changeLibraryFolder).toHaveBeenCalledExactlyOnceWith(
    "papers",
    "ML",
    "Machine learning",
  );
});

it("shows subcategories under their parent and renames only the leaf", async () => {
  await act(async () =>
    useReaderStore.setState({
      documents: [{ ...docs[0], folders: ["ML/Vision"] }, docs[1]],
    }),
  );
  expect(navButton("ML").textContent).toContain("1");
  await act(async () => navButton("ML").click());
  expect(host.querySelectorAll("[data-paper-id]")).toHaveLength(1);
  await act(async () =>
    navButton("Vision").dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    ),
  );
  const rename = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent === "改名")!;
  await act(async () => rename.click());
  const input = host.querySelector<HTMLInputElement>('[aria-label="分类名"]')!;
  expect(input.value).toBe("Vision");
  input.value = "CV";
  await act(async () =>
    input.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.changeLibraryFolder).toHaveBeenCalledExactlyOnceWith(
    "papers",
    "ML/Vision",
    "ML/CV",
  );
  const twisty = host.querySelector<HTMLButtonElement>(
    '[aria-label="折叠“ML”"]',
  )!;
  await act(async () => twisty.click());
  expect(api.saveLibraryPreferences).toHaveBeenCalledWith(
    expect.objectContaining({
      papers: expect.objectContaining({ collapsed: ["ML"] }),
    }),
  );
});

it("merges duplicates into the version with the reading work", async () => {
  await act(async () =>
    useReaderStore.setState({
      documents: [
        { ...docs[0], metadata: { ...docs[0].metadata, doi: "10.1/x" } },
        paper({
          id: "c",
          title: "Attention is all you need (preprint)",
          noteCount: 3,
          metadata: { doi: "10.1/X" },
        }),
        docs[1],
      ],
    }),
  );
  await act(async () => navButton("重复的论文").click());
  expect(host.querySelectorAll("[data-paper-id]")).toHaveLength(2);
  const merge = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "合并…",
  )!;
  await act(async () => merge.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(
    dialog
      .querySelector('[role="radio"][aria-checked="true"]')
      ?.closest("label")?.textContent,
  ).toContain("preprint");
  const confirm = [...dialog.querySelectorAll("button")].find(
    (b) => b.textContent === "合并",
  )!;
  await act(async () => confirm.click());
  expect(api.mergeDocuments).toHaveBeenCalledExactlyOnceWith("c", ["a"]);
});

it("toggles a colored category with its number key", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: {
          sort: "title",
          colorCategories: [
            { name: "Todo", color: "#e5534b" },
            { name: "ML", color: "#4a8fe0" },
          ],
        },
      },
    }),
  );
  expect(
    row("Attention Is All You Need")
      .querySelector(".paper-row-colors")
      ?.getAttribute("aria-label"),
  ).toBe("ML");
  await act(async () => row("Graph Attention Networks").click());
  await act(async () =>
    row("Graph Attention Networks").dispatchEvent(
      new KeyboardEvent("keydown", { key: "1", bubbles: true }),
    ),
  );
  expect(api.update).toHaveBeenCalledExactlyOnceWith("b", {
    folders: ["Todo"],
  });
});

it("links related papers from the detail panel", async () => {
  await act(async () =>
    useReaderStore.setState({
      documents: [{ ...docs[0], related: ["b", "gone"] }, docs[1]],
    }),
  );
  await act(async () => row("Attention Is All You Need").click());
  const section = host.querySelector(".paper-related")!;
  expect(section.textContent).toContain("Graph Attention Networks");
  await act(async () =>
    section
      .querySelector<HTMLButtonElement>(
        '[aria-label="取消关联 Graph Attention Networks"]',
      )!
      .click(),
  );
  expect(api.unrelateDocuments).toHaveBeenCalledExactlyOnceWith("a", "b");
});

it("edits authors as capsules", async () => {
  await act(async () => row("Attention Is All You Need").click());
  const detail = host.querySelector(".paper-detail")!;
  expect(detail.textContent).not.toContain("论文详情");
  expect(detail.querySelector('[aria-label="阅读状态"]')).toBeNull();
  const add = detail.querySelector<HTMLButtonElement>(
    'button[aria-label="添加作者"]',
  )!;
  await act(async () => add.click());
  const input = detail.querySelector<HTMLInputElement>(
    'input[aria-label="添加作者"]',
  )!;
  input.value = "Shazeer, Noam";
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(api.update).toHaveBeenLastCalledWith("a", {
    metadata: {
      creators: [
        { given: "Ashish", family: "Vaswani" },
        { family: "Shazeer", given: "Noam" },
      ],
    },
  });
  await act(async () =>
    detail
      .querySelector<HTMLButtonElement>(
        'button[aria-label="删除作者 Ashish Vaswani"]',
      )!
      .click(),
  );
  expect(api.update).toHaveBeenLastCalledWith("a", {
    metadata: { creators: [{ family: "Shazeer", given: "Noam" }] },
  });
});

it("offers existing tags when adding one from the detail panel", async () => {
  await act(async () =>
    useReaderStore.setState({
      documents: [{ ...docs[0], tags: ["Transformer", "NLP"] }, docs[1]],
    }),
  );
  await act(async () => row("Graph Attention Networks").click());
  await waitOutDoubleClick();
  const detail = host.querySelector(".paper-detail")!;
  await act(async () =>
    detail
      .querySelector<HTMLButtonElement>('button[aria-label="添加标签"]')!
      .click(),
  );
  const dialog = document.querySelector('[role="dialog"]:not(.detail-sheet)')!;
  const suggestion = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((b) => b.textContent === "#Transformer")!;
  await act(async () => suggestion.click());
  expect(api.update).not.toHaveBeenCalled();
  await act(async () =>
    dialog
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(api.update).toHaveBeenLastCalledWith("b", { tags: ["Transformer"] });
});

it("tags a paper and collects it in a smart tag category", async () => {
  await act(async () => row("Graph Attention Networks").click());
  await waitOutDoubleClick();
  const detail = host.querySelector(".paper-detail")!;
  await act(async () =>
    detail
      .querySelector<HTMLButtonElement>('button[aria-label="添加标签"]')!
      .click(),
  );
  const dialog = document.querySelector('[role="dialog"]:not(.detail-sheet)')!;
  const input = dialog.querySelector<HTMLInputElement>(
    'input[aria-label="标签名"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "#GNN");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Moving focus to the explicit submit button must not dismiss or save the editor.
  await act(async () =>
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.focus(),
  );
  expect(document.querySelector('[role="dialog"]:not(.detail-sheet)')).toBe(
    dialog,
  );
  expect(input.value).toBe("#GNN");
  expect(api.update).not.toHaveBeenCalled();
  await act(async () =>
    dialog
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(api.update).toHaveBeenLastCalledWith("b", { tags: ["GNN"] });
  await act(async () =>
    useReaderStore.setState({
      documents: [docs[0], { ...docs[1], tags: ["GNN"] }],
      libraryPreferences: {
        mode: "papers",
        papers: {
          sort: "title",
          smartCategories: [{ id: "s", name: "图网络", tags: ["gnn"] }],
        },
      },
    }),
  );
  await act(async () => navButton("图网络").click());
  expect(host.querySelector(".library-title")?.textContent).toBe("图网络");
  expect(host.querySelectorAll("[data-paper-id]")).toHaveLength(1);
});

it.each(["list", "table"] as const)(
  "retries a failed translation in %s view without opening the paper or posting twice",
  async (layout) => {
    jobs = new Map([
      [
        "a",
        {
          documentId: "a",
          phase: "translating",
          status: "failed",
          pagesDone: 20,
          pagesTotal: 20,
          translationsDone: 5,
          translationsTotal: 20,
          detail: "翻译失败",
          updatedAt: "2026-10-08T00:00:00Z",
        },
      ],
    ]);
    await act(async () => {
      useReaderStore.setState({
        libraryPreferences: {
          mode: "papers",
          papers: { layout, columns: ["year"] },
        },
      });
      root.render(<Harness />);
    });
    const retry = row(
      "Attention Is All You Need",
    ).querySelector<HTMLButtonElement>('[aria-label="重试翻译"]')!;
    expect(retry).not.toBeNull();
    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(api.process).toHaveBeenCalledExactlyOnceWith("a");
    expect(retry.disabled).toBe(true);
    expect(usePaperUI.getState().selectedId).toBeNull();
    expect(open).not.toHaveBeenCalled();
  },
);

const prefs = () => useReaderStore.getState().libraryPreferences.papers ?? {};
const press = (target: Element, type: string, clientX = 0) =>
  act(async () => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, button: 0, clientX }),
    );
  });
const waitOutDoubleClick = () =>
  act(() => new Promise((done) => setTimeout(done, doubleClickWindow + 20)));

const fakeWidths = (widths: Record<string, number>) =>
  vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      if (this.classList.contains("paper-column-heading")) {
        const column = this.closest<HTMLElement>("th")?.dataset.column;
        return {
          width: widths[`minimum:${column}`] ?? (column === "title" ? 160 : 48),
        } as DOMRect;
      }
      const key =
        (this as HTMLElement).dataset?.column ??
        (this.classList.contains("detail-sheet")
          ? "detail"
          : this.getAttribute("aria-hidden") === "true"
            ? "filler"
            : "");
      return { width: widths[key] ?? 0 } as DOMRect;
    });

it("closes the detail panel when pressing empty library space", async () => {
  await act(async () => usePaperUI.setState({ selectedId: "a" }));
  await press(host.querySelector(".paper-detail")!, "pointerdown");
  expect(usePaperUI.getState().selectedId).toBe("a");
  await press(host.querySelector(".paper-list-pane")!, "pointerdown");
  expect(usePaperUI.getState().selectedId).toBeNull();
  expect(host.querySelector(".paper-detail")).toBeNull();
});

it("drags the detail panel edge and saves the width once released", async () => {
  const rects = fakeWidths({ detail: 360 });
  await act(async () => usePaperUI.setState({ selectedId: "a" }));
  const edge = host.querySelector<HTMLElement>(
    '[aria-label="调整论文详情宽度"]',
  )!;
  await press(edge, "pointerdown", 600);
  await press(edge, "pointermove", 500);
  const sheet = host.querySelector<HTMLElement>(".detail-sheet")!;
  expect(sheet.style.getPropertyValue("--paper-detail-width")).toBe("460px");
  expect(prefs().detailWidth).toBeUndefined();
  await press(edge, "pointerup", 500);
  expect(prefs().detailWidth).toBe(460);
  expect(api.saveLibraryPreferences).toHaveBeenCalled();
  await act(async () =>
    edge.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(prefs().detailWidth).toBe(344);
  rects.mockRestore();
});

it("resizes table columns at their shared boundary", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: {
          sort: "title",
          layout: "table",
          columns: ["authors", "year", "venue", "status"],
        },
      },
    }),
  );
  const rects = fakeWidths({ title: 400, authors: 160, year: 64 });
  const titleEdge = host.querySelector<HTMLElement>(
    '[aria-label="调整标题列宽度"]',
  )!;
  // Widening the title takes the space from the authors column.
  await press(titleEdge, "pointerdown", 400);
  await press(titleEdge, "pointermove", 440);
  expect(
    host.querySelector<HTMLElement>('th[data-column="authors"]')!.style.width,
  ).toBe("120px");
  await press(titleEdge, "pointerup", 440);
  expect(prefs().columnWidths).toEqual({ title: 440, authors: 120 });
  // The final column can be resized without changing the menu column.
  expect(host.querySelector('[aria-label="调整状态列宽度"]')).not.toBeNull();
  await act(async () =>
    host
      .querySelector('[aria-label="调整作者列宽度"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
  );
  expect(prefs().columnWidths).toEqual({ title: 440, authors: 176, year: 48 });
  rects.mockRestore();
});

it.each(["list", "table"] as const)(
  "does not show paused Zotero imports as parsing in %s view",
  async (layout) => {
    jobs = new Map([
      [
        "a",
        {
          documentId: "a",
          enabled: false,
          phase: "learning",
          status: "paused",
          pagesDone: 0,
          pagesTotal: 0,
          translationsDone: 0,
          translationsTotal: 0,
          detail: "翻译未开始",
          updatedAt: "2026-10-10T09:00:00Z",
        },
      ],
    ]);
    await act(async () => {
      useReaderStore.setState({
        libraryPreferences: { mode: "papers", papers: { layout } },
      });
      root.render(<Harness />);
    });
    expect(
      row("Attention Is All You Need").querySelector(".paper-title-processing"),
    ).toBeNull();
    expect(navButton("解析中")).toBeUndefined();
    expect(api.process).not.toHaveBeenCalled();
    // When explicitly started, both the row progress and sidebar return.
    jobs.set("a", { ...jobs.get("a")!, enabled: true, status: "running" });
    await act(async () => root.render(<Harness />));
    expect(row("Attention Is All You Need").textContent).toContain("解析中");
    expect(navButton("解析中")).toBeDefined();
  },
);

it("exports selected PDFs sequentially and prevents duplicate batch exports", async () => {
  let finishFirst!: (value: number) => void;
  vi.mocked(exportAnnotatedPDFWithToast).mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        finishFirst = resolve;
      }),
  );
  await act(async () =>
    useReaderStore.setState({
      documents: [...docs, paper({ id: "epub", title: "EPUB", type: "epub" })],
    }),
  );
  await act(async () => button("批量").click());
  expect(button("导出").disabled).toBe(true);
  await act(async () => usePaperUI.getState().setPicked(["epub"]));
  expect(button("导出").disabled).toBe(true);
  await act(async () => usePaperUI.getState().setPicked(["b", "a", "epub"]));
  const trigger = button("导出");
  await act(async () => {
    trigger.click();
    trigger.click();
  });
  expect(exportAnnotatedPDFWithToast).toHaveBeenCalledExactlyOnceWith(docs[1]);
  expect(trigger.disabled).toBe(true);
  // Changing the selection during export does not change the captured batch.
  await act(async () => usePaperUI.getState().setPicked(["epub"]));
  await act(async () => finishFirst(1));
  expect(exportAnnotatedPDFWithToast).toHaveBeenCalledTimes(2);
  expect(exportAnnotatedPDFWithToast).toHaveBeenNthCalledWith(2, docs[0]);
  expect(button("导出").disabled).toBe(true);
});

it("shows optional metadata columns and sorts publication dates without inventing missing precision", async () => {
  await act(async () =>
    useReaderStore.setState({
      documents: [
        paper({
          id: "full",
          title: "Full date",
          tags: ["Security", "A long tag that should truncate"],
          metadata: {
            date: "2024-02-29",
            doi: "10.1000/example",
            arxiv: "2402.12345",
          },
          percentage: 0.42,
          size: 1048576,
        }),
        paper({ id: "year", title: "Year only", metadata: { date: "2024" } }),
        paper({ id: "empty", title: "Missing date", lastOpenedAt: "" }),
      ],
      libraryPreferences: {
        mode: "papers",
        papers: {
          layout: "table",
          sort: "published",
          columns: [
            "published",
            "tags",
            "progress",
            "doi",
            "arxiv",
            "size",
            "opened",
          ],
          columnWidths: { published: 144 },
        },
      },
    }),
  );
  const full = row("Full date");
  expect(full.querySelector('[data-column="published"]')?.textContent).toBe(
    "2024-02-29",
  );
  expect(
    row("Year only").querySelector('[data-column="published"]')?.textContent,
  ).toBe("2024");
  expect(full.querySelector('[data-column="progress"]')?.textContent).toBe(
    "42%",
  );
  expect(full.querySelector('[data-column="size"]')?.textContent).toBe(
    "1.0 MB",
  );
  expect(full.querySelector('[data-column="doi"]')?.textContent).toBe(
    "10.1000/example",
  );
  expect(full.querySelector('[data-column="arxiv"]')?.textContent).toBe(
    "2402.12345",
  );
  expect(
    full.querySelector(".paper-table-tags")?.getAttribute("title"),
  ).toContain("Security");
  expect(
    row("Missing date").querySelector('[data-column="opened"]')?.textContent,
  ).toBe("未打开");
  expect(
    host.querySelector('th[data-column="published"]')?.getAttribute("style"),
  ).toContain("144px");
  expect(
    host
      .querySelector('th[data-column="tags"] button')
      ?.getAttribute("aria-label"),
  ).toBe("按标签筛选");
  await act(async () => button("发表日期").click());
  expect(
    [...host.querySelectorAll("tbody [data-paper-id]")].map((el) =>
      el.getAttribute("data-paper-id"),
    ),
  ).toEqual(["year", "full", "empty"]);
  expect(
    host
      .querySelector('th[data-column="published"]')
      ?.getAttribute("aria-sort"),
  ).toBe("ascending");
  expect(api.saveLibraryPreferences).toHaveBeenCalled();
});

it.each(["list", "table"] as const)(
  "shows manual translation after parsing in %s view",
  async (layout) => {
    const job: Processing = {
      documentId: "a",
      enabled: true,
      phase: "learning",
      status: "running",
      pagesDone: 10,
      pagesTotal: 60,
      translationsDone: 0,
      translationsTotal: 1,
      detail: "解析中",
      updatedAt: "2026-10-16T00:00:00Z",
    };
    jobs = new Map([["a", job]]);
    await act(async () => {
      useReaderStore.setState({
        libraryPreferences: { mode: "papers", papers: { layout } },
      });
      root.render(<Harness />);
    });
    expect(row("Attention Is All You Need").textContent).not.toContain("翻译");
    jobs.set("a", {
      ...job,
      enabled: false,
      phase: "translating",
      status: "paused",
      pagesDone: 60,
      manualTranslation: true,
    });
    await act(async () => root.render(<Harness />));
    const button = Array.from(
      row("Attention Is All You Need").querySelectorAll("button"),
    ).find((button) => button.textContent === "翻译")!;
    expect(button).toBeDefined();
    await act(async () => button.click());
    expect(api.setAssistance).toHaveBeenCalledWith("a", "start");
    expect(open).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
  },
);

it.each(["list", "table"] as const)(
  "combines temporary tags with search in the %s view and clears only tags",
  async (layout) => {
    await act(async () => {
      useReaderStore.setState({
        documents: [
          { ...docs[0], tags: ["RAG", "Agent"] },
          { ...docs[1], tags: ["RAG"] },
        ],
        libraryPreferences: {
          mode: "papers",
          papers: { layout, columns: ["tags"] },
        },
      });
      usePaperUI.getState().setQuery("Attention");
      usePaperUI
        .getState()
        .setTagFilter({ tags: ["rag", "AGENT"], match: "all" });
    });
    expect(row("Attention Is All You Need")).not.toBeNull();
    expect(row("Graph Attention Networks")).toBeNull();
    await act(async () =>
      usePaperUI
        .getState()
        .setTagFilter({ tags: ["rag", "Agent"], match: "any" }),
    );
    expect(row("Graph Attention Networks")).not.toBeNull();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="清除当前标签条件"]')!
        .click(),
    );
    expect(usePaperUI.getState().tagFilter.tags).toEqual([]);
    expect(usePaperUI.getState().query).toBe("Attention");
    expect(api.update).not.toHaveBeenCalled();
    expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
  },
);

it("can recover from an empty tag result using the list reset action", async () => {
  await act(async () =>
    usePaperUI.getState().setTagFilter({ tags: ["missing"], match: "all" }),
  );
  expect(host.textContent).toContain("没有符合条件的论文");
  await act(async () => button("显示全部论文").click());
  expect(usePaperUI.getState().tagFilter.tags).toEqual([]);
  expect(row("Attention Is All You Need")).not.toBeNull();
});

it("selects tags in the popover, switches AND/OR and keeps zero-result selections removable", async () => {
  await act(async () =>
    useReaderStore.setState({
      documents: [
        { ...docs[0], tags: ["RAG", "Agent"] },
        { ...docs[1], tags: ["rag"] },
        paper({ id: "c", title: "Agent Survey", tags: ["Agent"] }),
      ],
      libraryPreferences: { mode: "papers", papers: { layout: "table" } },
    }),
  );
  expect(
    host.querySelector('.paper-sidebar [aria-label="标签筛选"]'),
  ).toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="按标签筛选"]')!.click(),
  );
  const popover = document.querySelector('[data-slot="popover-content"]')!;
  const matchButton = (label: string) =>
    [...popover.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === label,
    )!;
  const tag = (name: string) =>
    popover.querySelector<HTMLButtonElement>(
      `[aria-label="筛选标签 ${name}"]`,
    )!;
  expect(popover.querySelectorAll('[aria-label="筛选标签 rag"]')).toHaveLength(
    0,
  );
  await act(async () => tag("RAG").click());
  expect(row("Agent Survey")).toBeNull();
  expect(tag("Agent").textContent).toContain("1");
  await act(async () => tag("Agent").click());
  expect(row("Graph Attention Networks")).toBeNull();
  await act(async () => matchButton("任一 OR").click());
  expect(row("Graph Attention Networks")).not.toBeNull();
  expect(row("Agent Survey")).not.toBeNull();
  await act(async () => {
    matchButton("全部 AND").click();
    usePaperUI.getState().setQuery("Graph");
  });
  expect(host.textContent).toContain("没有符合条件的论文");
  expect(tag("Agent").disabled).toBe(false);
  expect(tag("Agent").textContent).toContain("0");
  expect(tag("Agent")).not.toBeNull();
  await act(async () => tag("Agent").click());
  expect(row("Graph Attention Networks")).not.toBeNull();
  expect(usePaperUI.getState().query).toBe("Graph");
  expect(api.update).not.toHaveBeenCalled();
  expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
});

it("closes the tag popover with its trigger without clearing selected tags", async () => {
  await act(async () => {
    useReaderStore.setState({
      documents: [{ ...docs[0], tags: ["RAG"] }, docs[1]],
      libraryPreferences: { mode: "papers", papers: { layout: "table" } },
    });
    root.render(<Harness navOpen={false} />);
  });
  const trigger = host.querySelector<HTMLButtonElement>(
    '[aria-label="按标签筛选"]',
  )!;
  await act(async () => trigger.click());
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () => trigger.click());
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="筛选标签 RAG"]')!
      .click(),
  );
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(usePaperUI.getState().tagFilter.tags).toEqual(["RAG"]);
});

it("clears temporary tags when opening a cited paper for metadata editing", async () => {
  await act(async () => {
    usePaperUI.getState().setTagFilter({ tags: ["missing"], match: "all" });
    usePaperUI.getState().setExporting({ ids: ["b"], title: "Demo" });
  });
  const edit = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === "去补",
  )!;
  expect(edit).toBeDefined();
  await act(async () => edit.click());
  expect(usePaperUI.getState().tagFilter.tags).toEqual([]);
  expect(row("Graph Attention Networks")).not.toBeNull();
  expect(usePaperUI.getState().selectedId).toBe("b");
});

it("does not run paper-list shortcuts from the tag column popover", async () => {
  await act(async () =>
    useReaderStore.setState({
      documents: [{ ...docs[0], tags: ["RAG"] }, docs[1]],
      libraryPreferences: {
        mode: "papers",
        papers: { layout: "table", columns: ["tags"] },
      },
    }),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="按标签筛选"]')!.click(),
  );
  const target = document.querySelector<HTMLButtonElement>(
    '[data-slot="popover-content"] button[aria-pressed]',
  )!;
  await act(async () => target.focus());
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }),
    );
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  expect(usePaperUI.getState().picking).toBe(false);
  expect(document.activeElement).toBe(target);
  expect(api.update).not.toHaveBeenCalled();
});

it("defaults tags to the second column and has no extra tag toolbar button", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: { mode: "papers", papers: { layout: "table" } },
    }),
  );
  expect(
    [...host.querySelectorAll("th[data-column]")]
      .slice(0, 2)
      .map((th) => th.getAttribute("data-column")),
  ).toEqual(["title", "tags"]);
  expect(host.querySelector('[aria-label="打开标签筛选"]')).toBeNull();
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: { layout: "table", columns: ["authors"] },
      },
    }),
  );
  expect(host.querySelector('[aria-label="按标签筛选"]')).toBeNull();
  expect(host.querySelector('[aria-label="打开标签筛选"]')).toBeNull();
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: { mode: "papers", papers: { layout: "list" } },
    }),
  );
  expect(host.querySelector('[aria-label="打开标签筛选"]')).toBeNull();
});

it("filters matching row tags across categories and keeps the current search", async () => {
  await act(async () =>
    useReaderStore.setState({
      documents: [
        { ...docs[0], tags: ["RAG"], folders: ["ML"] },
        { ...docs[1], tags: ["rag"], folders: ["Graphs"] },
        paper({ id: "c", title: "Attention without tags" }),
      ],
      libraryPreferences: {
        mode: "papers",
        papers: { layout: "table", columns: ["tags"] },
      },
    }),
  );
  await act(async () => usePaperUI.getState().setQuery("Attention"));
  const tag = row("Attention Is All You Need").querySelector<HTMLButtonElement>(
    '[aria-label="按 AND 筛选标签 RAG"]',
  );
  expect(tag).not.toBeNull();
  await act(async () => tag!.click());
  expect(usePaperUI.getState().tagFilter).toEqual({
    tags: ["RAG"],
    match: "all",
  });
  expect(row("Graph Attention Networks")).not.toBeNull();
  expect(row("Attention without tags")).toBeNull();
  expect(host.querySelector(".paper-detail")).toBeNull();
  await act(async () =>
    row("Graph Attention Networks")
      .querySelector<HTMLButtonElement>('[aria-label="按 AND 筛选标签 rag"]')!
      .click(),
  );
  expect(usePaperUI.getState().tagFilter.tags).toEqual(["RAG"]);
  await act(async () => usePaperUI.getState().setView("folder:ML"));
  expect(row("Graph Attention Networks")).toBeNull();
  await act(async () => usePaperUI.getState().setView("all"));
  expect(row("Graph Attention Networks")).not.toBeNull();
  expect(usePaperUI.getState().query).toBe("Attention");
  expect(api.update).not.toHaveBeenCalled();
  expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
});

it("adds row tags with AND without opening papers or invoking list shortcuts", async () => {
  await act(async () => {
    useReaderStore.setState({
      documents: [
        { ...docs[0], tags: ["RAG", "Agent"] },
        { ...docs[1], tags: ["RAG"] },
      ],
      libraryPreferences: {
        mode: "papers",
        papers: { layout: "table", columns: ["tags"] },
      },
    });
    usePaperUI.getState().setTagFilter({ tags: ["RAG"], match: "any" });
  });
  const tag = row("Attention Is All You Need").querySelector<HTMLButtonElement>(
    '[aria-label="按 AND 筛选标签 Agent"]',
  );
  expect(tag).not.toBeNull();
  expect(tag!.tagName).toBe("BUTTON");
  await act(async () => {
    tag!.focus();
    for (const key of ["Enter", " ", "ArrowDown", "1"])
      tag!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    tag!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }),
    );
  });
  expect(usePaperUI.getState().selectedId).toBeNull();
  expect(usePaperUI.getState().picking).toBe(false);
  expect(document.activeElement).toBe(tag);
  await act(async () => {
    tag!.click();
    tag!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(usePaperUI.getState().tagFilter).toEqual({
    tags: ["RAG", "Agent"],
    match: "all",
  });
  expect(row("Graph Attention Networks")).toBeNull();
  expect(host.querySelector(".paper-detail")).toBeNull();
  expect(open).not.toHaveBeenCalled();
  expect(api.update).not.toHaveBeenCalled();
});

const dragColumn = async (element: Element, type: string, x = 0, y = 0) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  const transfer = {
    setData: vi.fn(),
    setDragImage: vi.fn(),
    effectAllowed: "",
    dropEffect: "",
  };
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  await act(async () => element.dispatchEvent(event));
  return transfer;
};
it.each(["list", "table"] as const)(
  "uses a compact independent drag image in %s view without changing selected paper IDs",
  async (view) => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    await act(async () => {
      useReaderStore.getState().setLibraryPreferences({
        mode: "papers",
        papers: { layout: view },
      });
      usePaperUI.setState({ picking: true, picked: new Set(["a", "b"]) });
    });
    const transfer = await dragColumn(row(docs[0].title), "dragstart");
    expect(transfer.setData).toHaveBeenCalledWith(
      "application/x-neoread-papers",
      JSON.stringify(["a", "b"]),
    );
    const [preview, x, y] = transfer.setDragImage.mock.calls[0];
    expect(preview.parentElement).toBe(document.body);
    expect(preview.className).toBe("paper-drag-preview");
    expect(preview.textContent).toBe(`${docs[0].title}2 篇论文`);
    expect(preview.querySelector("button, table, article, [id]")).toBeNull();
    expect([x, y]).toEqual([20, 20]);
    await dragColumn(row(docs[0].title), "dragend");
    expect(preview.isConnected).toBe(false);
  },
);
const headerColumns = () =>
  [...host.querySelectorAll("th[data-column]")].map((el) =>
    el.getAttribute("data-column"),
  );
const columnGrip = (name: string, scope: ParentNode = host) =>
  scope.querySelector<HTMLButtonElement>(
    name === "标签" && scope === host
      ? '[aria-label="按标签筛选"]'
      : `[aria-label="移动${name}列"]`,
  )!;

const layoutColumnTargets = (scope: ParentNode, vertical = false) => {
  const targets = scope.querySelectorAll<HTMLElement>(
    vertical ? ".paper-column-option" : "th[data-column]",
  );
  targets.forEach((target, index) => {
    const start = index * (vertical ? 32 : 100);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      left: vertical ? 0 : start,
      top: vertical ? start : 0,
      width: 100,
      height: 32,
      right: vertical ? 100 : start + 100,
      bottom: vertical ? start + 32 : 32,
    } as DOMRect);
  });
};

it("reorders headers and the column picker together, including the title", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: {
          layout: "table",
          columns: ["authors", "year", "tags"],
          columnWidths: { authors: 180 },
        },
      },
    }),
  );
  expect(host.querySelector("th .paper-column-grip")).toBeNull();
  expect(host.querySelectorAll('th[data-column="title"] button')).toHaveLength(
    1,
  );
  expect(columnGrip("标题").textContent).toBe("标题");
  layoutColumnTargets(host);
  await dragColumn(columnGrip("标签"), "dragstart");
  const title = host.querySelector('th[data-column="title"]')!;
  await dragColumn(title, "dragover", -1);
  const table = title.closest("table")!;
  expect(table.style.getPropertyValue("--column-title")).toBe("100px");
  expect(table.style.getPropertyValue("--column-tags")).toBe("-300px");
  expect(headerColumns()).toEqual(["title", "authors", "year", "tags"]);
  expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
  await dragColumn(
    row("Attention Is All You Need").querySelector('td[data-column="title"]')!,
    "drop",
    -1,
  );
  expect(headerColumns()).toEqual(["tags", "title", "authors", "year"]);
  expect(
    [
      ...row("Attention Is All You Need").querySelectorAll("td[data-column]"),
    ].map((el) => el.getAttribute("data-column")),
  ).toEqual(headerColumns());
  expect(prefs().columnWidths).toEqual({ authors: 180 });
  expect(api.saveLibraryPreferences).toHaveBeenCalledTimes(1);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="显示的列"]')!.click(),
  );
  const popup = document.querySelector('[aria-label="显示与排列列"]')!;
  const pickerColumns = () =>
    [...popup.querySelectorAll("[data-column]")].map((el) =>
      el.getAttribute("data-column"),
    );
  expect(pickerColumns().slice(0, 4)).toEqual(headerColumns());
  layoutColumnTargets(popup, true);
  await dragColumn(columnGrip("标题", popup), "dragstart");
  const year = popup.querySelector('[data-column="year"]')!;
  await dragColumn(year, "dragover", 0, 116);
  expect(
    (popup as HTMLElement).style.getPropertyValue("--column-authors"),
  ).toBe("-32px");
  expect(api.saveLibraryPreferences).toHaveBeenCalledTimes(1);
  await dragColumn(popup, "drop", 0, 116);
  expect(api.saveLibraryPreferences).toHaveBeenCalledTimes(2);
  expect(headerColumns()).toEqual(["tags", "authors", "year", "title"]);
  expect(pickerColumns().slice(0, 4)).toEqual(headerColumns());
  const checkbox = popup.querySelector<HTMLButtonElement>(
    '[aria-label="显示标签列"]',
  )!;
  await act(async () => checkbox.click());
  expect(headerColumns()).toEqual(["authors", "year", "title"]);
  await act(async () => checkbox.click());
  expect(headerColumns()).toEqual(["tags", "authors", "year", "title"]);
  const saved = useReaderStore.getState().libraryPreferences;
  await act(async () => {
    root.unmount();
    root = createRoot(host);
    useReaderStore.setState({ libraryPreferences: saved });
    root.render(<Harness />);
  });
  expect(headerColumns()).toEqual(["tags", "authors", "year", "title"]);
});

it("cancels column dragging without saving and supports keyboard moves without sorting", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: { layout: "table", columns: ["authors", "year"] },
      },
    }),
  );
  layoutColumnTargets(host);
  await dragColumn(columnGrip("年份"), "dragstart");
  await dragColumn(
    host.querySelector('th[data-column="title"]')!,
    "dragover",
    -1,
  );
  await dragColumn(columnGrip("年份"), "dragend");
  expect(host.querySelector("[data-column-reordering]")).toBeNull();
  expect(headerColumns()).toEqual(["title", "authors", "year"]);
  expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
  await act(async () =>
    columnGrip("年份").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    ),
  );
  expect(headerColumns()).toEqual(["title", "year", "authors"]);
  expect(prefs().sort).toBeUndefined();
  expect(usePaperUI.getState().selectedId).toBeNull();
  expect(usePaperUI.getState().picking).toBe(false);
});

it("preserves column positions when hiding before the first reorder", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: { layout: "table", columns: ["authors", "year", "tags"] },
      },
    }),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="显示的列"]')!.click(),
  );
  const popup = document.querySelector('[aria-label="显示与排列列"]')!;
  const checkbox = popup.querySelector<HTMLButtonElement>(
    '[aria-label="显示作者列"]',
  )!;
  await act(async () => checkbox.click());
  expect(headerColumns()).toEqual(["title", "year", "tags"]);
  expect(
    [...popup.querySelectorAll("[data-column]")]
      .slice(0, 4)
      .map((el) => el.getAttribute("data-column")),
  ).toEqual(["title", "authors", "year", "tags"]);
  await act(async () => checkbox.click());
  expect(headerColumns()).toEqual(["title", "authors", "year", "tags"]);
});

it("captures a lower picker row at its own origin with the actual pointer hotspot", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: { mode: "papers", papers: { layout: "table" } },
    }),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="显示的列"]')!.click(),
  );
  const popup = document.querySelector('[aria-label="显示与排列列"]')!;
  const source = popup.querySelector<HTMLElement>('[data-column="status"]')!;
  vi.spyOn(source, "getBoundingClientRect").mockReturnValue({
    x: 800,
    y: 420,
    left: 800,
    top: 420,
    width: 180,
    height: 32,
    right: 980,
    bottom: 452,
    toJSON: () => ({}),
  });
  const transfer = await dragColumn(
    columnGrip("状态", popup),
    "dragstart",
    809,
    433,
  );
  const [preview, x, y] = transfer.setDragImage.mock.calls[0];
  expect(preview).not.toBe(source);
  expect(preview.style.position).toBe("fixed");
  expect(preview.style.top).toBe("0px");
  expect(preview.style.height).toBe("32px");
  expect([x, y]).toEqual([9, 13]);
  await dragColumn(columnGrip("状态", popup), "dragend");
  expect(document.querySelector(".paper-column-drag-preview")).toBeNull();
});

it("closes the column picker with Escape from a focused drag handle", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: { mode: "papers", papers: { layout: "table" } },
    }),
  );
  const trigger = host.querySelector<HTMLButtonElement>(
    '[aria-label="显示的列"]',
  )!;
  await act(async () => trigger.click());
  const popup = document.querySelector('[aria-label="显示与排列列"]')!;
  const handle = columnGrip("作者", popup);
  await act(async () => handle.focus());
  await act(async () =>
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
});

it("does not save when a live drag returns to its original slot", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: { layout: "table", columns: ["authors", "year"] },
      },
    }),
  );
  layoutColumnTargets(host);
  const title = host.querySelector('th[data-column="title"]')!;
  const year = host.querySelector('th[data-column="year"]')!;
  await dragColumn(columnGrip("年份"), "dragstart", 210);
  await dragColumn(title, "dragover", 10);
  expect(title.closest("table")!.style.getPropertyValue("--column-title")).toBe(
    "100px",
  );
  await dragColumn(year, "dragover", 210);
  expect(title.closest("table")!.style.getPropertyValue("--column-title")).toBe(
    "0px",
  );
  await dragColumn(year, "drop", 210);
  expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
  expect(headerColumns()).toEqual(["title", "authors", "year"]);
});

it("removes live drag styles on unmount without saving", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: { layout: "table", columns: ["authors", "year"] },
      },
    }),
  );
  layoutColumnTargets(host);
  await dragColumn(columnGrip("年份"), "dragstart");
  await dragColumn(
    host.querySelector('th[data-column="title"]')!,
    "dragover",
    -1,
  );
  expect(document.head.textContent).toContain("data-column-reordering");
  await act(async () => root.render(null));
  expect(document.head.textContent).not.toContain("data-column-reordering");
  expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
});

it.each([
  ["title", "authors", "year"],
  ["authors", "title", "year"],
  ["authors", "year", "title"],
])(
  "resizes and persists the title at any position: %s, %s, %s",
  async (...columnOrder) => {
    await act(async () =>
      useReaderStore.setState({
        libraryPreferences: {
          mode: "papers",
          papers: {
            layout: "table",
            columns: ["authors", "year"],
            columnWidths: { title: 400 },
            columnOrder: columnOrder as ("title" | "authors" | "year")[],
          },
        },
      }),
    );
    const rects = fakeWidths({
      title: 400,
      authors: 160,
      year: 64,
      filler: 100,
    });
    try {
      const edge = host.querySelector<HTMLElement>(
        '[aria-label="调整标题列宽度"]',
      );
      expect(edge).not.toBeNull();
      await press(edge!, "pointerdown", 400);
      await press(edge!, "pointermove", 416);
      expect(
        host.querySelector<HTMLElement>('th[data-column="title"]')!.style.width,
      ).toBe("416px");
      expect(
        host.querySelector<HTMLTableElement>(".paper-table table")!.style.width,
      ).toBe("100%");
      expect(
        host.querySelector<HTMLTableElement>(".paper-table table")!.style
          .minWidth,
      ).toBe(columnOrder[2] === "title" ? "672px" : "656px");
      expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
      await press(edge!, "pointerup", 416);
      expect(prefs().columnWidths).toHaveProperty("title", 416);
      const saved = useReaderStore.getState().libraryPreferences;
      await act(async () =>
        useReaderStore.setState({
          libraryPreferences: {
            ...saved,
            papers: { ...saved.papers, layout: "list" },
          },
        }),
      );
      await act(async () =>
        useReaderStore.setState({ libraryPreferences: saved }),
      );
      expect(
        host.querySelector<HTMLElement>('th[data-column="title"]')!.style.width,
      ).toBe("416px");
    } finally {
      rects.mockRestore();
    }
  },
);

it("hides and restores the title from the column picker without losing order or width", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: {
          layout: "table",
          columns: ["authors", "year"],
          columnOrder: ["authors", "title", "year"],
          columnWidths: { title: 360 },
        },
      },
    }),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="显示的列"]')!.click(),
  );
  const title = document.querySelector<HTMLElement>(
    '[aria-label="显示标题列"]',
  )!;
  expect(title.getAttribute("aria-checked")).toBe("true");
  await act(async () => title.click());
  expect(host.querySelector('th[data-column="title"]')).toBeNull();
  expect(
    row("Attention Is All You Need").querySelector('td[data-column="title"]'),
  ).toBeNull();
  expect(headerColumns()).toEqual(["authors", "year"]);
  const saved = useReaderStore.getState().libraryPreferences;
  await act(async () =>
    useReaderStore.setState({ libraryPreferences: structuredClone(saved) }),
  );
  expect(headerColumns()).toEqual(["authors", "year"]);
  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label="显示标题列"]')!.click(),
  );
  expect(headerColumns()).toEqual(["authors", "title", "year"]);
  expect(
    host.querySelector<HTMLElement>('th[data-column="title"]')!.style.width,
  ).toBe("360px");
  expect(
    row("Attention Is All You Need").querySelector('td[data-column="title"]')
      ?.textContent,
  ).toContain("Attention Is All You Need");
});

it("stops the final metadata boundary when there is no spare space", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: { layout: "table", columns: ["authors", "year"] },
      },
    }),
  );
  const rects = fakeWidths({ title: 400, authors: 160, year: 64 });
  try {
    const edge = host.querySelector<HTMLElement>(
      '[aria-label="调整年份列宽度"]',
    )!;
    await press(edge, "pointerdown", 624);
    await press(edge, "pointermove", 664);
    expect(
      host.querySelector<HTMLTableElement>(".paper-table table")!.style.width,
    ).toBe("100%");
    expect(
      host.querySelector<HTMLTableElement>(".paper-table table")!.style
        .minWidth,
    ).toBe("656px");
    expect(
      host.querySelector<HTMLElement>('th[data-column="title"]')!.style.width,
    ).toBe("400px");
    await press(edge, "pointerup", 664);
    expect(prefs().columnWidths).toEqual({ title: 400, year: 64 });
  } finally {
    rects.mockRestore();
  }
});

const supplement = {
  id: "supp",
  documentId: "a",
  kind: "file" as const,
  title: "Supplementary material",
  filename: "supplement.pdf",
  mediaType: "application/pdf",
  size: 2000,
  url: "",
  createdAt: "2026-10-23T00:00:00Z",
};
it("expands child attachments in both list and table without adding paper selections", async () => {
  vi.mocked(api.paperAttachments).mockResolvedValue([supplement]);
  await act(async () =>
    useReaderStore.setState({
      documents: [{ ...docs[0], attachmentCount: 1 }, docs[1]],
    }),
  );
  await act(async () =>
    button("展开 Attention Is All You Need 的附件").click(),
  );
  expect(host.querySelectorAll("[data-paper-id]")).toHaveLength(2);
  expect(host.querySelectorAll("[data-attachment-row]")).toHaveLength(2);
  const child = host.querySelector<HTMLElement>(
    '[data-attachment-row="supp"]',
  )!;
  await act(async () => child.click());
  await waitOutDoubleClick();
  expect(host.querySelector('[aria-label="附件详情"]')?.textContent).toContain(
    "supplement.pdf",
  );
  expect(usePaperUI.getState().picked.size).toBe(0);
  await act(async () =>
    child.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(useAttachments.getState().preview?.item.id).toBe("supp");
  await act(async () => useAttachments.setState({ preview: null }));
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: { sort: "title", layout: "table" },
      },
    }),
  );
  for (const configuration of [
    {},
    { columnWidths: { title: 360 } },
    { showTitle: false },
  ]) {
    await act(async () =>
      useReaderStore.setState({
        libraryPreferences: {
          mode: "papers",
          papers: { sort: "title", layout: "table", ...configuration },
        },
      }),
    );
    const table = host.querySelector<HTMLTableElement>(".paper-table table")!;
    const columnCount = table.querySelectorAll("thead th").length;
    for (const cell of table.querySelectorAll<HTMLTableCellElement>(
      "tr[data-attachment-row] td[colspan]",
    )) {
      expect(cell.colSpan).toBe(columnCount);
    }
    expect(table.querySelectorAll("tr[data-attachment-row]")).toHaveLength(2);
  }
});
it("expands and collapses attachment children with the keyboard", async () => {
  vi.mocked(api.paperAttachments).mockResolvedValue([supplement]);
  await act(async () =>
    useReaderStore.setState({
      documents: [{ ...docs[0], attachmentCount: 1 }, docs[1]],
    }),
  );
  await act(async () =>
    row(docs[0].title).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  const child = host.querySelector<HTMLElement>(
    '[data-attachment-row="supp"]',
  )!;
  expect(child).not.toBeNull();
  await act(async () => {
    child.focus();
    child.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
  });
  expect(host.querySelector("[data-attachment-row]")).toBeNull();
  expect(document.activeElement).toBe(row(docs[0].title));
});

it("opens attachment rename and removal from the child context menu", async () => {
  vi.mocked(api.paperAttachments).mockResolvedValue([supplement]);
  await act(async () =>
    useReaderStore.setState({
      documents: [{ ...docs[0], attachmentCount: 1 }, docs[1]],
    }),
  );
  await act(async () =>
    button("展开 Attention Is All You Need 的附件").click(),
  );
  const child = host.querySelector<HTMLElement>(
    '[data-attachment-row="supp"]',
  )!;
  const context = async () =>
    act(async () =>
      child.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      ),
    );
  await context();
  await act(async () => menuItem("重命名").click());
  expect(
    document.querySelector('[role="dialog"]:not(.detail-sheet)')?.textContent,
  ).toContain("重命名附件");
  await act(async () =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="dialog"]:not(.detail-sheet) button',
      ),
    ]
      .find((b) => b.textContent === "取消")!
      .click(),
  );
  await context();
  await act(async () => menuItem("移除附件…").click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Supplementary material",
  );
});

it.each(["list", "table"] as const)(
  "accepts direct file drops on expanded parent and child rows in %s layout",
  async (layout) => {
    const upload = vi
      .spyOn(attachments, "uploadAttachments")
      .mockResolvedValue();
    const file = new File(["supplement"], "new-supplement.pdf");
    vi.mocked(api.paperAttachments).mockResolvedValue([supplement]);
    try {
      await act(async () =>
        useReaderStore.setState({
          documents: [{ ...docs[0], attachmentCount: 1 }, docs[1]],
          libraryPreferences: {
            mode: "papers",
            papers: { layout, sort: "title" },
          },
        }),
      );
      await act(async () =>
        button("展开 Attention Is All You Need 的附件").click(),
      );
      const targets = [
        row(docs[0].title),
        host.querySelector<HTMLElement>('[data-attachment-row="primary"]')!,
        host.querySelector<HTMLElement>('[data-attachment-row="supp"]')!,
      ];
      const bubbled = vi.fn();
      document.body.addEventListener("drop", bubbled);
      for (const target of targets) {
        const event = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", {
          value: { types: ["Files"], files: [file] },
        });
        await act(async () => target.dispatchEvent(event));
      }
      expect(upload).toHaveBeenCalledTimes(3);
      expect(upload).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "a" }),
        [file],
      );
      expect(bubbled).not.toHaveBeenCalled();
      document.body.removeEventListener("drop", bubbled);
    } finally {
      upload.mockRestore();
    }
  },
);

it("requires dwell after the final attachment and visible expansion disappear", async () => {
  const upload = vi.spyOn(attachments, "uploadAttachments").mockResolvedValue();
  try {
    await act(async () =>
      useAttachments.setState({ expanded: new Set(["a"]), items: { a: [] } }),
    );
    expect(host.querySelector("[data-attachment-row]")).toBeNull();
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: ["Files"], files: [new File(["a"], "file.pdf")] },
    });
    await act(async () => row(docs[0].title).dispatchEvent(event));
    expect(upload).not.toHaveBeenCalled();
  } finally {
    upload.mockRestore();
  }
});

it.each([true, false])(
  "fills the paper pane after saving widths (showTitle=%s)",
  async (showTitle) => {
    await act(async () =>
      useReaderStore.setState({
        libraryPreferences: {
          mode: "papers",
          papers: {
            layout: "table",
            showTitle,
            columns: ["authors", "year"],
            columnOrder: ["authors", "title", "year"],
            columnWidths: { title: 360 },
          },
        },
      }),
    );
    const table = host.querySelector<HTMLTableElement>(".paper-table table")!;
    expect(table.style.width).toBe("100%");
    expect(table.style.minWidth).toBe(showTitle ? "616px" : "256px");
    expect(headerColumns()).toEqual(
      showTitle ? ["authors", "title", "year"] : ["authors", "year"],
    );
    expect(prefs().columnWidths).toEqual({ title: 360 });
    const filler = table.querySelector<HTMLElement>(
      "thead th[aria-hidden=true]",
    )!;
    expect(filler.style.padding).toBe("0px");
    expect(filler.nextElementSibling).toBe(
      table.querySelector("thead th:last-child"),
    );
    for (const row of table.querySelectorAll("tbody tr")) {
      expect(row.querySelector("td[aria-hidden=true]")).not.toBeNull();
      expect(row.children.length).toBe(showTitle ? 5 : 4);
    }
  },
);

it("keeps the default title flexible until a final-column shrink saves its width", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: { layout: "table", columns: ["year"] },
      },
    }),
  );
  const table = host.querySelector<HTMLTableElement>(".paper-table table")!;
  expect(table.querySelector("th[aria-hidden=true]")).toBeNull();
  expect(
    table.querySelector<HTMLElement>('th[data-column="title"]')!.style.width,
  ).toBe("");
  const rects = fakeWidths({ title: 400, year: 64 });
  try {
    const edge = host.querySelector<HTMLElement>(
      '[aria-label="调整年份列宽度"]',
    )!;
    await press(edge, "pointerdown", 464);
    await press(edge, "pointermove", 448);
    expect(table.querySelector("th[aria-hidden=true]")).not.toBeNull();
    expect(
      table.querySelector<HTMLElement>('th[data-column="title"]')!.style.width,
    ).toBe("400px");
    expect(
      table.querySelector<HTMLElement>('th[data-column="year"]')!.style.width,
    ).toBe("48px");
    expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
    await press(edge, "pointerup", 448);
    expect(prefs().columnWidths).toEqual({ title: 400, year: 48 });
    expect(table.querySelector("th[aria-hidden=true]")).not.toBeNull();
  } finally {
    rects.mockRestore();
  }
});

it.each([false, true])(
  "fills space without stretching narrow columns (picking=%s)",
  async (picking) => {
    await act(async () => {
      useReaderStore.setState({
        libraryPreferences: {
          mode: "papers",
          papers: {
            layout: "table",
            showTitle: false,
            columns: ["year", "status"],
          },
        },
      });
      usePaperUI.setState({ picking });
    });
    const table = host.querySelector<HTMLTableElement>(".paper-table table")!;
    expect(table.style.minWidth).toBe(picking ? "200px" : "168px");
    expect(
      table.querySelector<HTMLElement>('th[data-column="year"]')!.style.width,
    ).toBe("64px");
    expect(
      table.querySelector<HTMLElement>('th[data-column="status"]')!.style.width,
    ).toBe("72px");
    expect(table.querySelector("th[aria-hidden=true]")).not.toBeNull();
    expect(table.querySelector("tbody tr")!.children.length).toBe(
      picking ? 5 : 4,
    );
    await act(async () => usePaperUI.getState().setQuery("no-such-paper"));
    expect(table.querySelector("tbody td")!.getAttribute("colspan")).toBe(
      picking ? "5" : "4",
    );
  },
);

it("keeps resizing after hiding the last column and persists the expanded width", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: {
          layout: "table",
          columns: ["authors", "year"],
          columnWidths: { title: 496, authors: 48 },
        },
      },
    }),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="显示的列"]')!.click(),
  );
  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label="显示年份列"]')!.click(),
  );
  expect(headerColumns()).toEqual(["title", "authors"]);
  expect(host.querySelector('td[data-column="year"]')).toBeNull();
  vi.mocked(api.saveLibraryPreferences).mockClear();
  const rects = fakeWidths({ title: 496, authors: 48, filler: 300 });
  try {
    const edge = host.querySelector<HTMLElement>(
      '[aria-label="调整标题列宽度"]',
    )!;
    const table = host.querySelector<HTMLTableElement>(".paper-table table")!;
    await press(edge, "pointerdown", 496);
    for (const [dx, title, authors] of [
      [64, 560, 48],
      [800, 796, 48],
      [784, 780, 64],
    ]) {
      await press(edge, "pointermove", 496 + dx);
      expect(
        table.querySelector<HTMLElement>('th[data-column="title"]')!.style
          .width,
      ).toBe(`${title}px`);
      expect(
        table.querySelector<HTMLElement>('th[data-column="authors"]')!.style
          .width,
      ).toBe(`${authors}px`);
      expect(table.style.minWidth).toBe(`${title + authors + 32}px`);
      expect(table.style.width).toBe("100%");
    }
    expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
    await press(edge, "pointerup", 1280);
    expect(prefs().columnWidths).toEqual({ title: 780, authors: 64 });
    const saved = structuredClone(useReaderStore.getState().libraryPreferences);
    await act(async () =>
      useReaderStore.setState({ libraryPreferences: saved }),
    );
    expect(
      table.querySelector<HTMLElement>('th[data-column="title"]')!.style.width,
    ).toBe("780px");
  } finally {
    rects.mockRestore();
  }
});

it("compresses visible columns in order when dragging the second boundary", async () => {
  const widths = { title: 400, authors: 160, year: 64, status: 72, venue: 150 };
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: {
          layout: "table",
          columns: ["authors", "year", "status", "venue"],
          columnOrder: ["title", "authors", "year", "status", "venue"],
          columnWidths: widths,
        },
      },
    }),
  );
  const rects = fakeWidths({ ...widths, filler: 80 });
  try {
    const edge = host.querySelector<HTMLElement>(
      '[aria-label="调整作者列宽度"]',
    )!;
    await press(edge, "pointerdown", 560);
    for (const [dx, year, status, venue] of [
      [10, 54, 72, 150],
      [30, 48, 58, 150],
      [60, 48, 48, 130],
      [200, 48, 48, 48],
      [500, 48, 48, 48],
    ]) {
      await press(edge, "pointermove", 560 + dx);
      expect(
        Number.parseFloat(
          host.querySelector<HTMLTableElement>(".paper-table table")!.style
            .minWidth,
        ),
      ).toBeLessThanOrEqual(958);
      for (const [column, width] of Object.entries({
        title: 400,
        authors: 160 + Math.min(dx, 222),
        year,
        status,
        venue,
      })) {
        expect(
          host.querySelector<HTMLElement>(`th[data-column="${column}"]`)!.style
            .width,
        ).toBe(`${width}px`);
      }
    }
    expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
    await press(edge, "pointerup", 1060);
    expect(prefs().columnWidths).toEqual({
      ...widths,
      authors: 382,
      year: 48,
      status: 48,
      venue: 48,
    });
  } finally {
    rects.mockRestore();
  }
});

it.each(["ArrowRight", "ArrowLeft"])(
  "uses sequential compression for keyboard resizing with %s",
  async (key) => {
    const widths =
      key === "ArrowRight"
        ? { title: 400, authors: 160, year: 48, status: 56, venue: 150 }
        : { title: 200, authors: 48, year: 48, status: 64, venue: 80 };
    await act(async () =>
      useReaderStore.setState({
        libraryPreferences: {
          mode: "papers",
          papers: {
            layout: "table",
            columns: ["authors", "year", "status", "venue"],
            columnOrder: ["title", "authors", "year", "status", "venue"],
            columnWidths: widths,
          },
        },
      }),
    );
    const rects = fakeWidths(widths);
    try {
      await act(async () =>
        host
          .querySelector(
            key === "ArrowRight"
              ? '[aria-label="调整作者列宽度"]'
              : '[aria-label="调整年份列宽度"]',
          )!
          .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
      );
      expect(prefs().columnWidths).toEqual(
        key === "ArrowRight"
          ? { ...widths, authors: 176, status: 48, venue: 142 }
          : { ...widths, title: 184, status: 80 },
      );
    } finally {
      rects.mockRestore();
    }
  },
);

it("compresses columns to the left in nearest-first order and stops at their minimums", async () => {
  const widths = { title: 200, authors: 80, year: 64, status: 64, venue: 80 };
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: {
          layout: "table",
          columns: ["authors", "year", "status", "venue"],
          columnOrder: ["title", "authors", "year", "status", "venue"],
          columnWidths: widths,
        },
      },
    }),
  );
  const rects = fakeWidths({ ...widths, filler: 80 });
  try {
    const edge = host.querySelector<HTMLElement>(
      '[aria-label="调整状态列宽度"]',
    )!;
    await press(edge, "pointerdown", 408);
    for (const [dx, title, authors, year, status, venue] of [
      [-8, 200, 80, 64, 56, 88],
      [-24, 200, 80, 56, 48, 104],
      [-48, 200, 64, 48, 48, 128],
      [-80, 184, 48, 48, 48, 160],
      [-999, 160, 48, 48, 48, 184],
    ]) {
      await press(edge, "pointermove", 408 + dx);
      for (const [column, width] of Object.entries({
        title,
        authors,
        year,
        status,
        venue,
      })) {
        expect(
          host.querySelector<HTMLElement>(`th[data-column="${column}"]`)!.style
            .width,
        ).toBe(`${width}px`);
      }
      expect(
        host.querySelector<HTMLTableElement>(".paper-table table")!.style
          .minWidth,
      ).toBe("520px");
    }
    expect(api.saveLibraryPreferences).not.toHaveBeenCalled();
    await press(edge, "pointerup", -591);
    expect(prefs().columnWidths).toEqual({
      title: 160,
      authors: 48,
      year: 48,
      status: 48,
      venue: 184,
    });
  } finally {
    rects.mockRestore();
  }
});

it.each(["right", "left"])(
  "keeps displaced columns in place when reversing a %s drag",
  async (direction) => {
    const widths = { title: 200, authors: 80, year: 64, status: 64, venue: 80 };
    await act(async () =>
      useReaderStore.setState({
        libraryPreferences: {
          mode: "papers",
          papers: {
            layout: "table",
            columns: ["authors", "year", "status", "venue"],
            columnOrder: ["title", "authors", "year", "status", "venue"],
            columnWidths: widths,
          },
        },
      }),
    );
    const rects = fakeWidths(widths);
    try {
      const edge = host.querySelector<HTMLElement>(
        direction === "right"
          ? '[aria-label="调整作者列宽度"]'
          : '[aria-label="调整状态列宽度"]',
      )!;
      const sign = direction === "right" ? 1 : -1;
      await press(edge, "pointerdown", 400);
      await press(edge, "pointermove", 400 + sign * 32);
      await press(edge, "pointermove", 400 + sign * 24);
      const expected =
        direction === "right"
          ? { ...widths, authors: 104, year: 56, status: 48 }
          : { ...widths, year: 48, status: 56, venue: 104 };
      for (const [column, width] of Object.entries(expected)) {
        expect(
          host.querySelector<HTMLElement>(`th[data-column="${column}"]`)!.style
            .width,
        ).toBe(`${width}px`);
      }
      await press(edge, "pointerup", 400 + sign * 24);
      expect(prefs().columnWidths).toEqual(expected);
    } finally {
      rects.mockRestore();
    }
  },
);

it("accounts for consumed and released spare space across repeated drag reversals", async () => {
  await act(async () =>
    useReaderStore.setState({
      libraryPreferences: {
        mode: "papers",
        papers: {
          layout: "table",
          columns: ["authors"],
          columnWidths: { title: 400, authors: 160 },
        },
      },
    }),
  );
  const rects = fakeWidths({ title: 400, authors: 160, filler: 80 });
  try {
    const edge = host.querySelector<HTMLElement>(
      '[aria-label="调整作者列宽度"]',
    )!;
    await press(edge, "pointerdown", 560);
    for (const [dx, width] of [
      [60, 220],
      [100, 240],
      [84, 224],
      [100, 240],
      [200, 240],
    ]) {
      await press(edge, "pointermove", 560 + dx);
      expect(
        host.querySelector<HTMLElement>('th[data-column="authors"]')!.style
          .width,
      ).toBe(`${width}px`);
      expect(
        Number.parseFloat(
          host.querySelector<HTMLTableElement>(".paper-table table")!.style
            .minWidth,
        ),
      ).toBeLessThanOrEqual(672);
    }
    await press(edge, "pointerup", 760);
    expect(prefs().columnWidths).toEqual({ title: 400, authors: 240 });
  } finally {
    rects.mockRestore();
  }
});

it("uses measured header minimums for pointer and keyboard resizing", async () => {
  const measuredWidths = {
    title: 200,
    authors: 160,
    year: 100,
    "minimum:title": 42,
    "minimum:authors": 76,
    "minimum:year": 68,
  };
  const rects = fakeWidths(measuredWidths);
  try {
    await act(async () =>
      useReaderStore.setState({
        libraryPreferences: {
          mode: "papers",
          papers: {
            layout: "table",
            columns: ["authors", "year"],
            columnWidths: { title: 200, authors: 160, year: 100 },
          },
        },
      }),
    );
    const edge = host.querySelector<HTMLElement>(
      '[aria-label="调整标题列宽度"]',
    )!;
    await press(edge, "pointerdown", 200);
    await press(edge, "pointermove", 1000);
    await press(edge, "pointerup", 1000);
    expect(prefs().columnWidths).toEqual({ title: 316, authors: 76, year: 68 });
    Object.assign(measuredWidths, prefs().columnWidths);
    await act(async () =>
      edge.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
        }),
      ),
    );
    expect(prefs().columnWidths).toEqual({
      title: 300,
      authors: 92,
      year: 68,
    });
  } finally {
    rects.mockRestore();
  }
});

it("fits saved narrow widths to the complete header without overwriting preferences", async () => {
  const rects = fakeWidths({ "minimum:authors": 92, "minimum:title": 42 });
  try {
    await act(async () =>
      useReaderStore.setState({
        libraryPreferences: {
          mode: "papers",
          papers: {
            layout: "table",
            columns: ["authors"],
            columnWidths: { title: 42, authors: 48 },
          },
        },
      }),
    );
    const heading = host.querySelector<HTMLElement>(
      'th[data-column="authors"]',
    )!;
    expect(heading.style.width).toBe("92px");
    expect(heading.querySelector(".truncate")).toBeNull();
    expect(prefs().columnWidths?.authors).toBe(48);
  } finally {
    rects.mockRestore();
  }
});

it("opens picked papers together in document tabs and exits batch mode", async () => {
  await act(async () =>
    usePaperUI.getState().startPicking(docs.slice(0, 2).map((doc) => doc.id)),
  );
  await act(async () => button("在标签页中打开").click());
  expect(openMany).toHaveBeenCalledOnce();
  expect(
    openMany.mock.calls[0][0].map((doc: Document) => doc.id).sort(),
  ).toEqual(
    docs
      .slice(0, 2)
      .map((doc) => doc.id)
      .sort(),
  );
  expect(usePaperUI.getState().picking).toBe(false);
});
