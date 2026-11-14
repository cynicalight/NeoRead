// @vitest-environment jsdom
import { act } from "react";
import { reportDiagnostic } from "./diagnostics";
vi.mock("./diagnostics", () => ({ reportDiagnostic: vi.fn() }));
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Annotation, ReaderAnnotationTarget } from "@neoread/core";
import {
  AnnotationHoverCard,
  type AnnotationNoteEditor,
} from "./AnnotationHoverCard";
const target: ReaderAnnotationTarget = {
  ids: ["a", "b"],
  anchor: { x: 100, top: 80, bottom: 100 },
};
const annotations = [
  { id: "a", note: "具体批注内容" },
  { id: "b", note: "第二条批注" },
] as Annotation[];
const edit = vi.fn();
const remove = vi.fn();
let root: Root, host: HTMLDivElement;
const render = async (
  value: ReaderAnnotationTarget | null,
  notes = annotations,
  editor: AnnotationNoteEditor | null = null,
) => {
  await act(async () =>
    root.render(
      <AnnotationHoverCard
        target={value}
        annotations={notes}
        editor={editor}
        onEdit={edit}
        onDelete={remove}
      />,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60);
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(reportDiagnostic).mockClear();
  edit.mockClear();
  remove.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("shows all notes without stealing focus and edits the chosen note", async () => {
  const input = document.createElement("input");
  host.append(input);
  input.focus();
  await render(target);
  expect(document.body.textContent).toContain("具体批注内容");
  expect(document.body.textContent).toContain("第二条批注");
  expect(document.activeElement).not.toBe(
    document.querySelector('[aria-label="编辑批注"]'),
  );
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="编辑批注"]',
  );
  await act(async () => buttons[1].click());
  expect(edit).toHaveBeenCalledExactlyOnceWith(annotations[1], target.anchor);
});
it("allows crossing into the card and closes after leaving", async () => {
  await render(target);
  await render(null);
  const card = document.querySelector("[data-annotation-preview]")!;
  await act(async () =>
    card.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(document.body.textContent).toContain("具体批注内容");
  await act(async () =>
    card.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(document.querySelector("[data-annotation-preview]")).toBeNull();
});
it("does not show an empty note and removes deleted notes", async () => {
  await render(
    target,
    annotations.map((a) => ({ ...a, note: " " })),
  );
  expect(document.querySelector("[data-annotation-preview]")).toBeNull();
  await render(target);
  expect(document.body.textContent).toContain("具体批注内容");
  await render(target, []);
  expect(document.querySelector("[data-annotation-preview]")).toBeNull();
});

it("closes when reading scrolls so it cannot remain attached to an old position", async () => {
  await render(target);
  await act(async () => window.dispatchEvent(new Event("scroll")));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(document.querySelector("[data-annotation-preview]")).toBeNull();
});

it("deletes the chosen note from the card", async () => {
  await render(target);
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="删除批注"]',
  );
  expect(buttons).toHaveLength(2);
  await act(async () => buttons[0].click());
  expect(remove).toHaveBeenCalledExactlyOnceWith(annotations[0]);
});

const editor = (value: string, initial = ""): AnnotationNoteEditor => ({
  anchor: target.anchor,
  kind: "note",
  editing: !!initial,
  initial,
  value,
  saving: false,
  canAnswer: false,
  onChange: vi.fn(),
  onSave: vi.fn(),
  onSaveAndAnswer: vi.fn(),
  onClose: vi.fn(),
});

it("edits in the same card and keeps a typed draft on Escape only", async () => {
  const draft = editor("新批注");
  const onSave = vi.mocked(draft.onSave);
  const onClose = vi.mocked(draft.onClose);
  await render(null, annotations, draft);
  const input = document.querySelector<HTMLTextAreaElement>(
    "[data-annotation-preview] textarea",
  )!;
  expect(input.value).toBe("新批注");
  expect(document.activeElement).toBe(input);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="保存"]')!.click(),
  );
  expect(onSave).toHaveBeenCalledOnce();
  await act(async () =>
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    ),
  );
  expect(onClose).not.toHaveBeenCalled();
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it("cannot save an empty new note", async () => {
  await render(null, annotations, editor(" "));
  expect(
    document.querySelector<HTMLButtonElement>('[aria-label="保存"]')!.disabled,
  ).toBe(true);
});

it("stays open after being dragged away from the highlight", async () => {
  await render(target);
  const grip =
    document.querySelector<HTMLButtonElement>('[aria-label="拖动"]')!;
  grip.setPointerCapture = () => {};
  await act(async () =>
    grip.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      }),
    ),
  );
  await act(async () =>
    grip.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 50, clientY: 30 }),
    ),
  );
  await act(async () => grip.dispatchEvent(new MouseEvent("pointerup")));
  const card = document.querySelector<HTMLElement>(
    "[data-annotation-preview]",
  )!;
  expect(card.style.translate).toBe("40px 20px");
  await render(null);
  await act(async () =>
    card.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(document.body.textContent).toContain("具体批注内容");
});

it("renders saved Markdown in the hover preview", async () => {
  await render(target, [{ ...annotations[0], note: "# 要点\n\n**重点**" }]);
  expect(
    document.querySelector("[data-annotation-preview] h1")?.textContent,
  ).toBe("要点");
  expect(
    document.querySelector("[data-annotation-preview] strong")?.textContent,
  ).toBe("重点");
});

it("focuses the rich editor and saves Markdown with the keyboard shortcut", async () => {
  const draft = editor("# 标题\n\n**内容**", "# 标题\n\n**内容**");
  await render(null, annotations, draft);
  await act(async () => {
    await vi.waitFor(() =>
      expect(
        document.querySelector(".ProseMirror[aria-label='编辑批注']"),
      ).not.toBeNull(),
    );
  });
  const rich = document.querySelector<HTMLElement>(".ProseMirror")!;
  expect(document.activeElement).toBe(rich);
  expect(rich.querySelector("h1")?.textContent).toBe("标题");
  expect(draft.onChange).not.toHaveBeenCalled();
  await act(async () =>
    rich.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(draft.onSave).toHaveBeenCalledOnce();
  await act(async () =>
    rich.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  expect(draft.onSave).toHaveBeenCalledOnce();
});

it("preserves unsupported annotation content in editable source and reports its own fallback", async () => {
  const draft = editor("<section>保留原内容</section>");
  await render(null, annotations, draft);
  await act(async () => {
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("暂不支持的格式"),
    );
  });
  const source = document.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(reportDiagnostic).toHaveBeenCalledWith({
    level: "warn",
    event: "annotation_note.editor.initialize_fallback",
    detail: "unsupported_format",
  });
  expect(source.value).toBe(draft.value);
  expect(source.disabled).toBe(false);
  expect(draft.onChange).not.toHaveBeenCalled();
});

it("blocks further editing and shortcut submission while saving", async () => {
  const draft = { ...editor("**保存中**"), saving: true };
  await render(null, annotations, draft);
  const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(input.disabled).toBe(true);
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
      }),
    ),
  );
  expect(draft.onSave).not.toHaveBeenCalled();
});

it("keeps source-mode HTML visible as inert text in saved previews", async () => {
  const note = '<section>保留原内容</section>\n<script>alert("x")</script>';
  await render(target, [{ ...annotations[0], note }]);
  const preview = document.querySelector(
    "[data-annotation-preview] .message-markdown",
  )!;
  expect(preview.textContent).toContain(note);
  expect(preview.querySelector("section,script")).toBeNull();
});

it("renders editor-generated line breaks while retaining Markdown links and literal code", async () => {
  await render(target, [
    {
      ...annotations[0],
      note: "第一行<br />第二行\n\n`<section>` [链接](https://example.com)",
    },
  ]);
  const preview = document.querySelector(
    "[data-annotation-preview] .message-markdown",
  )!;
  expect(preview.querySelector("br")).not.toBeNull();
  expect(preview.querySelector("code")?.textContent).toBe("<section>");
  expect(preview.querySelector("a")?.getAttribute("href")).toBe(
    "https://example.com",
  );
});
