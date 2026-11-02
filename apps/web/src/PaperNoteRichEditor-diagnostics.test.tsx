// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateDiagnosticEvent } from "../../../packages/neoread-core/src/diagnostics";
import { reportDiagnostic } from "./diagnostics";
import { PaperNoteRichEditor } from "./PaperNoteRichEditor";
const editor = vi.hoisted(() => ({
  create: vi.fn(),
  setMarkdown: vi.fn(),
  destroy: vi.fn(async () => {}),
}));
vi.mock("./diagnostics", () => ({ reportDiagnostic: vi.fn() }));
vi.mock("./paper-note-milkdown", () => ({
  createPaperNoteEditor: editor.create,
}));
let host: HTMLDivElement, root: Root;
const render = async (body = "private note text") =>
  act(async () => {
    root.render(
      <PaperNoteRichEditor
        body={body}
        disabled={false}
        onChange={() => {}}
        onBlur={() => {}}
      />,
    );
  });
const recovered = async () =>
  act(async () => {
    await vi.waitFor(() =>
      expect(
        host.querySelector('button[aria-pressed="true"]')?.textContent,
      ).toBe("源码"),
    );
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  editor.create.mockResolvedValue({
    setMarkdown: editor.setMarkdown,
    destroy: editor.destroy,
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
it("records initialization failure without copying exception text, stack or note content", async () => {
  const error = new TypeError("private note text\nat private note text");
  error.stack = "TypeError: private note text\n at private note text";
  editor.create.mockRejectedValueOnce(error);
  await render();
  await recovered();
  const event = vi.mocked(reportDiagnostic).mock.calls[0][0];
  expect(event).toEqual({
    level: "error",
    event: "paper_note.editor.initialize_fallback",
    detail: "TypeError",
  });
  expect(validateDiagnosticEvent(event)).toEqual(event);
  expect(JSON.stringify(event)).not.toContain("private note text");
  expect(host.querySelector("textarea")?.value).toBe("private note text");
  expect(reportDiagnostic).toHaveBeenCalledOnce();
});
it("distinguishes unsupported Markdown from editor initialization failures", async () => {
  editor.create.mockRejectedValueOnce(
    new Error("笔记包含暂不支持的格式，已保留在源码中编辑"),
  );
  await render();
  await recovered();
  expect(reportDiagnostic).toHaveBeenCalledExactlyOnceWith({
    level: "warn",
    event: "paper_note.editor.initialize_fallback",
    detail: "unsupported_format",
  });
});
it("records synchronization failure when an external draft cannot be parsed", async () => {
  await render();
  await act(async () => {
    await vi.waitFor(() => expect(editor.setMarkdown).toHaveBeenCalled());
  });
  editor.setMarkdown.mockImplementationOnce(() => {
    throw new RangeError("private updated draft");
  });
  await render("private updated draft");
  await recovered();
  expect(reportDiagnostic).toHaveBeenCalledExactlyOnceWith({
    level: "error",
    event: "paper_note.editor.synchronize_fallback",
    detail: "RangeError",
  });
  expect(host.querySelector("textarea")?.value).toBe("private updated draft");
});
it("still recovers the draft if diagnostic transport itself fails", async () => {
  editor.create.mockRejectedValueOnce(new Error("private note text"));
  vi.mocked(reportDiagnostic).mockImplementationOnce(() => {
    throw new Error("transport down");
  });
  await render();
  await recovered();
  expect(host.querySelector("textarea")?.value).toBe("private note text");
});
