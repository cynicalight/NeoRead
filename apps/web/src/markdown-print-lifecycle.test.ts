// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { printMarkdownInBrowser } from "./markdown-pdf";
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
it("keeps the frame until print preview closes and then removes it", async () => {
  document.title = "NeoRead";
  const pending = printMarkdownInBrowser(
    "<p>译文</p>",
    new AbortController().signal,
    "Attention Is All You Need-译文",
  );
  const frame = document.querySelector("iframe")!;
  Object.defineProperty(frame.contentDocument, "fonts", {
    value: { ready: Promise.resolve() },
  });
  const print = vi
    .spyOn(frame.contentWindow!, "print")
    .mockImplementation(() => {});
  frame.dispatchEvent(new Event("load"));
  await vi.waitFor(() => expect(print).toHaveBeenCalledOnce());
  expect(frame.isConnected).toBe(true);
  expect(document.title).toBe("Attention Is All You Need-译文");
  frame.contentWindow!.dispatchEvent(new Event("afterprint"));
  await pending;
  expect(document.querySelector("iframe")).toBeNull();
  expect(document.title).toBe("NeoRead");
});
it("cleans up the frame if cancelled while loading", async () => {
  const controller = new AbortController();
  const pending = printMarkdownInBrowser("<p>译文</p>", controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(document.querySelector("iframe")).toBeNull();
});
it("cleans up if the browser rejects printing", async () => {
  const pending = printMarkdownInBrowser(
    "<p>译文</p>",
    new AbortController().signal,
  );
  const rejection = expect(pending).rejects.toThrow("print unavailable");
  const frame = document.querySelector("iframe")!;
  Object.defineProperty(frame.contentDocument, "fonts", {
    value: { ready: Promise.resolve() },
  });
  vi.spyOn(frame.contentWindow!, "print").mockImplementation(() => {
    throw new Error("print unavailable");
  });
  frame.dispatchEvent(new Event("load"));
  await rejection;
  expect(document.querySelector("iframe")).toBeNull();
});
