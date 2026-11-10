// @vitest-environment jsdom
import { act } from "react";
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

const editor = (
  value: string,
  initial = "",
): AnnotationNoteEditor => ({
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
  const grip = document.querySelector<HTMLButtonElement>('[aria-label="拖动"]')!;
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
