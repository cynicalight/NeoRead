// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme } from "@reader/core";
import { useReaderStore } from "./store";
import { documentZoom, useDocumentTheme } from "./useDocumentTheme";
vi.mock("@reader/api", () => ({ api: {} }));
const controls = new Map<string, ReturnType<typeof useDocumentTheme>>();
let root: Root, host: HTMLDivElement;
function Reader({ id, active }: { id: string; active: boolean }) {
  const theme = useReaderStore((state) => state.theme);
  const value = useDocumentTheme(theme, { id, type: "pdf" }, active);
  controls.set(id, value);
  return <span>{String(value.theme.zoom)}</span>;
}
const render = (active = "a") =>
  root.render(
    <>
      <Reader id="a" active={active === "a"} />
      <Reader id="b" active={active === "b"} />
    </>,
  );
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useReaderStore.setState({ theme: defaultTheme });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => render());
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  controls.clear();
  vi.unstubAllGlobals();
});
it("restores each PDF's manual zoom independently after switching and serializing settings", async () => {
  await act(async () => controls.get("a")!.onZoom(1.4));
  await act(async () => render("b"));
  await act(async () => controls.get("b")!.onZoom(2));
  await act(async () => render("a"));
  expect(controls.get("a")!.theme.zoom).toBe(1.4);
  expect(controls.get("b")!.theme.zoom).toBe(2);
  const saved = JSON.parse(JSON.stringify(useReaderStore.getState().theme));
  expect(documentZoom(saved, "a")).toBe(1.4);
  expect(documentZoom(saved, "b")).toBe(2);
  expect(documentZoom(saved, "new")).toBe(2);
  await act(async () => controls.get("a")!.setTheme({ zoom: "width" }));
  expect(useReaderStore.getState().theme.documentZooms).toEqual({
    a: "width",
    b: 2,
  });
});
it("keeps automatic passage focus temporary, including across appearance changes", async () => {
  await act(async () => controls.get("a")!.onZoom(1.3));
  await act(async () => controls.get("a")!.onZoom(1.9, "focus"));
  expect(controls.get("a")!.theme.zoom).toBe(1.9);
  expect(useReaderStore.getState().theme.documentZooms?.a).toBe(1.3);
  await act(async () => controls.get("a")!.setTheme({ mode: "dark" }));
  expect(controls.get("a")!.theme.zoom).toBe(1.9);
  await act(async () => render("b"));
  await act(async () => render("a"));
  expect(controls.get("a")!.theme.zoom).toBe(1.3);
});
it("ignores malformed document zooms and keeps old libraries' global preference", () => {
  expect(documentZoom({ ...defaultTheme, zoom: 1.2 }, "a")).toBe(1.2);
  for (const value of [NaN, 0, 9])
    expect(
      documentZoom({ ...defaultTheme, documentZooms: { a: value } }, "a"),
    ).toBe("width");
});

it("keeps an untouched tab's fit-width preference when another document changes zoom", async () => {
  await act(async () => render("b"));
  await act(async () => controls.get("b")!.onZoom(2));
  await act(async () => render("a"));
  expect(controls.get("a")!.theme.zoom).toBe("width");
});
it("adapts the saved manual zoom behind temporary focus without persisting the focus itself", async () => {
  await act(async () => controls.get("a")!.onZoom(1.2));
  await act(async () => controls.get("a")!.onZoom(2, "focus"));
  await act(async () => controls.get("a")!.onZoom(1, "layout", 0.5));
  expect(controls.get("a")!.theme.zoom).toBe(1);
  expect(useReaderStore.getState().theme.documentZooms?.a).toBeCloseTo(1.2);
  await act(async () => render("b"));
  await act(async () => render("a"));
  expect(controls.get("a")!.theme.zoom).toBeCloseTo(0.6);
});

it("does not save automatic layout changes as the default zoom for other PDFs", async () => {
  await act(async () => controls.get("a")!.onZoom(1.6));
  await act(async () => controls.get("a")!.onZoom(0.8, "layout", 0.5));
  expect(controls.get("a")!.theme.zoom).toBe(0.8);
  expect(useReaderStore.getState().theme.documentZooms?.a).toBe(1.6);
  expect(useReaderStore.getState().theme.zoom).toBe(1.6);
  await act(async () => render("b"));
  expect(controls.get("b")!.theme.zoom).toBe(1.6);
});
