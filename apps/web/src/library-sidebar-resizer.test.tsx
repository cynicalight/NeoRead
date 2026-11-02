// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme } from "@neoread/core";
import { useReaderStore } from "./store";
import { LibrarySidebarResizer } from "./LibrarySidebarResizer";

vi.mock("@neoread/api", () => ({
  api: { saveSettings: vi.fn(async () => undefined) },
}));
let host: HTMLDivElement, root: Root;
const separator = () =>
  host.querySelector<HTMLButtonElement>('[role="separator"]')!;
const frame = () => separator().parentElement!;
const pointer = (type: string, x: number, button = 0) =>
  separator().dispatchEvent(
    new MouseEvent(type, { bubbles: true, clientX: x, button }),
  );

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useReaderStore.setState({
    theme: { ...defaultTheme, readerLayout: { navigationWidth: 19 } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <div>
        <aside />
        <LibrarySidebarResizer />
      </div>,
    ),
  );
  host.querySelector("aside")!.getBoundingClientRect = () =>
    new DOMRect(
      0,
      0,
      Number.parseFloat(
        frame().style.getPropertyValue("--library-sidebar-width"),
      ) || 238,
      600,
    );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("drags the sidebar boundary without saving intermediate widths, then remembers the final width", async () => {
  await act(async () => pointer("pointerdown", 238));
  await act(async () => pointer("pointermove", 318));
  expect(frame().style.getPropertyValue("--library-sidebar-width")).toBe(
    "318px",
  );
  expect(useReaderStore.getState().theme.librarySidebarWidth).toBeUndefined();
  expect(separator().getAttribute("aria-valuenow")).toBe("318");
  await act(async () => pointer("pointerup", 318));
  expect(useReaderStore.getState().theme.librarySidebarWidth).toBe(318);
  expect(useReaderStore.getState().theme.readerLayout?.navigationWidth).toBe(
    19,
  );
  expect(document.body.hasAttribute("data-resizing")).toBe(false);
  await act(async () =>
    root.render(
      <div>
        <aside />
      </div>,
    ),
  );
  await act(async () =>
    root.render(
      <div>
        <aside />
        <LibrarySidebarResizer />
      </div>,
    ),
  );
  expect(frame().style.getPropertyValue("--library-sidebar-width")).toBe(
    "318px",
  );
});
it("supports keyboard resizing and limits widths without changing other reading settings", async () => {
  const key = async (value: string) =>
    act(async () =>
      separator().dispatchEvent(
        new KeyboardEvent("keydown", { key: value, bubbles: true }),
      ),
    );
  await key("ArrowRight");
  expect(useReaderStore.getState().theme.librarySidebarWidth).toBe(254);
  await key("Home");
  expect(useReaderStore.getState().theme.librarySidebarWidth).toBe(208);
  await key("ArrowLeft");
  expect(useReaderStore.getState().theme.librarySidebarWidth).toBe(208);
  await key("End");
  expect(useReaderStore.getState().theme.librarySidebarWidth).toBe(420);
  await key("ArrowRight");
  expect(useReaderStore.getState().theme.librarySidebarWidth).toBe(420);
});
