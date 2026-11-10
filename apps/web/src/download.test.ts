// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { saveExportBlob } from "./download";
import { Blob as NodeBlob } from "node:buffer";
const blob = () => new NodeBlob(["content"]) as unknown as Blob;
afterEach(() => {
  delete window.neoreadDesktop;
  vi.restoreAllMocks();
});
const install = (saveExportFile: ReturnType<typeof vi.fn>) => {
  window.neoreadDesktop = { saveExportFile } as unknown as NonNullable<
    Window["neoreadDesktop"]
  >;
};
it("waits for the native save to finish and sends the exact bytes", async () => {
  let finish!: (saved: boolean) => void;
  const save = vi.fn(
    (_name: string, _bytes: Uint8Array) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  install(save);
  let settled = false;
  const pending = saveExportBlob(
    blob(),
    "file.md",
    new AbortController().signal,
  ).then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  expect(new TextDecoder().decode(save.mock.calls[0][1])).toBe("content");
  finish(true);
  await pending;
  expect(settled).toBe(true);
});
it("treats a cancelled save dialog as cancellation", async () => {
  install(vi.fn().mockResolvedValue(false));
  await expect(
    saveExportBlob(blob(), "file.md", new AbortController().signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});
it("propagates write failures", async () => {
  install(vi.fn().mockRejectedValue(new Error("保存失败")));
  await expect(
    saveExportBlob(blob(), "file.md", new AbortController().signal),
  ).rejects.toThrow("保存失败");
});
it("does not open a save dialog after cancellation", async () => {
  const save = vi.fn();
  install(save);
  const controller = new AbortController();
  controller.abort();
  await expect(
    saveExportBlob(blob(), "file.md", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(save).not.toHaveBeenCalled();
});
