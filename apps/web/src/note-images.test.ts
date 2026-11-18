// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import {
  acquireNoteImage,
  mapTextOffset,
  noteImageTimestamp,
  pastedNoteImages,
  uploadNoteImages,
} from "./note-images";

const clipboard = (files: File[], text = "") =>
  ({
    files,
    getData: (type: string) => (type === "text/plain" ? text : ""),
  }) as unknown as DataTransfer;
const png = (name = "image.png") =>
  new File(["png"], name, { type: "image/png" });
const asset = (char: string, ext = "png") => `assets/${char.repeat(64)}.${ext}`;

beforeEach(() => {
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:note"),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("names pasted images by local paste time", () => {
  expect(noteImageTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe(
    "2026-01-02_03-04-05",
  );
});

it("treats only text-free image clipboards as image pastes", () => {
  const image = png();
  expect(pastedNoteImages(clipboard([image]))).toEqual([image]);
  // A Finder copy carries the file names as text.
  expect(pastedNoteImages(clipboard([image], "image.png"))).toEqual([image]);
  // Word and web pages attach a rendering beside the real text.
  expect(pastedNoteImages(clipboard([image], "第一段 $x$"))).toEqual([]);
  expect(
    pastedNoteImages(
      clipboard([new File(["x"], "a.tiff", { type: "image/tiff" })]),
    ),
  ).toEqual([]);
  expect(pastedNoteImages(clipboard([], ""))).toEqual([]);
  expect(pastedNoteImages(null)).toEqual([]);
});

it("uploads every pasted image and keeps clipboard order with timestamped alts", async () => {
  const first = png("1.png");
  const second = png("2.png");
  let finish!: (value: { path: string }) => void;
  const pending = new Promise<{ path: string }>(
    (resolve) => (finish = resolve),
  );
  vi.spyOn(api, "uploadNoteImage").mockImplementation((_, file) =>
    file === first ? pending : Promise.resolve({ path: asset("2", "gif") }),
  );
  const markdown = uploadNoteImages(
    "doc",
    [first, second],
    new Date(2026, 10, 18, 21, 7, 9),
  );
  finish({ path: asset("1") });
  await expect(markdown).resolves.toBe(
    `![2026-11-18_21-07-09](${asset("1")})\n![2026-11-18_21-07-09_2](${asset("2", "gif")})`,
  );
});

it("rejects an upload response that is not a managed asset path", async () => {
  vi.spyOn(api, "uploadNoteImage").mockResolvedValue({
    path: "https://example.com/x.png",
  });
  await expect(uploadNoteImages("doc", [png()], new Date())).rejects.toThrow(
    "无效的图片路径",
  );
});

it("maps pending positions through edits before, after and across them", () => {
  expect(mapTextOffset("ab", "xab", 1)).toBe(2);
  expect(mapTextOffset("ab", "abx", 1)).toBe(1);
  // Typing at the pending point stays after the image, like ProseMirror's -1 bias.
  expect(mapTextOffset("ab", "axb", 1)).toBe(1);
  expect(mapTextOffset("ab", "axb", 1, 1)).toBe(2);
  expect(mapTextOffset("abcd", "ad", 2)).toBe(1);
});

it("shares one authenticated object URL per image and revokes it after release", async () => {
  vi.useFakeTimers();
  const load = vi
    .spyOn(api, "noteImage")
    .mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  const path = asset("c");
  const first = acquireNoteImage(path);
  const second = acquireNoteImage(path);
  await expect(first.url).resolves.toBe("blob:note");
  expect(load).toHaveBeenCalledOnce();
  first.release();
  second.release();
  second.release();
  const again = acquireNoteImage(path);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  again.release();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:note");
  expect(load).toHaveBeenCalledOnce();
  expect(() => acquireNoteImage("https://example.com/x.png")).toThrow();
});
