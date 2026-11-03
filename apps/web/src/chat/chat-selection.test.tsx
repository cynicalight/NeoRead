// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatSelectionToolbar } from "./ChatSelectionToolbar";
let host: HTMLDivElement, root: Root;
let pane: { current: HTMLDivElement }, content: { current: HTMLDivElement };
let identity: object;
const quote = vi.fn();
const frames = new Map<number, FrameRequestCallback>();
let sequence = 0;
const flush = () => {
  const calls = [...frames.values()];
  frames.clear();
  calls.forEach((callback) => callback(0));
};
beforeEach(async () => {
  quote.mockClear();
  frames.clear();
  identity = {};
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  host.innerHTML =
    '<div class="messages"><div data-chat-text>First answer. Second sentence.</div><button>复制回答</button></div><div class="outside">Other text</div><div class="toolbar"></div>';
  document.body.append(host);
  pane = { current: host };
  content = { current: host.querySelector(".messages")! };
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 800),
  );
  root = createRoot(host.querySelector(".toolbar")!);
  await act(async () =>
    root.render(
      <ChatSelectionToolbar
        pane={pane}
        content={content}
        identity={identity}
        onQuote={quote}
      />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  window.getSelection()?.removeAllRanges();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const choose = (node: Node, start: number, end: number) => {
  const range = document.createRange();
  range.getClientRects = () =>
    [new DOMRect(20, 30, 200, 24)] as unknown as DOMRectList;
  range.setStart(node, start);
  range.setEnd(node, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
};
it("quotes exactly the selected message text through the existing floating toolbar", async () => {
  await act(async () => {
    choose(host.querySelector("[data-chat-text]")!.firstChild!, 0, 13);
    flush();
  });
  const button = host.querySelector<HTMLButtonElement>(
    '[aria-label="引用到对话"]',
  )!;
  expect(button).not.toBeNull();
  expect(
    host.querySelector('[role="toolbar"]')?.getAttribute("aria-label"),
  ).toBe("聊天选中文字操作");
  await act(async () => button.click());
  expect(quote).toHaveBeenCalledExactlyOnceWith("First answer.");
  expect(window.getSelection()!.isCollapsed).toBe(true);
  expect(host.querySelector('[role="toolbar"]')).toBeNull();
});
it("defers selection work while dragging and captures the final keyboard or pointer selection", async () => {
  const text = host.querySelector("[data-chat-text]")!.firstChild!;
  const serialize = vi.spyOn(window.getSelection()!, "toString");
  await act(async () => {
    text.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    for (let i = 1; i <= 10; i++) choose(text, 0, i);
    expect(frames.size).toBe(1);
    flush();
  });
  expect(serialize).not.toHaveBeenCalled();
  expect(host.querySelector('[role="toolbar"]')).toBeNull();
  await act(async () => {
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    flush();
  });
  expect(host.querySelector('[role="toolbar"]')).not.toBeNull();
  await act(async () => {
    window.getSelection()!.extend(text, 13);
    window.getSelection()!.getRangeAt(0).getClientRects = () =>
      [new DOMRect(20, 30, 200, 24)] as unknown as DOMRectList;
    document.dispatchEvent(new Event("selectionchange"));
    flush();
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="引用到对话"]')!.click(),
  );
  expect(quote).toHaveBeenCalledWith("First answer.");
});
it("ignores controls and text outside message bodies and clears a toolbar on session change", async () => {
  await act(async () => {
    choose(host.querySelector(".outside")!.firstChild!, 0, 5);
    flush();
  });
  expect(host.querySelector('[role="toolbar"]')).toBeNull();
  await act(async () => {
    choose(host.querySelector("button")!.firstChild!, 0, 2);
    flush();
  });
  expect(host.querySelector('[role="toolbar"]')).toBeNull();
  await act(async () => {
    choose(host.querySelector("[data-chat-text]")!.firstChild!, 0, 5);
    flush();
  });
  expect(host.querySelector('[role="toolbar"]')).not.toBeNull();
  await act(async () =>
    root.render(
      <ChatSelectionToolbar
        pane={pane}
        content={content}
        identity={{}}
        onQuote={quote}
      />,
    ),
  );
  expect(host.querySelector('[role="toolbar"]')).toBeNull();
  expect(quote).not.toHaveBeenCalled();
});
