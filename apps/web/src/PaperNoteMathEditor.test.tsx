// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PaperNoteRichEditor } from "./PaperNoteRichEditor";

let host: HTMLDivElement, root: Root;
const change = vi.fn();
function Note() {
  const [body, setBody] = useState("$x_1$");
  return (
    <PaperNoteRichEditor
      body={body}
      disabled={false}
      onChange={(value) => {
        change(value);
        setBody(value);
      }}
    />
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  change.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function open() {
  await act(async () => root.render(<Note />));
  await act(async () => {
    await vi.waitFor(() =>
      expect(
        host.querySelector(".ProseMirror [data-note-math]"),
      ).not.toBeNull(),
    );
  });
  await act(async () =>
    (
      host.querySelector(".ProseMirror [data-note-math]") as HTMLElement
    ).click(),
  );
  return document.querySelector<HTMLTextAreaElement>(
    '[aria-label="LaTeX 公式"]',
  )!;
}
function type(field: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
it("edits rendered formulas in place without remounting or losing the caret on self-echo", async () => {
  const field = await open();
  expect(field.value).toBe("x_1");
  expect(document.activeElement).toBe(field);
  await act(async () => type(field, "x_2"));
  await act(async () => type(field, "x_3"));
  expect(change.mock.calls.at(-1)?.[0]).toContain("$x_3$");
  expect(document.querySelector('[aria-label="LaTeX 公式"]')).toBe(field);
  expect(document.activeElement).toBe(field);
  expect(
    host.querySelector("[data-note-math]")?.getAttribute("data-value"),
  ).toBe("x_3");
  await act(async () =>
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  expect(document.querySelector('[aria-label="LaTeX 公式"]')).toBe(field);
  await act(async () =>
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        bubbles: true,
      }),
    ),
  );
  expect(document.querySelector('[aria-label="LaTeX 公式"]')).toBe(field);
  await act(async () =>
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(document.querySelector('[aria-label="LaTeX 公式"]')).toBeNull();
});
it("removes a cleared formula on finish and preserves valid empty Markdown", async () => {
  const field = await open();
  await act(async () => type(field, ""));
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>("[data-note-math-editor] button")!
      .click(),
  );
  expect(host.querySelector("[data-note-math]")).toBeNull();
  expect(change.mock.calls.at(-1)?.[0].trim()).toBe("");
  expect(host.querySelector(".ProseMirror")).not.toBeNull();
});
