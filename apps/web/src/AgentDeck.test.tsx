// @vitest-environment jsdom
import { useReaderStore } from "./store";
import { act, type ReactNode, type WheelEventHandler } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDeck, type DeckItem } from "./AgentDeck";
import { toast } from "sonner";

vi.mock("@neoread/ui/components/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? children : null,
  DialogContent: ({
    children,
    onWheel,
  }: {
    children: ReactNode;
    onWheel?: WheelEventHandler<HTMLDivElement>;
  }) => (
    <div data-testid="deck-dialog" onWheel={onWheel}>
      {children}
    </div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

it("centres a focused guide target without selecting the provider", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useReaderStore.getState().setTheme({ reducedMotion: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const pick = vi.fn(() => true);
  const openChange = vi.fn();
  const items: DeckItem[] = ["codex", "claude", "kimi", "api"].map((id) => ({
    id,
    title: id,
    icon: null,
    status: "ready",
    tour: "agent-card",
  }));
  try {
    await act(async () =>
      root.render(
        <AgentDeck
          items={items}
          front="codex"
          open
          onOpenChange={openChange}
          onPick={pick}
          onDetail={() => true}
          onRefresh={() => {}}
          refreshing={false}
          loadCalls={async () => []}
          onPanelClose={() => {}}
          onFallback={() => {}}
          usable={() => true}
        />,
      ),
    );
    const target = host.querySelector<HTMLElement>(
      '[data-tour="agent-deck"] [data-agent="api"] [data-slot="agent-select"]',
    )!;
    await act(async () => target.focus());
    expect(
      host
        .querySelector('[data-tour="agent-deck"] [data-center="true"]')
        ?.getAttribute("data-agent"),
    ).toBe("api");
    expect(pick).not.toHaveBeenCalled();
    await act(async () => target.click());
    expect(pick).toHaveBeenCalledWith("api");
    expect(openChange).toHaveBeenCalledWith(false);
    const dismiss = host.querySelector<HTMLElement>(
      '[data-tour="agent-deck-dismiss"]',
    )!;
    await act(async () => dismiss.click());
    expect(openChange).toHaveBeenCalledWith(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it.each([true, false])(
  "checks the centered card on close (usable: %s)",
  async (ready) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useReaderStore.getState().setTheme({ reducedMotion: true });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const pick = vi.fn(() => true);
    const fallback = vi.fn();
    const warning = vi
      .spyOn(toast, "warning")
      .mockImplementation(() => "toast");
    const close = vi.fn();
    const items: DeckItem[] = ["codex", "api"].map((id) => ({
      id,
      title: id,
      icon: null,
      status: id === "api" && !ready ? "missing" : "ready",
      selected: id === "codex",
      tour: "agent-card",
    }));
    try {
      await act(async () =>
        root.render(
          <AgentDeck
            items={items}
            front="codex"
            open
            onOpenChange={close}
            onPick={pick}
            onFallback={fallback}
            onDetail={() => true}
            onRefresh={() => {}}
            refreshing={false}
            loadCalls={async () => []}
            onPanelClose={() => {}}
            usable={(id) => id !== "api" || ready}
          />,
        ),
      );
      await act(async () =>
        host
          .querySelector<HTMLElement>(
            '[data-agent="api"] [data-slot="agent-select"]',
          )!
          .focus(),
      );
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="收起"]')!.click(),
      );
      expect(close).toHaveBeenCalledWith(false);
      if (ready) {
        expect(pick).toHaveBeenCalledWith("api");
        expect(fallback).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();
      } else {
        expect(pick).not.toHaveBeenCalled();
        expect(fallback).toHaveBeenCalledWith("codex");
        expect(warning).toHaveBeenCalledOnce();
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  },
);

it("keeps the selected agent when the saved front card is stale", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useReaderStore.getState().setTheme({ reducedMotion: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const pick = vi.fn(() => true);
  const items: DeckItem[] = ["codex", "api"].map((id) => ({
    id,
    title: id,
    icon: null,
    status: "ready",
    selected: id === "codex",
    tour: "agent-card",
  }));
  try {
    await act(async () =>
      root.render(
        <AgentDeck
          items={items}
          front="api"
          open
          onOpenChange={() => {}}
          onPick={pick}
          onFallback={() => {}}
          onDetail={() => true}
          onRefresh={() => {}}
          refreshing={false}
          loadCalls={async () => []}
          onPanelClose={() => {}}
          usable={() => true}
        />,
      ),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="收起"]')!.click(),
    );
    expect(pick).toHaveBeenCalledWith("codex");
    expect(pick).not.toHaveBeenCalledWith("api");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("does not open the deck while the agent configuration is loading", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const openChange = vi.fn();
  const items: DeckItem[] = [
    {
      id: "codex",
      title: "Codex",
      icon: null,
      status: "ready",
      tour: "agent-card",
    },
  ];
  try {
    await act(async () =>
      root.render(
        <AgentDeck
          items={items}
          front="codex"
          open={false}
          disabled
          onOpenChange={openChange}
          onPick={() => true}
          onFallback={() => {}}
          onDetail={() => true}
          onRefresh={() => {}}
          refreshing={false}
          loadCalls={async () => []}
          onPanelClose={() => {}}
          usable={() => true}
        />,
      ),
    );
    const button = host.querySelector<HTMLButtonElement>(
      '[aria-label="展开 Agent 卡片"]',
    )!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(openChange).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("follows a refreshed selection before the user navigates", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useReaderStore.getState().setTheme({ reducedMotion: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const pick = vi.fn(() => true);
  const render = (selected: string) =>
    root.render(
      <AgentDeck
        items={["codex", "api"].map((id) => ({
          id,
          title: id,
          icon: null,
          status: "ready" as const,
          selected: id === selected,
          tour: "agent-card" as const,
        }))}
        front="codex"
        open
        onOpenChange={() => {}}
        onPick={pick}
        onFallback={() => {}}
        onDetail={() => true}
        onRefresh={() => {}}
        refreshing={false}
        loadCalls={async () => []}
        onPanelClose={() => {}}
        usable={() => true}
      />,
    );
  try {
    await act(async () => render("codex"));
    await act(async () => render("api"));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="收起"]')!.click(),
    );
    expect(pick).toHaveBeenCalledWith("api");
    expect(pick).not.toHaveBeenCalledWith("codex");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

// Drive animation time explicitly so input speed and settling can be compared.
async function scrollDeck(
  delta: number,
  reduced = false,
  reverse = false,
  dismissEarly = false,
  ready = true,
  events = 3,
) {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useReaderStore.getState().setTheme({ reducedMotion: reduced });
  let now = 0;
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const pick = vi.fn(() => true);
  const items: DeckItem[] = Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    title: String(i),
    icon: null,
    status: "ready",
    tour: "agent-card",
  }));
  const tick = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await act(async () => {
        now += 16;
        vi.advanceTimersByTime(16);
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(now));
      });
    }
  };
  const distance = () => {
    const card = host.querySelector<HTMLElement>(
      '[data-tour="agent-deck"] [data-agent="0"]',
    )!;
    return -Number(card.style.transform.match(/-50% \+ ([\d.e+-]+)px/)![1]);
  };
  const wheel = async (amount: number) =>
    act(async () => {
      host
        .querySelector('[data-testid="deck-dialog"]')!
        .dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaY: amount }),
        );
    });
  try {
    await act(async () =>
      root.render(
        <AgentDeck
          items={items}
          front="0"
          open
          onOpenChange={() => {}}
          onPick={pick}
          onDetail={() => true}
          onRefresh={() => {}}
          refreshing={false}
          loadCalls={async () => []}
          onPanelClose={() => {}}
          onFallback={() => {}}
          usable={() => ready}
        />,
      ),
    );
    await tick(2);
    let firstInput = 0;
    for (let i = 0; i < events; i++) {
      await wheel(delta);
      if (i === 0) firstInput = distance();
      await tick(1);
    }
    if (dismissEarly) {
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="收起"]')!.click(),
      );
      if (ready) expect(pick).toHaveBeenCalledTimes(1);
      else expect(pick).not.toHaveBeenCalled();
    }
    const during = distance();
    // CSS must not interpolate either wheel updates or loop-edge jumps.
    for (const card of host.querySelectorAll<HTMLElement>(
      '[data-tour="agent-deck"] .agent-deck-card',
    ))
      expect(card.style.transition).toBe("box-shadow 200ms");
    if (reverse) await wheel(-delta);
    await tick(1);
    const next = distance();
    await tick(5);
    const coasting = distance();
    await tick(10);
    const lateStart = distance();
    await tick(5);
    const lateTravel = distance() - lateStart;
    await tick(125);
    const settled = distance();
    expect(frames.size).toBe(0);
    const centered = host.querySelector(
      '[data-tour="agent-deck"] [data-center="true"]',
    );
    expect(centered).not.toBeNull();
    if (ready)
      expect(pick).toHaveBeenLastCalledWith(
        centered?.getAttribute("data-agent"),
      );
    else expect(pick).not.toHaveBeenCalled();
    return { firstInput, during, next, coasting, settled, lateTravel };
  } finally {
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
}

const deckStep = () =>
  Math.round(Math.min(124, Math.max(88, window.innerHeight * 0.14)));

it("follows small trackpad deltas one to one without a CSS transition, then snaps forward", async () => {
  const slow = await scrollDeck(10);
  const fast = await scrollDeck(20);
  expect(slow.firstInput).toBeCloseTo(10);
  expect(fast.firstInput).toBeCloseTo(20);
  expect(slow.during).toBeCloseTo(30);
  expect(fast.during).toBeCloseTo(60);
  // Any deliberate gesture lands on the next card instead of springing back.
  expect(slow.settled).toBeCloseTo(deckStep());
  expect(fast.settled).toBeCloseTo(deckStep());
});

it("eases mouse wheel notches instead of jumping a whole card per event", async () => {
  const notches = await scrollDeck(100);
  // The notch starts an animation; cards do not jump on the event itself.
  expect(notches.firstInput).toBeCloseTo(0);
  expect(notches.during).toBeGreaterThan(0);
  expect(notches.during).toBeLessThan(300);
  expect(notches.settled).toBeCloseTo(
    Math.round(300 / deckStep()) * deckStep(),
  );
});

it("moves one card for a single short wheel notch", async () => {
  const notch = await scrollDeck(40, false, false, false, true, 1);
  expect(notch.settled).toBeCloseTo(deckStep());
  const back = await scrollDeck(-40, false, false, false, true, 1);
  expect(back.settled).toBeCloseTo(-deckStep());
});

it("responds to reversal without finishing the previous queued travel", async () => {
  const reversed = await scrollDeck(240, false, true);
  expect(reversed.next).toBeLessThan(reversed.during);
});

it("wraps a card from the top to the bottom without interpolating across the deck", async () => {
  const wrapped = await scrollDeck(600);
  expect(wrapped.settled).toBeLessThan(0);
});

it("keeps wheel navigation immediate with reduced motion", async () => {
  const reduced = await scrollDeck(240, true);
  expect(reduced.next).toBe(reduced.during);
  expect(reduced.coasting).toBe(reduced.during);
  expect(reduced.settled).toBe(reduced.during);
});

it("selects the ready wheel target when closed before the wheel timer fires", async () => {
  await scrollDeck(240, true, false, true);
});

it("keeps the existing selection when scrolling to an unready agent", async () => {
  await scrollDeck(240, true, false, true, false);
});

afterEach(() => useReaderStore.getState().setTheme({ reducedMotion: false }));
