// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  api,
  RequestError,
  type ZoteroScan,
  type ZoteroImportResult,
} from "@neoread/api";
import { refreshLibrary } from "../store";
import { downloadText } from "../download";
import { confirmLargePaper } from "../LargePaperDialog";
import { ZoteroImportDialog } from "./ZoteroImportDialog";
vi.mock("@neoread/api", async (importOriginal) => ({
  RequestError: (await importOriginal<typeof import("@neoread/api")>())
    .RequestError,
  api: {
    zoteroDefaults: vi.fn(),
    scanZotero: vi.fn(),
    importZotero: vi.fn(),
    scanEndNote: vi.fn(),
    importEndNote: vi.fn(),
  },
}));
vi.mock("../LargePaperDialog", () => ({ confirmLargePaper: vi.fn() }));
vi.mock("./EndNoteSourcePicker", () => ({
  EndNoteSourcePicker: ({
    onConfirm,
  }: {
    onConfirm: (path: string) => void;
  }) => <button onClick={() => onConfirm("/tmp/EndNote")}>扫描 EndNote</button>,
}));
vi.mock("../store", () => ({ refreshLibrary: vi.fn(async () => {}) }));
vi.mock("../download", () => ({ downloadText: vi.fn() }));
const scan: ZoteroScan = {
  id: "preview-1",
  directory: "/tmp/Zotero",
  warnings: [],
  entries: [
    {
      id: "1/A",
      title: "Paper A",
      filename: "a.pdf",
      collections: ["AI"],
      tags: [],
      notes: 1,
      annotations: 2,
      size: 100,
      warnings: [],
    },
    {
      id: "1/B",
      title: "Paper B",
      filename: "b.pdf",
      collections: [],
      tags: [],
      notes: 0,
      annotations: 0,
      size: 100,
      warnings: [],
    },
    {
      id: "1/C",
      title: "Paper C",
      filename: "missing.pdf",
      collections: [],
      tags: [],
      notes: 0,
      annotations: 0,
      size: 0,
      issue: "PDF 不在本机",
      warnings: [],
    },
  ],
};
let root: Root, host: HTMLDivElement;
const close = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.clearAllMocks();
  vi.mocked(api.zoteroDefaults).mockResolvedValue({ directory: "/tmp/Zotero" });
  vi.mocked(api.scanZotero).mockResolvedValue(scan);
  vi.mocked(api.importZotero).mockResolvedValue({
    documentId: "doc",
    status: "imported",
    notes: 1,
    annotations: 2,
    warnings: [],
  });
  vi.mocked(api.scanEndNote).mockResolvedValue(scan);
  vi.mocked(api.importEndNote).mockResolvedValue({
    documentId: "doc",
    status: "imported",
    notes: 0,
    annotations: 0,
    warnings: [],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<ZoteroImportDialog open onOpenChange={close} />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === text,
  )!;
const scanLibrary = () =>
  act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
  });
it("previews without importing and excludes unavailable attachments", async () => {
  await scanLibrary();
  expect(api.scanZotero).toHaveBeenCalledWith("/tmp/Zotero", "");
  expect(api.importZotero).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("可导入 2 条，需处理 1 条");
  expect(
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="导入 Paper C（missing.pdf）"]',
      )!
      .getAttribute("aria-disabled"),
  ).toBe("true");
  await act(async () => button("导入选中 2 条").click());
  expect(api.importZotero).toHaveBeenNthCalledWith(1, "preview-1", "1/A", {
    autoTranslate: false,
  });
  expect(api.importZotero).toHaveBeenNthCalledWith(2, "preview-1", "1/B", {
    autoTranslate: false,
  });
  expect(api.importZotero).toHaveBeenCalledTimes(2);
  expect(refreshLibrary).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain(
    "新增 2，合并 0，已迁移 0，失败 0",
  );
});
it("continues after per-item failures and exports an accurate report", async () => {
  vi.mocked(api.importZotero)
    .mockRejectedValueOnce(new Error("无法复制附件"))
    .mockResolvedValueOnce({
      documentId: "b",
      status: "exists",
      notes: 0,
      annotations: 0,
      warnings: [],
    });
  await scanLibrary();
  await act(async () => button("导入选中 2 条").click());
  expect(document.body.textContent).toContain("无法复制附件");
  expect(document.body.textContent).toContain(
    "新增 0，合并 0，已迁移 1，失败 1",
  );
  await act(async () => button("导出报告").click());
  const report = JSON.parse(vi.mocked(downloadText).mock.calls[0][0]);
  expect(
    report.entries.map(
      (entry: { outcome: { status: string } }) => entry.outcome.status,
    ),
  ).toEqual(["failed", "exists", "unavailable"]);
});
it("stops after the current transaction and prevents closing during import", async () => {
  let finish!: (value: ZoteroImportResult) => void;
  vi.mocked(api.importZotero).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await scanLibrary();
  await act(async () => button("导入选中 2 条").click());
  expect(document.body.textContent).toContain("停止后续导入");
  expect(
    document
      .querySelector('[aria-describedby="batch-import-translation-help"]')!
      .getAttribute("aria-disabled"),
  ).toBe("true");
  await act(async () => {
    button("停止后续导入").click();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(close).not.toHaveBeenCalled();
  await act(async () =>
    finish({
      documentId: "a",
      status: "imported",
      notes: 0,
      annotations: 0,
      warnings: [],
    }),
  );
  expect(api.importZotero).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("已停止后续导入");
  await act(async () => button("导出报告").click());
  expect(
    JSON.parse(vi.mocked(downloadText).mock.calls[0][0]).entries[1].outcome
      .status,
  ).toBe("notImported");
});
it("retains the source form when scanning fails", async () => {
  vi.mocked(api.scanZotero).mockRejectedValueOnce(
    new Error("目录中没有 zotero.sqlite"),
  );
  await scanLibrary();
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    "目录中没有 zotero.sqlite",
  );
  expect(
    document.querySelector<HTMLInputElement>("#zotero-directory")!.value,
  ).toBe("/tmp/Zotero");
  expect(api.importZotero).not.toHaveBeenCalled();
});

it.each(["zotero", "endnote"] as const)(
  "%s applies one explicit translation choice to the whole batch and large-paper retries",
  async (source) => {
    await act(async () =>
      root.render(
        <ZoteroImportDialog
          key={source}
          source={source}
          open
          onOpenChange={close}
        />,
      ),
    );
    const importEntry =
      source === "endnote" ? api.importEndNote : api.importZotero;
    if (source === "endnote")
      await act(async () => button("扫描 EndNote").click());
    else await scanLibrary();
    const checkbox = document.querySelector<HTMLElement>(
      '[aria-describedby="batch-import-translation-help"]',
    )!;
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await act(async () => checkbox.click());
    expect(document.body.textContent).toContain("不受全局页数上限限制");
    vi.mocked(importEntry).mockRejectedValueOnce(
      new RequestError("过大", "large-paper", 160),
    );
    vi.mocked(confirmLargePaper).mockResolvedValueOnce("papers");
    await act(async () => button("导入选中 2 条").click());
    expect(importEntry).toHaveBeenNthCalledWith(1, "preview-1", "1/A", {
      autoTranslate: true,
    });
    expect(importEntry).toHaveBeenNthCalledWith(2, "preview-1", "1/A", {
      library: "papers",
      allowLarge: true,
      autoTranslate: true,
    });
    expect(importEntry).toHaveBeenNthCalledWith(3, "preview-1", "1/B", {
      autoTranslate: true,
    });
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
  },
);
it("EndNote also explicitly disables translation by default", async () => {
  await act(async () =>
    root.render(
      <ZoteroImportDialog
        key="endnote"
        source="endnote"
        open
        onOpenChange={close}
      />,
    ),
  );
  await act(async () => button("扫描 EndNote").click());
  await act(async () => button("导入选中 2 条").click());
  expect(api.importEndNote).toHaveBeenNthCalledWith(1, "preview-1", "1/A", {
    autoTranslate: false,
  });
  expect(api.importEndNote).toHaveBeenNthCalledWith(2, "preview-1", "1/B", {
    autoTranslate: false,
  });
});

it("requires a fresh translation choice when scanning another batch", async () => {
  await scanLibrary();
  await act(async () =>
    document
      .querySelector<HTMLElement>(
        '[aria-describedby="batch-import-translation-help"]',
      )!
      .click(),
  );
  await act(async () => button("重新扫描").click());
  await scanLibrary();
  expect(
    document
      .querySelector('[aria-describedby="batch-import-translation-help"]')!
      .getAttribute("aria-checked"),
  ).toBe("false");
});
