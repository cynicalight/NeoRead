import { afterEach, expect, it, vi } from "vitest";
import { api, configureAPI } from "./index";

const name = `${"a".repeat(64)}.png`;

afterEach(() => {
  configureAPI("");
  vi.unstubAllGlobals();
});

it("never sends the library token to a Markdown-supplied URL", async () => {
  configureAPI("image-test-token");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const path of [
    `https://example.com/assets/${name}`,
    `assets/../${name}`,
    `assets/${name}?download=1`,
    `assets/${name}.svg`,
  ]) {
    await expect(api.noteImage(path)).rejects.toThrow("不是书库图片");
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("opens a saved relative image with current library authentication", async () => {
  configureAPI("image-test-token");
  const bytes = Uint8Array.of(137, 80, 78, 71);
  const fetch = vi.fn(
    async () =>
      new Response(bytes, { headers: { "Content-Type": "image/png" } }),
  );
  vi.stubGlobal("fetch", fetch);
  const image = await api.noteImage(`assets/${name}`);
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
  expect(fetch).toHaveBeenCalledWith(
    `/api/note-images/${name}`,
    expect.objectContaining({
      headers: { Authorization: "Bearer image-test-token" },
    }),
  );
});
