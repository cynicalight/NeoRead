// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PaperGraph } from "./PaperGraph";
import { paper } from "./fixtures";
const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("../motion", () => ({
  reducedMotion: () => motion.reduced,
  subscribeMotion: () => () => {},
}));

let host: HTMLDivElement;
let root: Root;
const select = vi.fn();
const open = vi.fn();
const disconnect = vi.fn();
const docs = [
  paper({
    id: "a",
    title: "First Paper",
    author: "Ada Lovelace",
    metadata: { venue: "ICML" },
    related: ["b"],
  }),
  paper({
    id: "b",
    title: "Second Paper",
    author: "Ada Lovelace",
    metadata: { venue: "ICML", translatedTitle: "第二篇论文" },
    related: ["a"],
  }),
  paper({ id: "c", title: "Isolated Paper" }),
];
function button(name: string) {
  const match = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name ||
      element.textContent === name,
  );
  if (!match) throw new Error(`Missing button ${name}`);
  return match;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function render(selectedId: string | null = null) {
  await act(async () =>
    root.render(
      <PaperGraph
        documents={docs}
        selectedId={selectedId}
        showBilingualTitles={false}
        onSelect={select}
        onOpen={open}
      />,
    ),
  );
}
beforeEach(() => {
  motion.reduced = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {
        disconnect();
      }
    },
  );
  select.mockClear();
  open.mockClear();
  disconnect.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("exposes native keyboard-operable paper controls, selects without opening, and opens explicitly or by double click", async () => {
  await render();
  const node = button("论文：First Paper");
  expect(node.tagName).toBe("BUTTON");
  expect(node.closest('[aria-hidden="true"]')).toBeNull();
  await act(async () => node.focus());
  expect(document.activeElement).toBe(node);
  // Native buttons dispatch click for Enter/Space; keyboard-generated clicks have detail=0.
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  });
  expect(select).toHaveBeenLastCalledWith(docs[0]);
  expect(open).not.toHaveBeenCalled();
  await act(async () => {
    node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(open).toHaveBeenLastCalledWith(docs[0]);
  await click(button("打开论文：Isolated Paper"));
  expect(open).toHaveBeenLastCalledWith(docs[2]);
});

it("shows shared-author papers with readable relation type and does not select a document for a hub", async () => {
  await render();
  await click(button("作者：Ada Lovelace"));
  expect(select).not.toHaveBeenCalled();
  const inspector = host.querySelector("aside")!;
  expect(inspector.textContent).toContain("作者 · Ada Lovelace");
  expect(inspector.textContent).toContain("First Paper");
  expect(inspector.textContent).toContain("Second Paper");
  expect(inspector.textContent).not.toContain("Isolated Paper");
  expect(
    host
      .querySelector('[aria-label="论文：Isolated Paper"]')
      ?.hasAttribute("data-dim"),
  ).toBe(true);
  await click(button("清除图谱聚焦"));
  expect(inspector.textContent).toContain("全部论文");
  expect(inspector.textContent).toContain("Isolated Paper");
});

it("preserves all readable relation types when the same papers are connected manually and through hubs", async () => {
  await render("a");
  const text = host.querySelector(".paper-graph-results")!.textContent;
  expect(text).toContain("手动关联");
  expect(text).toContain("作者 · Ada Lovelace");
  expect(text).toContain("出处 ·");
  await click(button("作者"));
  await click(button("出处"));
  expect(host.querySelectorAll(".paper-graph-edge")).toHaveLength(1);
  expect(host.querySelector(".paper-graph-results")!.textContent).toContain(
    "手动关联",
  );
  await click(button("手动关联"));
  expect(host.querySelectorAll(".paper-graph-node")).toHaveLength(3);
  expect(host.textContent).toContain("没有当前已启用类型的关联");
  expect(docs[0].related).toEqual(["b"]);
});

it("searches hubs and papers, centers a result, and gives a meaningful no-results state", async () => {
  await render();
  const input = host.querySelector("input")!;
  async function search(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await search("Ada");
  expect(host.querySelector(".paper-graph-results")!.textContent).toContain(
    "Ada Lovelace",
  );
  expect(host.querySelectorAll(".paper-graph-results li")).toHaveLength(1);
  await click(host.querySelector<HTMLButtonElement>(".paper-graph-result")!);
  expect(host.querySelector(".paper-graph-current")!.textContent).toContain(
    "Ada Lovelace",
  );
  await search("unmatched xyz");
  expect(host.textContent).toContain("未找到匹配节点");
  await search("Second");
  await click(host.querySelector<HTMLButtonElement>(".paper-graph-result")!);
  expect(select).toHaveBeenLastCalledWith(docs[1]);
  await search("第二篇");
  expect(host.querySelectorAll(".paper-graph-results li")).toHaveLength(1);
  expect(host.querySelector(".paper-graph-results")?.textContent).toContain(
    "Second Paper",
  );
});

it("zooms and resets imperatively, ignores secondary drag pointers, and cleans up its observer", async () => {
  await render();
  const viewport = host.querySelector<HTMLDivElement>(".paper-graph-viewport")!;
  const scene = host.querySelector<HTMLDivElement>(".paper-graph-scene")!;
  Object.defineProperties(viewport, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
  });
  viewport.setPointerCapture = vi.fn();
  viewport.releasePointerCapture = vi.fn();
  await click(button("复位图谱"));
  const original = scene.style.transform;
  await click(button("放大图谱"));
  expect(host.querySelector("output")!.textContent).toBe("125%");
  expect(scene.style.transform).not.toBe(original);
  await click(button("复位图谱"));
  expect(scene.style.transform).toBe(original);
  async function pointer(type: string, id: number, x: number) {
    await act(async () => {
      viewport.dispatchEvent(
        Object.assign(
          new MouseEvent(type, {
            bubbles: true,
            button: 0,
            clientX: x,
            clientY: 20,
          }),
          { pointerId: id },
        ),
      );
    });
  }
  await pointer("pointerdown", 1, 20);
  await pointer("pointermove", 2, 90);
  expect(scene.style.transform).toBe(original);
  await pointer("pointermove", 1, 40);
  expect(scene.style.transform).not.toBe(original);
  await pointer("pointercancel", 1, 40);
  const stopped = scene.style.transform;
  await pointer("pointermove", 1, 90);
  expect(scene.style.transform).toBe(stopped);
  await act(async () => root.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
  root = createRoot(host);
});

it("drags a node at the current zoom, pulls its neighbors, and does not select or pan on release", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  await render();
  const viewport = host.querySelector<HTMLDivElement>(".paper-graph-viewport")!;
  Object.defineProperty(viewport, "clientWidth", { value: 800 });
  Object.defineProperty(viewport, "clientHeight", { value: 600 });
  await click(button("复位图谱"));
  await click(button("放大图谱"));
  const scene = host.querySelector<HTMLDivElement>(".paper-graph-scene")!;
  const camera = scene.style.transform;
  const scale = Number(camera.match(/scale\(([^)]+)\)/)![1]);
  const node = button("论文：First Paper");
  const neighbor = button("论文：Second Paper");
  node.setPointerCapture = vi.fn();
  node.hasPointerCapture = () => true;
  node.releasePointerCapture = vi.fn();
  const startX = parseFloat(node.style.left),
    startY = parseFloat(node.style.top);
  const neighborBefore = neighbor.style.cssText;
  const linkBefore = host
    .querySelector(".paper-graph-edges path")!
    .getAttribute("d");
  async function pointer(
    target: HTMLElement,
    type: string,
    id: number,
    x: number,
    y: number,
  ) {
    await act(async () =>
      target.dispatchEvent(
        Object.assign(
          new MouseEvent(type, {
            bubbles: true,
            button: 0,
            clientX: x,
            clientY: y,
          }),
          { pointerId: id },
        ),
      ),
    );
  }
  await pointer(node, "pointerdown", 1, 100, 100);
  await pointer(viewport, "pointermove", 2, 180, 140);
  expect(parseFloat(node.style.left)).toBe(startX);
  await pointer(viewport, "pointermove", 1, 180, 140);
  expect(parseFloat(node.style.left)).toBeCloseTo(startX + 80 / scale);
  expect(parseFloat(node.style.top)).toBeCloseTo(startY + 40 / scale);
  expect(
    host.querySelector(".paper-graph-edges path")!.getAttribute("d"),
  ).not.toBe(linkBefore);
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      const pending = [...frames.values()];
      frames.clear();
      for (const frame of pending) frame(i * 16);
    }
  });
  expect(neighbor.style.cssText).not.toBe(neighborBefore);
  expect(scene.style.transform).toBe(camera);
  await pointer(viewport, "pointerup", 1, 180, 140);
  await click(node);
  expect(select).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  await act(async () => {
    for (let i = 0; i < 200 && frames.size; i++) {
      const pending = [...frames.values()];
      frames.clear();
      for (const frame of pending) frame(i * 16);
    }
  });
  expect(frames.size).toBe(0);
  await pointer(node, "pointerdown", 3, 180, 140);
  await pointer(viewport, "pointerup", 3, 181, 140);
  await click(node);
  expect(select).toHaveBeenCalledExactlyOnceWith(docs[0]);
  await act(async () =>
    node.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(frames.size).toBeGreaterThan(0);
  await act(async () => root.unmount());
  expect(frames.size).toBe(0);
  root = createRoot(host);
});

it("moves nodes with the keyboard without autonomous animation when reduced motion is enabled", async () => {
  motion.reduced = true;
  const requestFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  await render();
  const node = button("论文：First Paper");
  const before = node.style.left;
  await act(async () =>
    node.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(node.style.left).not.toBe(before);
  expect(requestFrame).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});

it("retains moved positions and zoom when metadata and title display change without changing relationships", async () => {
  motion.reduced = true;
  await render();
  const viewport = host.querySelector<HTMLDivElement>(".paper-graph-viewport")!;
  Object.defineProperty(viewport, "clientWidth", { value: 800 });
  Object.defineProperty(viewport, "clientHeight", { value: 600 });
  await click(button("复位图谱"));
  await click(button("放大图谱"));
  const node = button("论文：First Paper");
  await act(async () =>
    node.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  const position = { left: node.style.left, top: node.style.top };
  const camera =
    host.querySelector<HTMLElement>(".paper-graph-scene")!.style.transform;
  await act(async () =>
    root.render(
      <PaperGraph
        documents={docs.map((doc) => ({
          ...doc,
          metadata: { ...doc.metadata, remark: "updated" },
        }))}
        selectedId={null}
        showBilingualTitles
        onSelect={select}
        onOpen={open}
      />,
    ),
  );
  expect({ left: node.style.left, top: node.style.top }).toEqual(position);
  expect(
    host.querySelector<HTMLElement>(".paper-graph-scene")!.style.transform,
  ).toBe(camera);
});

it("flows only along the focused node's relations, outward, and follows a drag", async () => {
  motion.reduced = true;
  await render();
  const flows = () => [
    ...host.querySelectorAll<SVGPathElement>(".paper-graph-flow"),
  ];
  expect(flows()).toHaveLength(0);
  const first = button("论文：First Paper");
  await act(async () =>
    first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
  );
  // Manual link, shared author and shared venue edges of First and Second.
  expect(flows()).toHaveLength(5);
  expect(host.querySelectorAll(".paper-graph-edge[data-active]")).toHaveLength(
    5,
  );
  // Isolated paper stays dim and has no flow.
  expect(button("论文：Isolated Paper").hasAttribute("data-dim")).toBe(true);
  // Every edge touches First or a hub one hop away, so nothing flows back
  // toward it. The manual edge is drawn First → Second.
  expect(flows().some((path) => path.hasAttribute("data-reverse"))).toBe(false);
  const before = flows().map((path) => path.getAttribute("d"));
  await act(async () =>
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(flows().map((path) => path.getAttribute("d"))).not.toEqual(before);
  await act(async () =>
    first.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })),
  );
  expect(flows()).toHaveLength(0);
  // Focusing Second, the manual edge must run against its drawn direction.
  const second = button("论文：Second Paper");
  await act(async () =>
    second.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
  );
  const reversed = flows().filter((path) => path.hasAttribute("data-reverse"));
  expect(reversed).toHaveLength(1);
  expect(reversed[0].getAttribute("data-kind")).toBe("manual");
});
