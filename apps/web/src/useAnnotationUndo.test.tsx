// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { useAnnotationUndo } from "./useAnnotationUndo";
vi.mock("@neoread/api", () => ({ api: { undoAnnotation: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
let root: Root, host: HTMLDivElement;
const changed = vi.fn();
function NeoRead({
  id = "one",
  blocked = false,
}: {
  id?: string;
  blocked?: boolean;
}) {
  useAnnotationUndo(id, changed, () => blocked);
  return (
    <>
      <div tabIndex={0} data-reader="" />
      <textarea />
      <div contentEditable suppressContentEditableWarning>
        <span>text</span>
      </div>
    </>
  );
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(api.undoAnnotation).mockResolvedValue({
    undone: true,
    annotations: [],
  });
  await act(async () => root.render(<NeoRead />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
async function key(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}
it("supports Cmd+Z and Ctrl+Z for the current document", async () => {
  expect(
    (await key(host.querySelector("[data-reader]")!)).defaultPrevented,
  ).toBe(true);
  await key(window, { metaKey: false, ctrlKey: true });
  expect(api.undoAnnotation).toHaveBeenCalledTimes(2);
  expect(api.undoAnnotation).toHaveBeenLastCalledWith("one");
  expect(changed).toHaveBeenCalledTimes(2);
});
it("leaves text, redo and IME undo to their native owners", async () => {
  for (const node of [
    host.querySelector("textarea")!,
    host.querySelector("[contenteditable] span")!,
  ])
    expect((await key(node)).defaultPrevented).toBe(false);
  for (const init of [
    { shiftKey: true },
    { altKey: true },
    { isComposing: true },
    { metaKey: false },
  ])
    expect((await key(window, init)).defaultPrevented).toBe(false);
  expect(api.undoAnnotation).not.toHaveBeenCalled();
});
it("does not overwrite a new document with a late undo response", async () => {
  let finish!: (value: { undone: boolean; annotations: [] }) => void;
  vi.mocked(api.undoAnnotation).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await key(window);
  await act(async () => root.render(<NeoRead id="two" />));
  await act(async () => finish({ undone: true, annotations: [] }));
  expect(changed).not.toHaveBeenCalled();
});
it("does not undo while preparing an annotation", async () => {
  await act(async () => root.render(<NeoRead blocked />));
  await key(window);
  expect(api.undoAnnotation).not.toHaveBeenCalled();
});

it("routes undo only to the active reader when other document tabs remain mounted", async () => {
  await act(async () =>
    root.render(
      <>
        <NeoRead id="a" blocked />
        <NeoRead id="b" />
      </>,
    ),
  );
  await key(window);
  expect(api.undoAnnotation).toHaveBeenCalledExactlyOnceWith("b");
  vi.mocked(api.undoAnnotation).mockClear();
  await act(async () =>
    root.render(
      <>
        <NeoRead id="a" />
        <NeoRead id="b" blocked />
      </>,
    ),
  );
  await key(window);
  expect(api.undoAnnotation).toHaveBeenCalledExactlyOnceWith("a");
});
