// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { copyImage, copyText } from "./clipboard";
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("uses the desktop bridge when browser clipboard permission is denied", async () => {
  const writeText = vi
    .fn()
    .mockRejectedValue(new Error("Write permission denied"));
  const writeClipboardText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("window", { neoreadDesktop: { writeClipboardText } });
  expect(await copyText("回答原文")).toBe(true);
  expect(writeClipboardText).toHaveBeenCalledWith("回答原文");
  expect(writeText).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
});
it("uses the browser clipboard outside Electron", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await copyText("https://example.com");
  expect(writeText).toHaveBeenCalledWith("https://example.com");
});
it("reports a clipboard write failure", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  expect(await copyText("回答原文", "已复制")).toBe(false);
  expect(toast.error).toHaveBeenCalledOnce();
  expect(toast.success).not.toHaveBeenCalled();
});
it("confirms successful copies and writes again when the same passage is clicked again", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await copyText("原文", "已复制");
  await copyText("原文", "已复制");
  expect(writeText).toHaveBeenCalledTimes(2);
  expect(toast.success).toHaveBeenLastCalledWith("已复制", {
    id: "neoread-clipboard",
  });
});
it("copies figures through the desktop bridge", async () => {
  const write = vi.fn();
  const writeClipboardImage = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { write } });
  vi.stubGlobal("window", { neoreadDesktop: { writeClipboardImage } });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(new Uint8Array([137, 80]))),
  );
  expect(await copyImage("/pub/t/doc/assets/fig.png", "图 1")).toBe(true);
  expect(writeClipboardImage).toHaveBeenCalledWith(
    new Uint8Array([137, 80]),
    "图 1",
  );
  expect(write).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled();
});
it("reports a failed figure fetch in the desktop app", async () => {
  const writeClipboardImage = vi.fn();
  vi.stubGlobal("window", { neoreadDesktop: { writeClipboardImage } });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
  );
  await copyImage("/pub/t/doc/assets/fig.png", "");
  expect(writeClipboardImage).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith("复制图片失败", {
    id: "neoread-clipboard",
  });
});
