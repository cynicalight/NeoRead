// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReaderStore } from "../store";
import { MessageMarkdown } from "./MessageMarkdown";
import { markdownFixture, sizedFixture, splitFixture } from "./fixtures";
import { useChatScroll } from "./useChatScroll";
let root: Root, host: HTMLDivElement;
let hidden = false;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useReaderStore.getState().setTheme({ reducedMotion: false });
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useReaderStore.getState().setTheme({ reducedMotion: false });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Markdown display lifecycle", () => {
  it("terminal flush preserves all received text and disables scheduling", async () => {
    let received = "";
    const source = "# 标题\n\n中文 **加粗** 👩🏽‍💻 é\n\n- 列表\n- 尾字";
    for (const chunk of splitFixture(source, "random")) {
      received += chunk;
      await act(async () =>
        root.render(<MessageMarkdown content={received} generating />),
      );
    }
    await act(async () => root.render(<MessageMarkdown content={received} />));
    expect(host.textContent).toContain("中文 加粗 👩🏽‍💻 é");
    expect(host.textContent).toContain("尾字");
    expect(host.querySelector('[data-animated="false"]')).not.toBeNull();
    expect(host.querySelector(".stream-char")).toBeNull();
  });
  it("reduced motion and background recovery stay immediate without replay", async () => {
    await act(async () =>
      root.render(<MessageMarkdown content="开头" generating />),
    );
    act(() => {
      useReaderStore.getState().setTheme({ reducedMotion: true });
    });
    expect(host.textContent).toBe("开头");
    expect(host.querySelector('[data-animated="false"]')).not.toBeNull();
    act(() => {
      useReaderStore.getState().setTheme({ reducedMotion: false });
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () =>
      root.render(<MessageMarkdown content="开头后台尾字" generating />),
    );
    expect(host.textContent).toBe("开头后台尾字");
    expect(host.querySelector('[data-animated="false"]')).not.toBeNull();
  });
  it("renders streamed global definitions and long grouped blocks like history", async () => {
    // Load code/math modules before teardown: source assertions do not depend on Suspense timing.
    await Promise.all([import("./CodeBlock"), import("./MathFormula")]);
    const source = sizedFixture(102400) + markdownFixture;
    await act(async () =>
      root.render(
        <MessageMarkdown
          content={source.slice(0, -100)}
          generating
          animated={false}
        />,
      ),
    );
    await act(async () =>
      root.render(<MessageMarkdown content={source} animated={false} />),
    );
    const text = host.textContent;
    await act(async () =>
      root.render(<MessageMarkdown key="history" content={source} />),
    );
    expect(host.textContent).toBe(text);
    expect(host.querySelector("[data-footnotes]")).not.toBeNull();
  });
});
it("scroll pauses on upward intent, ignores resizes until resumed and cleans observers", () => {
  let resize!: () => void;
  let disconnected = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {
        disconnected++;
      }
    },
  );
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++id, fn);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  function Probe() {
    const scroll = useChatScroll("request");
    return (
      <>
        <div ref={scroll.viewportRef}>
          <div ref={scroll.contentRef}>text</div>
        </div>
        <button onClick={scroll.bottom}>
          {scroll.following ? "follow" : "paused"}
        </button>
      </>
    );
  }
  act(() => root.render(<Probe />));
  const viewport = host.firstElementChild as HTMLDivElement;
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 100, configurable: true },
  });
  const flush = () =>
    act(() => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((fn) => fn(0));
    });
  flush();
  expect(viewport.scrollTop).toBe(900);
  act(() => viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })));
  viewport.scrollTop = 500;
  act(() => resize());
  flush();
  expect(viewport.scrollTop).toBe(500);
  expect(host.textContent).toContain("paused");
  act(() => (host.querySelector("button") as HTMLButtonElement).click());
  expect(viewport.scrollTop).toBe(900);
  act(() => root.unmount());
  root = createRoot(host);
  expect(disconnected).toBe(1);
  expect(frames.size).toBe(0);
});
