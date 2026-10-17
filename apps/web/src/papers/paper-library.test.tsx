// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import type { Document, Processing } from "@reader/core";
import { useReaderStore } from "../store";
import { PaperLibrary } from "./PaperLibrary";
import { PaperSidebar } from "./PaperSidebar";
import { usePaperUI } from "./state";
import { paper } from "./fixtures";
vi.mock("@reader/api", () => ({
  api: {
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
function Harness() {
  const documents = useReaderStore((s) => s.documents);
  return (
    <>
      <PaperSidebar
        documents={documents}
        jobs={jobs}
        trashCount={0}
        openDocument={open}
        onNewCategory={() => {}}
      />
      <PaperLibrary
        documents={documents}
        trash={[]}
        jobs={jobs}
        loading={false}
        openDocument={open}
        moveToBooks={() => {}}
        navOpen
        onToggleNav={() => {}}
      />
    </>
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  jobs = new Map();
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
    (b) => b.textContent?.trim() === label,
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
    (b) => b.textContent === "星标",
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

it("tags a paper and collects it in a smart tag category", async () => {
  await act(async () => row("Graph Attention Networks").click());
  const detail = host.querySelector(".paper-detail")!;
  await act(async () =>
    detail
      .querySelector<HTMLButtonElement>('button[aria-label="添加标签"]')!
      .click(),
  );
  const input = detail.querySelector<HTMLInputElement>(
    'input[aria-label="添加标签"]',
  )!;
  input.value = "#GNN";
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
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
const fakeWidths = (widths: Record<string, number>) =>
  vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const key =
        (this as HTMLElement).dataset?.column ??
        (this.classList.contains("paper-detail") ? "detail" : "");
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
  const body = host.querySelector<HTMLElement>(".paper-library-body")!;
  expect(body.style.getPropertyValue("--paper-detail-width")).toBe("460px");
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
        papers: { sort: "title", layout: "table" },
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
  expect(prefs().columnWidths).toEqual({ authors: 120 });
  // The last column has no handle: the menu column cannot give up space.
  expect(host.querySelector('[aria-label="调整状态列宽度"]')).toBeNull();
  await act(async () =>
    host
      .querySelector('[aria-label="调整作者列宽度"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
  );
  expect(prefs().columnWidths).toEqual({ authors: 176, year: 48 });
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
  expect(host.querySelector('th[data-column="tags"] button')).toBeNull();
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
