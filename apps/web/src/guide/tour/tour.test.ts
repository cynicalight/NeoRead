import { describe, expect, it } from "vitest";
import { blockedRects, frameRect, placeCard, type Rect } from "./geometry";
import { resolveStep, tourSteps, type TourState } from "./steps";

const area = (rects: Rect[]) =>
  rects.reduce((sum, r) => sum + r.width * r.height, 0);
const covers = (rects: Rect[], x: number, y: number) =>
  rects.some(
    (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
  );

describe("tour breathing frame", () => {
  it("keeps a right and bottom aligned assistant panel inside the screen", () => {
    expect(
      frameRect(
        { x: 800, y: 52, width: 400, height: 748 },
        { width: 1200, height: 800 },
      ),
    ).toEqual({ x: 795, y: 47, width: 397, height: 745 });
  });
  it("preserves padding for targets away from screen edges", () => {
    expect(
      frameRect(
        { x: 100, y: 100, width: 100, height: 50 },
        { width: 1200, height: 800 },
      ),
    ).toEqual({ x: 95, y: 95, width: 110, height: 60 });
  });
  it("contains a target larger than a small viewport", () => {
    expect(
      frameRect(
        { x: -20, y: -20, width: 900, height: 900 },
        { width: 320, height: 480 },
      ),
    ).toEqual({ x: 8, y: 8, width: 304, height: 464 });
  });
});

describe("tour pointer blocking", () => {
  const viewport = { width: 100, height: 100 };
  it("blocks everything but the hole", () => {
    const blocked = blockedRects(viewport, [
      { x: 10, y: 10, width: 20, height: 20 },
    ]);
    expect(area(blocked)).toBe(100 * 100 - 20 * 20);
    expect(covers(blocked, 20, 20)).toBe(false);
    expect(covers(blocked, 5, 20)).toBe(true);
  });
  it("keeps overlapping holes open", () => {
    // A select popup drawn over its trigger.
    const blocked = blockedRects(viewport, [
      { x: 10, y: 10, width: 40, height: 10 },
      { x: 20, y: 5, width: 20, height: 40 },
    ]);
    expect(covers(blocked, 30, 15)).toBe(false);
    expect(covers(blocked, 12, 15)).toBe(false);
    expect(covers(blocked, 30, 40)).toBe(false);
    expect(covers(blocked, 12, 40)).toBe(true);
    expect(area(blocked)).toBe(100 * 100 - (400 + 800 - 200));
  });
  it("ignores holes outside the viewport", () => {
    const blocked = blockedRects(viewport, [
      { x: -50, y: 0, width: 20, height: 20 },
    ]);
    expect(area(blocked)).toBe(100 * 100);
  });
});

describe("tour card placement", () => {
  const viewport = { width: 1200, height: 800 };
  const card = { width: 300, height: 160 };
  it("sits beside the anchor", () => {
    const anchor = { x: 16, y: 700, width: 200, height: 36 };
    const at = placeCard(anchor, card, viewport, [anchor]);
    expect(at.x).toBeGreaterThanOrEqual(anchor.x + anchor.width);
  });
  it("avoids the areas the step lights", () => {
    const anchor = { x: 300, y: 200, width: 600, height: 36 };
    const cards = { x: 300, y: 250, width: 600, height: 300 };
    const at = placeCard(anchor, card, viewport, [anchor, cards]);
    const box = { ...at, ...card };
    const hit = (r: Rect) =>
      box.x < r.x + r.width &&
      box.x + box.width > r.x &&
      box.y < r.y + r.height &&
      box.y + box.height > r.y;
    expect(hit(anchor) || hit(cards)).toBe(false);
  });
  it("sits on the preferred side, such as left of the agent panel", () => {
    const panel = { x: 860, y: 52, width: 340, height: 748 };
    const at = placeCard(panel, card, viewport, [panel], "left");
    expect(at.x + card.width).toBeLessThanOrEqual(panel.x);
  });
  it("keeps the close control clear across small window sizes and card heights", () => {
    for (const width of [340, 400, 640, 800]) {
      for (const height of [340, 400, 600]) {
        for (const cardHeight of [160, 200]) {
          const target = { x: width - 60, y: 60, width: 40, height: 40 };
          const size = { width: 300, height: cardHeight };
          const at = placeCard(target, size, { width, height }, [], undefined, [
            target,
          ]);
          expect(
            at.x + size.width <= target.x ||
              at.x >= target.x + target.width ||
              at.y + size.height <= target.y ||
              at.y >= target.y + target.height,
          ).toBe(true);
        }
      }
    }
  });
  it("protects controls even when avoiding a large highlighted area would cover them", () => {
    const target = { x: 280, y: 65, width: 30, height: 30 };
    const panel = { x: 0, y: 110, width: 340, height: 390 };
    const at = placeCard(
      target,
      card,
      { width: 340, height: 500 },
      [panel],
      undefined,
      [target],
    );
    expect(at.y).toBeGreaterThanOrEqual(target.y + target.height);
  });
  it("uses a free strip when the usual side and corner candidates are blocked", () => {
    const anchor = { x: 350, y: 60, width: 30, height: 30 };
    const required = [
      { x: 0, y: 0, width: 400, height: 200 },
      { x: 0, y: 400, width: 400, height: 200 },
    ];
    const at = placeCard(
      anchor,
      card,
      { width: 400, height: 600 },
      [],
      undefined,
      required,
    );
    expect(at.y).toBeGreaterThanOrEqual(200);
    expect(at.y + card.height).toBeLessThanOrEqual(400);
  });
  it("keeps a tall card visible in a scrollable region beside the close button", () => {
    const target = { x: 280, y: 60, width: 40, height: 40 };
    const size = { width: 300, height: 260 };
    const at = placeCard(
      target,
      size,
      { width: 340, height: 300 },
      [],
      undefined,
      [target],
    );
    expect(at.maxHeight).toBeGreaterThanOrEqual(48);
    expect(at.y).toBeGreaterThanOrEqual(target.y + target.height);
    expect(at.y + at.maxHeight!).toBeLessThanOrEqual(284);
    expect(at.maxWidth).toBeGreaterThanOrEqual(180);
    expect(at).not.toHaveProperty("hidden");
    const expanded = placeCard(target, size, viewport, [], undefined, [target]);
    expect(expanded.maxHeight).toBeUndefined();
  });
  it("centres without an anchor", () => {
    expect(placeCard(null, card, viewport)).toEqual({ x: 450, y: 320 });
  });
  it("keeps the welcome centered when a corner control needs clearance", () => {
    const skip = { x: 12, y: viewport.height - 52, width: 148, height: 40 };
    expect(placeCard(null, card, viewport, [], undefined, [skip])).toEqual({
      x: 450,
      y: 320,
    });
  });
});

const base: TourState = {
  settings: false,
  agentPanel: false,
  detecting: false,
  apiDetails: false,
  agents: [],
  primaryReady: false,
  taskModels: false,
  sidebar: true,
  importDialog: false,
  imported: 0,
  reading: false,
  readingModes: false,
  assistant: false,
  shell: "终端",
  acknowledged: new Set(),
};
const at = (index: number, patch: Partial<TourState>) => {
  const state = { ...base, ...patch };
  const step = tourSteps[resolveStep(tourSteps, index, state)];
  return { id: step?.id, view: step?.view(state) };
};
const index = (id: string) => tourSteps.findIndex((s) => s.id === id);
const inSettings = {
  acknowledged: new Set(["welcome"]),
  settings: true,
  agentPanel: true,
};
const local = { ...inSettings, deckOpen: true, method: "local" };

describe("tour steps", () => {
  it("waits for the welcome to be confirmed", () => {
    expect(at(0, {}).id).toBe("welcome");
    expect(at(0, { acknowledged: new Set(["welcome"]) }).view?.click).toEqual([
      '[data-tour="open-settings"]',
    ]);
  });
  it("opens the sidebar first when the settings button is hidden", () => {
    const { view } = at(1, {
      acknowledged: new Set(["welcome"]),
      sidebar: false,
    });
    expect(view?.click).toEqual(['[aria-label="切换侧栏"]']);
  });
  it("offers only local CLI and API connection methods", () => {
    const { view } = at(1, inSettings);
    expect(view?.title).toBe("选择连接方式");
    expect(view?.options?.map((o) => [o.label, !!o.disabled])).toEqual([
      ["本地 CLI Agent", false],
      ["API Key", false],
    ]);
  });
  it("frames the full Agent section before expanding the stack", () => {
    expect(at(1, inSettings).view?.focus).toEqual([
      '[data-tour="agent-connection"]',
    ]);
    const view = at(1, { ...inSettings, method: "api" }).view;
    expect(view?.title).toBe("展开 Agent 卡片");
    expect(view?.click).toEqual(['[data-tour="agent-stack"]']);
    expect(view?.focus).toEqual(['[data-tour="agent-connection"]']);
  });
  it("points at the lower-right blank area when collapsing the deck", () => {
    const view = at(index("close-settings"), {
      ...inSettings,
      deckOpen: true,
    }).view;
    expect(view?.body).toContain("单击空白处");
    expect(view?.focus).toEqual([]);
    expect(view?.click).toEqual(['[data-tour="agent-deck-backdrop"]']);
    expect(view?.pointer).toEqual({
      gesture: "click",
      target: '[data-tour="agent-deck-dismiss"]',
    });
  });
  it("offers a return path if agent details are opened during onboarding", () => {
    const view = at(index("agent"), { ...local, agentDetails: true }).view;
    expect(view?.nextTarget).toBe(
      '[data-tour="agent-detail"] [aria-label="返回卡片"]',
    );
  });
  it("points at the API card once API Key is chosen", () => {
    const { view } = at(1, {
      ...inSettings,
      method: "api",
      deckOpen: true,
      agents: [{ id: "codex", status: "ready" }],
    });
    expect(view?.pointer).toEqual({
      gesture: "click",
      target:
        '[data-tour="agent-deck"][data-spread] [data-tour="agent-card"][data-agent="api"]',
    });
  });
  it("points at the key field and DeepSeek inside the API settings", () => {
    // The API settings hide the tabs, including the Agent panel.
    const { view } = at(1, {
      ...inSettings,
      agentPanel: false,
      method: "api",
      apiDetails: true,
    });
    expect(view?.title).toBe("填写 API Key");
    expect(view?.click).toEqual(['[data-tour="api-panel"]']);
    expect(view?.pointer).toEqual({
      gesture: "click",
      target: '[data-tour="api-form"] input[aria-label="API Key"]',
    });
    expect(view?.link?.url).toContain("platform.deepseek.com");
  });
  it("tours the local agent cards while detecting", () => {
    const { id, view } = at(1, { ...local, detecting: true });
    expect(id).toBe("agent");
    expect(view?.focus).toEqual(['[data-tour="agent-deck"][data-spread]']);
  });
  it("points at a detected agent card", () => {
    const agents = [
      { id: "codex", status: "missing" as const },
      { id: "claude", status: "ready" as const },
    ];
    const view = at(1, { ...local, agents }).view;
    expect(view?.title).toBe("选择 Claude Code");
    expect(view?.click).toEqual(['[data-tour="agent-deck"][data-spread]']);
    expect(view?.focus).toEqual([
      '[data-tour="agent-deck"][data-spread] [data-tour="agent-card"][data-agent="claude"]',
    ]);
    expect(view?.pointer).toEqual({
      gesture: "click",
      target:
        '[data-tour="agent-deck"][data-spread] [data-tour="agent-card"][data-agent="claude"]',
    });
  });
  it("suggests logging in or an API key when nothing works", () => {
    const failed = at(1, {
      ...local,
      agents: [{ id: "codex", status: "failed" }],
    }).view;
    expect(failed?.body).toContain("`codex login`");
    expect(failed?.body).toContain("mac 终端 / windows powershell");
    expect(at(1, { ...local, detecting: true }).view?.body).toContain(
      "不是 Codex App",
    );
    expect(failed?.click).toContain(
      '[data-slot="agent-deck"] [aria-label="刷新全部状态"]',
    );
  });
  it("moves on once the chosen agent works", () => {
    const ready = { ...inSettings, primaryReady: true, taskModels: true };
    expect(at(index("agent"), ready).id).toBe("models");
    expect(
      at(index("agent"), {
        ...ready,
        acknowledged: new Set(["welcome", "models"]),
      }).id,
    ).toBe("close-settings");
    // Closing the settings early also continues.
    expect(
      at(index("agent"), { ...ready, settings: false, agentPanel: false }).id,
    ).toBe("import");
  });
  it("returns to the settings button if they close before an agent works", () => {
    expect(at(index("agent"), { ...inSettings, settings: false }).id).toBe(
      "settings",
    );
  });
  it("follows the import into reading", () => {
    const i = index("import");
    expect(at(i, {}).id).toBe("import");
    expect(at(i, { importDialog: true }).id).toBe("import-dialog");
    expect(
      at(index("import-dialog"), { library: "paper" }).view?.pointer,
    ).toMatchObject({ gesture: "double" });
    expect(at(index("open"), { reading: true, readingModes: true }).id).toBe(
      "modes",
    );
    expect(at(index("modes"), { library: "paper" }).id).toBe("open");
  });
  it("points at the prepared example paper for the reading demonstration", () => {
    const libraryTarget = '[data-paper-id="example"]';
    const view = at(index("open"), {
      library: "paper",
      examplePaper: true,
      libraryTarget,
    }).view;
    expect(view?.body).toContain("Attention Is All You Need");
    expect(view?.body).toContain("已完成解析和中文翻译");
    expect(view?.click).toEqual([libraryTarget]);
    expect(view?.pointer).toMatchObject({
      gesture: "double",
      target: libraryTarget,
    });
  });
  it("only lets the import dialog be closed", () => {
    const view = at(index("import-dialog"), { importDialog: true }).view;
    expect(view?.click).toEqual([
      '[data-tour="import-dialog"] > [data-slot="dialog-close"]',
    ]);
    expect(view?.next).toBeUndefined();
  });
  it("finishes after the last confirmation", () => {
    expect(
      resolveStep(tourSteps, index("finish"), {
        ...base,
        acknowledged: new Set(["finish"]),
      }),
    ).toBe(tourSteps.length);
  });
});

it("requires parallel mode before demonstrating source block focus", () => {
  const reading = {
    reading: true,
    readingModes: true,
    pdfReading: true,
    library: "paper" as const,
  };
  expect(at(index("modes"), reading).view?.pointer).toMatchObject({
    gesture: "click",
    target: '[data-tour="parallel-mode"]',
  });
  expect(
    at(index("modes"), { ...reading, parallel: true, sourceBlock: true }).id,
  ).toBe("focus-block");
  expect(at(index("focus-block"), { ...reading, parallel: false }).id).toBe(
    "modes",
  );
  expect(
    at(index("focus-block"), { ...reading, parallel: true, sourceBlock: true })
      .view?.pointer?.gesture,
  ).toBe("click");
  const focused = at(index("focus-block"), {
    ...reading,
    parallel: true,
    sourceBlock: true,
    blockFocused: true,
  });
  expect(focused.id).toBe("focus-block");
  expect(focused.view?.next).toBeUndefined();
  expect(focused.view?.advanceAfter).toBe(3000);
  expect(
    at(index("focus-block"), {
      ...reading,
      parallel: true,
      acknowledged: new Set(["focus-block"]),
    }).id,
  ).toBe("assistant");
  expect(
    at(index("focus-block"), {
      reading: true,
      pdfReading: false,
      parallel: true,
    }).id,
  ).toBe("assistant");
});

it("only offers 下一步 at Agent configuration and permits continuing without a model", () => {
  const state = { ...base, settings: true, agentPanel: true };
  const nextSteps = tourSteps.filter(
    (step) => step.view(state).next === "下一步",
  );
  expect(nextSteps.map((step) => step.id)).toEqual(["agent"]);
  const next = at(index("agent"), {
    ...state,
    acknowledged: new Set(["agent"]),
    taskModels: true,
  });
  expect(next.id).toBe("close-settings");
  expect(next.view?.title).toBe("稍后配置 Agent");
  expect(at(index("close-settings"), { settings: false }).id).toBe("import");
});
