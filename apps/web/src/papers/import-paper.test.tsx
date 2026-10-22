// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import { toast } from "sonner";
import { ImportPaperDialog } from "./ImportPaperDialog";
import { looksLikeReference } from "./actions";
import { usePaperUI } from "./state";
import { useReaderStore } from "../store";
import { paper } from "./fixtures";
vi.mock("@reader/api", async (importOriginal) => ({
  RequestError: (await importOriginal<typeof import("@reader/api")>())
    .RequestError,
  api: { resolveDocument: vi.fn(), documents: vi.fn(async () => []) },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
let root: Root, host: HTMLDivElement;
const close = vi.fn(),
  choose = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  usePaperUI.setState({
    view: "starred",
    query: "x",
    tagFilter: { tags: ["missing"], match: "all" },
    selectedId: null,
  });
  useReaderStore.setState({ documents: [], libraryPreferences: {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ImportPaperDialog open onOpenChange={close} onChooseFiles={choose} />,
    ),
  );
});
it("uses the current paper category for file and reference imports", async () => {
  useReaderStore.setState({
    documents: [paper({ folders: ["Security/Web"] })],
    libraryPreferences: { papers: { categories: ["Security/Web"] } },
  });
  usePaperUI.getState().setView("folder:Security/Web");
  await act(async () =>
    root.render(
      <ImportPaperDialog
        open={false}
        onOpenChange={close}
        onChooseFiles={choose}
      />,
    ),
  );
  await act(async () =>
    root.render(
      <ImportPaperDialog open onOpenChange={close} onChooseFiles={choose} />,
    ),
  );
  const folder = document.querySelector<HTMLButtonElement>(
    '[aria-labelledby="import-paper-folder-label"]',
  );
  expect(folder?.textContent).toContain("Security / Web");
  const fileButton = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("选择 PDF 文件"),
  )!;
  await act(async () => fileButton.click());
  expect(choose).toHaveBeenCalledWith("folder:Security/Web");

  vi.mocked(api.resolveDocument).mockResolvedValue(
    paper({ id: "new", folders: ["Security/Web"] }),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="论文标识或链接"]',
  )!;
  await act(async () => type(input, "1706.03762"));
  await act(async () =>
    input.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.resolveDocument).toHaveBeenCalledWith("1706.03762", {
    library: "papers",
    allowLarge: false,
    folder: "Security/Web",
  });
  expect(usePaperUI.getState().view).toBe("folder:Security/Web");
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});
it("defaults to the current smart category and passes its ID to both import paths", async () => {
  await act(async () => {
    useReaderStore.setState({
      libraryPreferences: {
        papers: {
          smartCategories: [
            { id: "web", name: "Web Security", tags: ["Security", "Web"] },
          ],
        },
      },
    });
    usePaperUI.getState().setView("smart:web");
    root.render(
      <ImportPaperDialog
        open={false}
        onOpenChange={close}
        onChooseFiles={choose}
      />,
    );
  });
  await act(async () =>
    root.render(
      <ImportPaperDialog open onOpenChange={close} onChooseFiles={choose} />,
    ),
  );
  expect(
    document.querySelector('[aria-labelledby="import-paper-folder-label"]')
      ?.textContent,
  ).toContain("Web Security（智能标签）");
  const fileButton = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("选择 PDF 文件"),
  )!;
  await act(async () => fileButton.click());
  expect(choose).toHaveBeenCalledWith("smart:web");
  vi.mocked(api.resolveDocument).mockResolvedValue(
    paper({ tags: ["Security", "Web"] }),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="论文标识或链接"]',
  )!;
  await act(async () => type(input, "1706.03762"));
  await act(async () =>
    input.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.resolveDocument).toHaveBeenCalledWith("1706.03762", {
    library: "papers",
    allowLarge: false,
    smartCategory: "web",
  });
  expect(usePaperUI.getState().view).toBe("smart:web");
});
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
it("recognizes pasted identifiers but not arbitrary text", () => {
  for (const ref of [
    "2401.01234",
    "arXiv:2401.01234v2",
    "10.1145/3290605.3300857",
    "doi:10.1000/x",
    "https://openreview.net/forum?id=abc",
  ])
    expect(looksLikeReference(ref)).toBe(true);
  for (const text of ["hello world", "Attention is all you need", "2024"])
    expect(looksLikeReference(text)).toBe(false);
});
it("imports by reference and shows the new paper", async () => {
  vi.mocked(api.resolveDocument).mockResolvedValue(
    paper({ id: "new", title: "Attention" }),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="论文标识或链接"]',
  )!;
  await act(async () => type(input, " 1706.03762 "));
  await act(async () =>
    input.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.resolveDocument).toHaveBeenCalledExactlyOnceWith("1706.03762");
  expect(toast.success).toHaveBeenCalledWith("已导入《Attention》");
  expect(usePaperUI.getState()).toMatchObject({
    view: "all",
    query: "",
    selectedId: "new",
    tagFilter: { tags: [], match: "all" },
  });
  expect(close).toHaveBeenCalledWith(false);
});
it("keeps the dialog open and reports a failed lookup", async () => {
  vi.mocked(api.resolveDocument).mockRejectedValue(
    new Error("找到了《X》，但没有公开的 PDF"),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="论文标识或链接"]',
  )!;
  await act(async () => type(input, "10.1000/closed"));
  await act(async () =>
    input.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(toast.error).toHaveBeenCalledWith("找到了《X》，但没有公开的 PDF");
  expect(close).not.toHaveBeenCalled();
});

it.each(["papers", "books"] as const)(
  "asks before importing a large reference into %s",
  async (library) => {
    const { RequestError } = await import("@reader/api");
    const { LargePaperConfirmation } = await import("../LargePaperDialog");
    const { importReference } = await import("./actions");
    await act(async () => root.render(<LargePaperConfirmation />));
    vi.mocked(api.resolveDocument)
      .mockRejectedValueOnce(new RequestError("too large", "large-paper", 120))
      .mockResolvedValueOnce(paper({ library }));
    let result: ReturnType<typeof importReference>;
    await act(async () => {
      result = importReference("1706.03762", "smart:web");
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("检测到 PDF 过大");
    expect(api.resolveDocument).toHaveBeenCalledTimes(1);
    const label =
      library === "papers"
        ? "确认是论文，仍然导入论文库"
        : "不是论文，导入图书库";
    const choice = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === label,
    )!;
    await act(async () => {
      choice.click();
      await result;
    });
    expect(api.resolveDocument).toHaveBeenLastCalledWith("1706.03762", {
      library,
      allowLarge: true,
      ...(library === "papers" ? { smartCategory: "web" } : {}),
    });
  },
);
