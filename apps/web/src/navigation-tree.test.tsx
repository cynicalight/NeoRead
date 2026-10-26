// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  DocumentLocation,
  DocumentNavigation,
  TOCItem,
} from "@neoread/core";
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("@neoread/api", () => ({
  api: { navigation: mocks.load, saveNavigation: mocks.save },
}));
vi.mock("./epub-navigation-order", () => ({
  epubNavigationOrders: vi.fn(async () => ({})),
}));
import { NavigationTree } from "./NavigationTree";
let root: Root, host: HTMLDivElement;
const go = vi.fn();
const outline: TOCItem[] = [
  {
    id: "a",
    label: "Parent",
    location: { type: "pdf", page: 1 },
    children: [
      {
        id: "b",
        label: "Child",
        location: { type: "pdf", page: 2 },
        children: [],
      },
    ],
  },
];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.load.mockResolvedValue({ revision: 0, entries: {} });
  mocks.save.mockImplementation(async (_id: string, n: DocumentNavigation) => ({
    ...n,
    revision: n.revision + 1,
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () => {
    root.render(
      <NavigationTree
        documentId="d"
        type="pdf"
        outline={outline}
        blocks={[]}
        annotations={[]}
        go={go}
      />,
    );
  });
it("collapses without navigating and persists across remounts", async () => {
  await render();
  const toggle = host.querySelector<HTMLButtonElement>(
    '[aria-label="折叠 Parent"]',
  )!;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await act(async () => toggle.click());
  expect(go).not.toHaveBeenCalled();
  expect(mocks.save.mock.calls[0][1].entries.a.collapsed).toBe(true);
  expect(
    host
      .querySelector('[aria-label="展开 Parent"]')
      ?.getAttribute("aria-expanded"),
  ).toBe("false");
  mocks.load.mockResolvedValue({
    revision: 1,
    entries: { a: { collapsed: true } },
  });
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect(host.querySelector('[aria-label="展开 Parent"]')).not.toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".navigation-link")!.click(),
  );
  expect(go).toHaveBeenCalledWith({ type: "pdf", page: 1 });
});
it("renames with F2 and Enter without changing the document destination", async () => {
  await render();
  await act(async () =>
    host
      .querySelector(".navigation-row")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "F2", bubbles: true }),
      ),
  );
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="目录名称"]',
  )!;
  expect(input).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, "Custom title");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(mocks.save.mock.calls[0][1].entries.a.label).toBe("Custom title");
  expect(host.textContent).toContain("Custom title");
  expect(go).not.toHaveBeenCalled();
});
it("keeps the old title when a save fails", async () => {
  mocks.save.mockRejectedValue(new Error("保存失败"));
  await render();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="折叠 Parent"]')!
      .click(),
  );
  expect(host.querySelector('[aria-label="折叠 Parent"]')).not.toBeNull();
  expect(mocks.load).toHaveBeenCalledTimes(2);
});
it("keeps inline rename open after choosing the context menu command", async () => {
  await render();
  await act(async () =>
    host.querySelector(".navigation-row")!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        clientX: 20,
        clientY: 20,
      }),
    ),
  );
  const menu = Array.from(
    document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((n) => n.textContent === "重命名")!;
  expect(menu).toBeTruthy();
  await act(async () => menu.click());
  const input = host.querySelector('input[aria-label="目录名称"]');
  expect(input).not.toBeNull();
  await act(async () => {
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
  });
});
it("selects a range with Shift and deletes it in one persisted operation", async () => {
  await render();
  const links = host.querySelectorAll<HTMLButtonElement>(".navigation-link");
  await act(async () => links[0].click());
  go.mockClear();
  await act(async () =>
    links[1].dispatchEvent(
      new MouseEvent("click", { bubbles: true, shiftKey: true }),
    ),
  );
  expect(host.textContent).toContain("取消全选");
  expect(go).not.toHaveBeenCalled();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="删除所选目录"]')!
      .click(),
  );
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.save.mock.calls[0][1].entries).toEqual({
    a: { deleted: true },
    b: { deleted: true },
  });
  expect(host.querySelectorAll(".navigation-row")).toHaveLength(0);
  expect(host.textContent).toContain("暂无目录");
});
it("enters selection from the floating button and toggles with Command", async () => {
  await render();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="多选目录"]')!.click(),
  );
  const links = host.querySelectorAll<HTMLButtonElement>(".navigation-link");
  await act(async () => links[0].click());
  await act(async () =>
    links[1].dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    ),
  );
  expect(host.textContent).toContain("取消全选");
  await act(async () =>
    links[0].dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    ),
  );
  expect(
    host.querySelectorAll('.navigation-link[aria-pressed="true"]'),
  ).toHaveLength(1);
  expect(go).not.toHaveBeenCalled();
});
it("keeps selection and entries when deletion fails", async () => {
  mocks.save.mockRejectedValue(new Error("保存失败"));
  await render();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(".navigation-link")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })),
  );
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="删除所选目录"]')!
      .click(),
  );
  expect(host.querySelectorAll(".navigation-row")).toHaveLength(2);
  expect(
    host.querySelectorAll('.navigation-link[aria-pressed="true"]'),
  ).toHaveLength(1);
});
it("selects without adding row controls and clears selection with Escape", async () => {
  await render();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="多选目录"]')!.click(),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".navigation-link")!.click(),
  );
  expect(
    host.querySelectorAll('.navigation-link[aria-pressed="true"]'),
  ).toHaveLength(1);
  expect(host.querySelector('[role="checkbox"]')).toBeNull();
  expect(host.querySelectorAll(".navigation-row.multi-selected")).toHaveLength(
    1,
  );
  await act(async () =>
    host
      .querySelector("nav")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      ),
  );
  expect(
    host
      .querySelector(".navigation-selection-actions")
      ?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(document.activeElement).toBe(
    host.querySelector('[aria-label="多选目录"]'),
  );
});
it("selects collapsed descendants with select all and can deselect all", async () => {
  mocks.load.mockResolvedValue({
    revision: 1,
    entries: { a: { collapsed: true } },
  });
  await render();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="多选目录"]')!.click(),
  );
  const button = (text: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === text,
    )!;
  await act(async () => button("全选").click());
  expect(host.textContent).toContain("取消全选");
  await act(async () => button("取消全选").click());
  expect(host.textContent).not.toContain("取消全选");
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="删除所选目录"]')!
      .disabled,
  ).toBe(true);
});

const followOutline: TOCItem[] = [
  {
    id: "intro",
    label: "Intro",
    location: { type: "pdf", page: 1 },
    children: [],
  },
  {
    id: "methods",
    label: "Methods",
    location: { type: "pdf", page: 5 },
    children: [
      {
        id: "details",
        label: "Details",
        location: { type: "pdf", page: 7 },
        children: [],
      },
    ],
  },
  {
    id: "appendix",
    label: "Appendix",
    location: { type: "pdf", page: 20 },
    children: [],
  },
];
function followGeometry() {
  const positions: Record<string, [number, number]> = {
    Intro: [10, 30],
    Methods: [150, 180],
    Details: [220, 250],
    Appendix: [300, 330],
  };
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
    function (this: Element) {
      return this.getAttribute("data-slot") === "scroll-area-viewport"
        ? 100
        : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const scroll = host.querySelector<HTMLDivElement>(
        '[data-slot="scroll-area-viewport"]',
      );
      const isViewport = this === scroll;
      const label = this.getAttribute("aria-label")?.replace("目录：", "");
      const [top, bottom] = isViewport
        ? [100, 200]
        : (positions[label ?? ""] ?? [0, 0]).map(
            (x) => 100 + x - (scroll?.scrollTop ?? 0),
          );
      return {
        top,
        bottom,
        left: 0,
        right: 200,
        width: 200,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON() {},
      };
    },
  );
  return () =>
    host.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]')!;
}
const follow = (
  location: DocumentLocation,
  visible = true,
  toc = followOutline,
) =>
  act(async () => {
    root.render(
      <NavigationTree
        documentId="d"
        type={location.type}
        outline={toc}
        blocks={[]}
        annotations={[]}
        go={go}
        location={location}
        visible={visible}
      />,
    );
  });
it("reveals the current heading in both directions without changing the reading location", async () => {
  const scroll = followGeometry();
  await follow({ type: "pdf", page: 25 });
  expect(scroll().scrollTop).toBe(230);
  expect(host.querySelector('[aria-current="location"]')?.textContent).toBe(
    "Appendix20",
  );
  await follow({ type: "pdf", page: 1 });
  expect(scroll().scrollTop).toBe(10);
  expect(go).not.toHaveBeenCalled();
});
it("leaves manual browsing alone within a section and follows again after reopening", async () => {
  const scroll = followGeometry();
  await follow({ type: "pdf", page: 8 });
  expect(scroll().scrollTop).toBe(150);
  scroll().scrollTop = 0;
  await follow({ type: "pdf", page: 9 });
  expect(scroll().scrollTop).toBe(0);
  await follow({ type: "pdf", page: 25 }, false);
  expect(scroll().scrollTop).toBe(0);
  await follow({ type: "pdf", page: 25 }, true);
  expect(scroll().scrollTop).toBe(230);
});
it("reveals a collapsed ancestor without expanding it or writing navigation edits", async () => {
  mocks.load.mockResolvedValue({
    revision: 1,
    entries: { methods: { collapsed: true } },
  });
  const scroll = followGeometry();
  await follow({ type: "pdf", page: 8 });
  expect(scroll().scrollTop).toBe(80);
  expect(
    host
      .querySelector('[aria-label="展开 Methods"]')
      ?.getAttribute("aria-expanded"),
  ).toBe("false");
  expect(mocks.save).not.toHaveBeenCalled();
  expect(go).not.toHaveBeenCalled();
});
it("does not move the viewport while the user selects navigation entries", async () => {
  const scroll = followGeometry();
  await follow({ type: "pdf", page: 1 });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="多选目录"]')!.click(),
  );
  await follow({ type: "pdf", page: 25 });
  expect(scroll().scrollTop).toBe(0);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click(),
  );
  expect(scroll().scrollTop).toBe(230);
  expect(mocks.save).not.toHaveBeenCalled();
});
it("marks at most one EPUB entry current when multiple links share a chapter file", async () => {
  const epub: TOCItem[] = [
    {
      id: "a",
      label: "A",
      location: { type: "epub", href: "chapter.xhtml#a" },
      children: [],
    },
    {
      id: "b",
      label: "B",
      location: { type: "epub", href: "chapter.xhtml#b" },
      children: [],
    },
  ];
  await follow({ type: "epub", href: "chapter.xhtml#body" }, true, epub);
  expect(host.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="location"]')?.textContent).toBe(
    "A",
  );
});
