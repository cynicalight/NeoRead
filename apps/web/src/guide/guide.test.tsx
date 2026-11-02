// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { toast } from "sonner";
import { cursorAt, script } from "./canvas";
import { scenes } from "./scenes";
import { guideTopics } from "./topics";
import { guideLaunch, releaseNotes } from "./releases";
import { GuideHost } from "./GuideHost";
import { GuidedTour } from "./tour/GuidedTour";
import { tourSteps } from "./tour/steps";

vi.mock("@neoread/api", () => ({
  api: { guidePreferences: vi.fn(), saveGuidePreferences: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.setConfig({ testTimeout: 20_000 });

/** A 2D context that accepts every call and measures 6px per character. */
function recordingContext() {
  const calls: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key === "measureText")
        return (text: string) => ({ width: text.length * 6 });
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        if (args.some((a) => typeof a === "number" && !Number.isFinite(a)))
          throw new Error(`${key} received a non-finite number`);
        calls.push(key);
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("guide launch", () => {
  const version = Object.keys(releaseNotes)[0];
  it("onboards a new library", () => {
    expect(guideLaunch({}, version, false)).toEqual({ kind: "onboarding" });
  });
  it("onboards a newly seeded library despite its example document", () => {
    const preferences = { exampleDocumentId: "example", onboarded: false };
    expect(guideLaunch(preferences, version, true)).toEqual({
      kind: "onboarding",
    });
    expect(
      guideLaunch(
        { ...preferences, onboarded: true, seenVersion: version },
        version,
        true,
      ),
    ).toEqual({ kind: "none" });
  });
  it("shows release notes instead to libraries from before the guide", () => {
    expect(guideLaunch({}, version, true)).toMatchObject({ kind: "release" });
  });
  it("shows release notes once per version", () => {
    const seen = { onboarded: true, seenVersion: version };
    expect(guideLaunch(seen, version, true)).toEqual({ kind: "none" });
    expect(
      guideLaunch({ onboarded: true, seenVersion: "0.0.1" }, version, true),
    ).toMatchObject({ kind: "release" });
  });
  it("shows update feedback even for versions without notes", () => {
    expect(
      guideLaunch({ onboarded: true, seenVersion: "0.0.1" }, "0.0.2", true),
    ).toEqual({
      kind: "release",
      items: [],
    });
  });
  it("does not repeat the onboarding after the library is emptied", () => {
    expect(
      guideLaunch({ onboarded: true, seenVersion: "0.0.2" }, "0.0.2", false),
    ).toEqual({ kind: "none" });
  });
});

describe("guide content", () => {
  it("uses unique ids and existing scenes", () => {
    const steps = guideTopics.flatMap((t) => t.steps);
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
    expect(new Set(guideTopics.map((t) => t.id)).size).toBe(guideTopics.length);
    for (const step of steps) expect(scenes[step.scene]).toBeDefined();
    for (const items of Object.values(releaseNotes))
      for (const item of items)
        if (item.topic)
          expect(guideTopics.some((t) => t.id === item.topic)).toBe(true);
  });
});

describe("guide canvas", () => {
  it("eases the pointer between scripted positions", () => {
    const s = script({ x: 0, y: 0 })
      .wait(100)
      .move({ x: 100, y: 50 }, 200)
      .build(500);
    expect(cursorAt(s, 50)).toEqual({ x: 0, y: 0 });
    expect(cursorAt(s, 200)).toEqual({ x: 50, y: 25 });
    expect(cursorAt(s, 300)).toEqual({ x: 100, y: 50 });
    expect(cursorAt(s, 799)).toEqual({ x: 100, y: 50 });
    expect(s.duration).toBe(800);
  });
});

describe("guide host", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => recordingContext().ctx as never,
    );
    vi.mocked(api.saveGuidePreferences).mockImplementation(async (v) => v);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const render = async (hasDocuments: boolean, version = "9.9.9") => {
    await act(async () =>
      root.render(
        <GuideHost
          ready
          version={version}
          hasDocuments={hasDocuments}
          open={false}
          onOpenChange={() => {}}
          onAction={() => {}}
        />,
      ),
    );
  };
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    )!;

  it("advances on target clicks and observes the focus result before continuing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const frames: FrameRequestCallback[] = [];
      vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      const flush = () =>
        act(async () => {
          for (const callback of frames.splice(0)) callback(0);
        });
      const finish = vi.fn();
      await act(async () =>
        root.render(
          <GuidedTour
            open
            onFinish={finish}
            steps={[
              {
                id: "click",
                view: () => ({
                  title: "点击目标",
                  body: "",
                  advanceOn: "#tour-test-target",
                }),
              },
              {
                id: "observe",
                view: () => ({
                  title: "查看聚焦",
                  body: "",
                  advanceAfter: 3000,
                }),
              },
            ]}
          />,
        ),
      );
      await flush();
      expect(document.querySelector(".tour-card")?.textContent).not.toContain(
        "下一步",
      );
      const target = document.createElement("button");
      target.id = "tour-test-target";
      host.append(target);
      // UI components may stop bubbling; the tour must still see the click.
      target.onclick = (event) => event.stopPropagation();
      await act(async () => target.click());
      await flush();
      expect(document.querySelector(".tour-card")?.textContent).toContain(
        "查看聚焦",
      );
      await act(async () => vi.advanceTimersByTime(2999));
      await flush();
      expect(finish).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(1));
      await flush();
      expect(finish).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes settings through its existing control and waits for closure before advancing", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const flush = () =>
      act(async () => {
        for (const callback of frames.splice(0)) callback(0);
      });
    const settings = document.createElement("div");
    settings.dataset.tour = "settings";
    const close = document.createElement("button");
    close.dataset.slot = "dialog-close";
    vi.stubGlobal("innerWidth", 340);
    vi.stubGlobal("innerHeight", 300);
    const closeRect = new DOMRect(280, 60, 40, 40);
    close.getBoundingClientRect = () => closeRect;
    close.getClientRects = () => [closeRect] as unknown as DOMRectList;
    close.scrollIntoView = vi.fn();
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
      function (this: Element) {
        return this.classList.contains("tour-card") ? 260 : 0;
      },
    );
    const onClose = vi.fn();
    close.onclick = onClose;
    settings.append(close);
    document.body.append(settings);
    try {
      const finish = vi.fn();
      await act(async () =>
        root.render(
          <GuidedTour
            open
            onFinish={finish}
            steps={[tourSteps.find((step) => step.id === "close-settings")!]}
          />,
        ),
      );
      await flush();
      await flush();
      const card = document.querySelector<HTMLElement>(".tour-card")!;
      expect(card.style.visibility).not.toBe("hidden");
      expect(Number.parseFloat(card.style.maxHeight)).toBeGreaterThanOrEqual(
        48,
      );
      expect(Number.parseFloat(card.style.maxHeight)).toBeLessThan(260);
      await act(async () => button("关闭设置并继续").click());
      expect(onClose).toHaveBeenCalledOnce();
      await flush();
      expect(finish).not.toHaveBeenCalled();
      settings.dataset.closed = "";
      await flush();
      expect(finish).toHaveBeenCalledOnce();
    } finally {
      settings.remove();
    }
  });

  it("frames only the requested card while keeping the expanded deck interactive", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const fixture = document.createElement("div");
    vi.stubGlobal("innerWidth", 1200);
    vi.stubGlobal("innerHeight", 800);
    fixture.innerHTML =
      '<section data-tour="agent-section" data-deck-open="true"></section><div class="agent-stack-card" inert data-tour="agent-card" data-agent="api"></div><div data-tour="agent-deck" data-spread><div data-tour="agent-card" data-agent="api"><button data-slot="agent-select">API</button></div></div>';
    document.body.append(fixture);
    const deck = fixture.querySelector<HTMLElement>(
      '[data-tour="agent-deck"]',
    )!;
    const card = deck.querySelector<HTMLElement>('[data-agent="api"]')!;
    for (const [el, rect] of [
      [deck, new DOMRect(100, 50, 500, 600)],
      [card, new DOMRect(100, 250, 500, 112)],
    ] as const) {
      el.getBoundingClientRect = () => rect;
      el.getClientRects = () => [rect] as unknown as DOMRectList;
      el.scrollIntoView = vi.fn();
    }
    const target = '[data-tour="agent-deck"][data-spread] [data-agent="api"]';
    try {
      await act(async () =>
        root.render(
          <GuidedTour
            open
            onFinish={() => {}}
            steps={[
              {
                id: "api",
                view: () => ({
                  title: "配置 API",
                  body: "",
                  focus: [target],
                  click: ['[data-tour="agent-deck"][data-spread]'],
                  pointer: { gesture: "click", target },
                  revealAgent: "api",
                }),
              },
            ]}
          />,
        ),
      );
      await act(async () => {
        for (const callback of frames.splice(0)) callback(0);
      });
      const outlines = document.querySelectorAll<HTMLElement>(".tour-frame");
      expect(outlines).toHaveLength(1);
      expect(
        document.querySelector<HTMLElement>(".tour-skip")?.style.transform,
      ).toBe("translate(16px, 752px)");
      expect(outlines[0].style.transform).toBe("translate(95px, 245px)");
      expect(document.activeElement).toBe(card.querySelector("button"));
    } finally {
      fixture.remove();
    }
  });

  it("starts the guided tour for a new user and remembers a skip", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const flush = () =>
      act(async () => {
        for (const callback of frames.splice(0)) callback(0);
      });
    vi.mocked(api.guidePreferences).mockResolvedValue({});
    await render(false);
    await flush();
    expect(document.querySelector(".tour-card")?.textContent).toContain(
      "欢迎使用 NeoRead",
    );
    await act(async () => button("开始").click());
    await flush();
    expect(document.querySelector(".tour-card")?.textContent).not.toContain(
      "欢迎使用 NeoRead",
    );
    expect(api.saveGuidePreferences).not.toHaveBeenCalled();
    await act(async () => button("跳过引导").click());
    expect(document.body.textContent).toContain("不建议跳过新手引导哦！");
    await act(async () => button("好的，认真学习！").click());
    expect(document.querySelector(".tour")).not.toBeNull();
    expect(api.saveGuidePreferences).not.toHaveBeenCalled();
    await act(async () => button("跳过引导").click());
    await act(async () => button("我是老用户～").click());
    expect(document.querySelector(".tour")).toBeNull();
    expect(api.saveGuidePreferences).toHaveBeenCalledWith({
      onboarded: true,
      seenVersion: "9.9.9",
    });
  });

  it("shows release notes to an existing library and records the version", async () => {
    const [version, items] = Object.entries(releaseNotes)[0];
    vi.mocked(api.guidePreferences).mockResolvedValue({});
    await render(true, version);
    expect(document.body.textContent).toContain(`NeoRead ${version} 更新内容`);
    expect(document.body.textContent).toContain(items[0].title);
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue({ opener: null } as Window);
    await act(async () => button("去 GitHub 点 Star").click());
    expect(open).toHaveBeenCalledWith(
      "https://github.com/cynicalight/NeoRead",
      "_blank",
    );
    expect(api.saveGuidePreferences).toHaveBeenCalledWith({
      onboarded: true,
      seenVersion: version,
    });
  });

  it("opens issues from an update without notes and remembers the version", async () => {
    vi.mocked(api.guidePreferences).mockResolvedValue({
      onboarded: true,
      seenVersion: "0.0.1",
    });
    const openExternal = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "neoreadDesktop", {
      configurable: true,
      value: { openExternal },
    });
    try {
      await render(true);
      expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
      await act(async () => button("已点 Star，去提 Issue").click());
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/cynicalight/NeoRead/issues/new/choose",
      );
      expect(api.saveGuidePreferences).toHaveBeenCalledWith({
        onboarded: true,
        seenVersion: "9.9.9",
      });
    } finally {
      Object.defineProperty(window, "neoreadDesktop", {
        configurable: true,
        value: undefined,
      });
    }
  });

  it("keeps the update available when opening the browser fails", async () => {
    vi.mocked(api.guidePreferences).mockResolvedValue({
      onboarded: true,
      seenVersion: "0.0.1",
    });
    vi.spyOn(window, "open").mockReturnValue(null);
    await render(true);
    await act(async () => button("去 GitHub 点 Star").click());
    expect(toast.error).toHaveBeenCalled();
    expect(api.saveGuidePreferences).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button("去 GitHub 点 Star").disabled).toBe(false);
  });

  it("remembers an update dismissed with Escape", async () => {
    vi.mocked(api.guidePreferences).mockResolvedValue({
      onboarded: true,
      seenVersion: "0.0.1",
    });
    await render(true);
    await act(async () =>
      button("去 GitHub 点 Star").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(api.saveGuidePreferences).toHaveBeenCalledWith({
      onboarded: true,
      seenVersion: "9.9.9",
    });
  });

  it("shows nothing when the version was already seen", async () => {
    vi.mocked(api.guidePreferences).mockResolvedValue({
      onboarded: true,
      seenVersion: "9.9.9",
    });
    await render(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.saveGuidePreferences).not.toHaveBeenCalled();
  });
});
