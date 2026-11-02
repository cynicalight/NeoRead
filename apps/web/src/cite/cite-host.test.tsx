// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type CiteEvent } from "@neoread/api";
import { CiteHost } from "./CiteHost";
const state = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./session", () => ({
  CiteSession: class {
    run = state.run;
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
let root: Root;
let host: HTMLDivElement;
let onEvent: (event: CiteEvent) => void;
let unsubscribe: ReturnType<typeof vi.fn>;
let complete: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.run.mockReset().mockResolvedValue(undefined);
  vi.spyOn(api, "documents").mockResolvedValue([]);
  vi.spyOn(api, "citeEvents").mockResolvedValue(undefined);
  vi.spyOn(api, "citeComplete").mockResolvedValue(undefined);
  unsubscribe = vi.fn();
  complete = vi.fn().mockResolvedValue(undefined);
  window.neoreadDesktop = {
    onCitationEvent: (callback: typeof onEvent) => {
      onEvent = callback;
      return unsubscribe;
    },
    completeCitation: complete,
  } as unknown as typeof window.neoreadDesktop;
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  delete (window as { neoreadDesktop?: unknown }).neoreadDesktop;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("runs the handed-off command without subscribing to SSE and completes through its owner", async () => {
  await act(async () => root.render(<CiteHost standalone />));
  await act(async () =>
    onEvent({
      type: "command",
      transaction: "one",
      command: "refresh",
      documentId: "doc",
      client: "word-windows",
    }),
  );
  expect(api.citeEvents).not.toHaveBeenCalled();
  expect(api.documents).toHaveBeenCalledOnce();
  expect(state.run).toHaveBeenCalledExactlyOnceWith("refresh");
  expect(complete).toHaveBeenCalledExactlyOnceWith("one", "");
  expect(api.citeComplete).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it("reports a failed session to the main process so the Word transaction can end", async () => {
  state.run.mockRejectedValueOnce(new Error("read-only"));
  await act(async () => root.render(<CiteHost standalone />));
  await act(async () =>
    onEvent({
      type: "command",
      transaction: "two",
      command: "refresh",
      documentId: "doc",
      client: "word-mac",
    }),
  );
  expect(complete).toHaveBeenCalledExactlyOnceWith("two", "read-only");
});
