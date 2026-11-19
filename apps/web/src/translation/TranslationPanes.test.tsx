// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslationPanes } from "./TranslationPanes";
import { defaultTheme } from "@neoread/core";
import { useReaderStore } from "../store";
import { readerLayout, updateReaderLayout } from "../neoread-layout";

let host: HTMLDivElement, root: Root;
const mount = vi.fn(),
  unmount = vi.fn();
function Source() {
  useEffect(() => {
    mount();
    return unmount;
  }, []);
  return <div data-source>PDF</div>;
}
function Harness() {
  const [mode, setMode] = useState<"source" | "parallel" | "translation">(
    "source",
  );
  const theme = useReaderStore((state) => state.theme);
  const { swapped, sourceWidth } = readerLayout(theme.readerLayout);
  return (
    <>
      {(["source", "parallel", "translation"] as const).map((value) => (
        <button key={value} onClick={() => setMode(value)}>
          {value}
        </button>
      ))}
      <TranslationPanes
        mode={mode}
        swapped={swapped}
        onSwap={() => updateReaderLayout({ swapped: !swapped })}
        sourceWidth={sourceWidth}
        onSourceWidthChange={(sourceWidth) =>
          updateReaderLayout({ sourceWidth })
        }
        source={<Source />}
        translation={<div>译文</div>}
      />
    </>
  );
}
// jsdom has no layout engine. Supply a 1000px panel area and a 1px divider,
// while keeping the actual resizable components, events and layout state.
function width(element: HTMLElement): number {
  if (element.hasAttribute("data-panel")) {
    return (
      10 * parseFloat(element.style.flexGrow || element.style.flexBasis || "50")
    );
  }
  if (element.hasAttribute("data-separator")) return element.hidden ? 0 : 1;
  return 1001;
}
function visualChildren(element: Element): HTMLElement[] {
  const children = [...element.children] as HTMLElement[];
  // Mirror translation.css: only the group's direct children change order.
  return element.hasAttribute("data-group") &&
    element.parentElement?.hasAttribute("data-swapped")
    ? children.reverse()
    : children;
}
function left(element: HTMLElement): number {
  let offset = 0;
  for (const sibling of visualChildren(element.parentElement!)) {
    if (sibling === element) break;
    offset += width(sibling);
  }
  return offset;
}
beforeEach(async () => {
  useReaderStore.setState({ theme: defaultTheme });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return width(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(
    function (this: HTMLElement) {
      return left(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const controls = this.closest<HTMLElement>(".translation-pane-controls");
      if (controls)
        return new DOMRect(
          parseFloat(controls.style.getPropertyValue("--divider-at")) * 10 - 12,
          12,
          24,
          24,
        );
      return new DOMRect(
        this.hasAttribute("data-group") ? 0 : left(this),
        0,
        width(this),
        600,
      );
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  )!;
  await act(async () => button.click());
}
function sourceSize() {
  return parseFloat(
    host.querySelector("[data-source]")!.closest<HTMLElement>("[data-panel]")!
      .style.flexGrow,
  );
}
async function drag(delta: number) {
  const divider = host.querySelector<HTMLElement>('[role="separator"]')!;
  const x = divider.getBoundingClientRect().left;
  await act(async () =>
    divider.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 200,
      }),
    ),
  );
  await act(async () =>
    document.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: x + delta,
        clientY: 200,
        buttons: 1,
      }),
    ),
  );
  await act(async () =>
    document.dispatchEvent(
      new MouseEvent("pointerup", {
        bubbles: true,
        clientX: x + delta,
        clientY: 200,
      }),
    ),
  );
}
it("resizes by pointer in both orders and retains the PDF instance and chosen width across modes", async () => {
  expect(sourceSize()).toBe(100);
  await click("parallel");
  expect(sourceSize()).toBe(50);
  await drag(100);
  expect(sourceSize()).toBeCloseTo(60);
  await click("交换原文和译文");
  expect(sourceSize()).toBeCloseTo(60);
  const group = host.querySelector("[data-group]")!;
  expect(
    visualChildren(group).at(-1)!.querySelector("[data-source]"),
  ).not.toBeNull();
  await drag(100);
  expect(sourceSize()).toBeCloseTo(50);
  await drag(-150);
  expect(sourceSize()).toBeCloseTo(65);
  await click("translation");
  expect(sourceSize()).toBe(0);
  await click("source");
  expect(sourceSize()).toBe(100);
  await click("parallel");
  expect(sourceSize()).toBeCloseTo(65);
  expect(mount).toHaveBeenCalledTimes(1);
  expect(unmount).not.toHaveBeenCalled();
});
it("supports keyboard resizing and keeps clicks on the swap button out of the drag interaction", async () => {
  await click("parallel");
  const divider = host.querySelector<HTMLElement>('[role="separator"]')!;
  await act(async () =>
    divider.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(sourceSize()).toBeGreaterThan(50);
  const before = sourceSize();
  const button = host.querySelector<HTMLButtonElement>(
    '[aria-label="交换原文和译文"]',
  )!;
  const x =
    parseFloat(button.parentElement!.style.getPropertyValue("--divider-at")) *
    10;
  await act(async () => {
    button.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 24,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: x + 50,
        clientY: 24,
        buttons: 1,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("pointerup", {
        bubbles: true,
        clientX: x + 50,
        clientY: 24,
      }),
    );
  });
  expect(sourceSize()).toBe(before);
  await click("交换原文和译文");
  expect(sourceSize()).toBe(before);
});

it("restores the last source width and order after leaving a document, without saving single-pane widths", async () => {
  await click("parallel");
  await drag(150);
  await click("交换原文和译文");
  await drag(50);
  expect(sourceSize()).toBeCloseTo(60);
  await click("translation");
  expect(useReaderStore.getState().theme.readerLayout).toMatchObject({
    sourceWidth: expect.closeTo(60),
    swapped: true,
  });
  const saved = JSON.parse(JSON.stringify(useReaderStore.getState().theme));
  await act(async () => root.unmount());
  useReaderStore.setState({ theme: saved });
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  await click("parallel");
  expect(sourceSize()).toBeCloseTo(60);
  expect(
    visualChildren(host.querySelector("[data-group]")!)
      .at(-1)!.querySelector("[data-source]"),
  ).not.toBeNull();
});

it("stacks source and translation top and bottom without remounting the source", async () => {
  await click("parallel");
  expect(mount).toHaveBeenCalledTimes(1);
  const divider = () => host.querySelector<HTMLElement>('[role="separator"]')!;
  expect(divider().getAttribute("aria-orientation")).toBe("vertical");
  await click("上下排列");
  expect(
    readerLayout(useReaderStore.getState().theme.readerLayout).stacked,
  ).toBe(true);
  expect(
    host.querySelector(".translation-panes")!.hasAttribute("data-stacked"),
  ).toBe(true);
  expect(divider().getAttribute("aria-orientation")).toBe("horizontal");
  expect(divider().getAttribute("aria-label")).toBe("调整原文和译文高度");
  const controls = host.querySelector<HTMLElement>(
    ".translation-pane-controls",
  )!;
  expect(
    parseFloat(controls.style.getPropertyValue("--divider-at")),
  ).toBeCloseTo(sourceSize());
  await click("交换原文和译文");
  await click("左右排列");
  expect(
    readerLayout(useReaderStore.getState().theme.readerLayout),
  ).toMatchObject({ stacked: false, swapped: true });
  expect(divider().getAttribute("aria-orientation")).toBe("vertical");
  expect(mount).toHaveBeenCalledTimes(1);
  expect(unmount).not.toHaveBeenCalled();
});

it.each([false, true])(
  "swaps panes without moving scroll containers in the DOM (stacked=%s)",
  async (stacked) => {
    await click("parallel");
    if (stacked) await click("上下排列");
    const group = host.querySelector("[data-group]")!;
    const source = host.querySelector<HTMLElement>("[data-source]")!;
    const translation = group.lastElementChild!.firstElementChild as HTMLElement;
    source.scrollTop = 7245;
    source.scrollLeft = 35;
    translation.scrollTop = 1234;
    const children = [...group.children];
    // jsdom does not reset scroll on DOM reinsertion as browsers do. Assert
    // that swapping never removes/reinserts the panels containing either view.
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(group, { childList: true });
    try {
      for (const swapped of [true, false, true]) {
        await click("交换原文和译文");
        expect([...mutations, ...observer.takeRecords()]).toEqual([]);
        expect([...group.children]).toEqual(children);
        expect(
          visualChildren(group).at(swapped ? -1 : 0)!.contains(source),
        ).toBe(true);
        expect(source.scrollTop).toBe(7245);
        expect(source.scrollLeft).toBe(35);
        expect(translation.scrollTop).toBe(1234);
      }
    } finally {
      observer.disconnect();
    }
  },
);

it("hides the layout controls outside parallel mode", async () => {
  expect(host.querySelector('[aria-label="上下排列"]')).toBeNull();
  await click("translation");
  expect(host.querySelector('[aria-label="上下排列"]')).toBeNull();
});
