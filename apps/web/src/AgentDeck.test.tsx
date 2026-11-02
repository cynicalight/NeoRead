// @vitest-environment jsdom
import { useReaderStore } from "./store";
import { act, type ReactNode, type WheelEventHandler } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDeck, type DeckItem } from "./AgentDeck";

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

// Drive animation time explicitly so input speed and settling can be compared.
async function scrollDeck(delta: number, reduced = false, reverse = false) {
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
          usable={() => true}
        />,
      ),
    );
    await tick(2);
    for (let i = 0; i < 3; i++) {
      await wheel(delta);
      await tick(1);
    }
    const during = distance();
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
    expect(pick).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(
      host.querySelector('[data-tour="agent-deck"] [data-center="true"]'),
    ).not.toBeNull();
    return { during, next, coasting, settled, lateTravel };
  } finally {
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
}

it("accelerates with wheel input and coasts to a card after input stops", async () => {
  const slow = await scrollDeck(60);
  const fast = await scrollDeck(240);
  expect(fast.during).toBeGreaterThan(slow.during * 3);
  expect(fast.coasting).toBeGreaterThan(fast.during);
  expect(fast.settled).toBeGreaterThan(fast.coasting);
  expect(fast.lateTravel).toBeGreaterThan(0);
  expect(fast.lateTravel).toBeLessThan(fast.coasting - fast.next);
});

it("responds to reversal without finishing the previous queued travel", async () => {
  const reversed = await scrollDeck(240, false, true);
  expect(reversed.next).toBeLessThan(reversed.during);
});

it("keeps wheel navigation immediate with reduced motion", async () => {
  const reduced = await scrollDeck(240, true);
  expect(reduced.next).toBe(reduced.during);
  expect(reduced.coasting).toBe(reduced.during);
  expect(reduced.settled).toBe(reduced.during);
});

afterEach(() => useReaderStore.getState().setTheme({ reducedMotion: false }));
