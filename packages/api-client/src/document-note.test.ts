import { afterEach, expect, it, vi } from "vitest";
import { api, configureAPI } from "./index";

afterEach(() => vi.unstubAllGlobals());
const response = () => new Response(JSON.stringify({ body: "saved" }));

it("keeps a small note PUT alive with authentication and the exact JSON body", async () => {
  configureAPI("note-test");
  const fetch = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetch);
  await api.saveDocumentNote("note/id", "中文 $x$\n");
  expect(fetch).toHaveBeenCalledWith(
    "/api/documents/note%2Fid/note",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ body: "中文 $x$\n" }),
      keepalive: true,
      headers: expect.objectContaining({ Authorization: "Bearer note-test" }),
    }),
  );
});
it("uses ordinary requests for oversized UTF-8 bodies rather than exceeding the keepalive budget", async () => {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetch);
  await api.saveDocumentNote("large", "中".repeat(24000));
  expect(fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ keepalive: false }),
  );
});
it("bounds total concurrent keepalive bytes and releases the budget after failure", async () => {
  let reject!: (reason: Error) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((_, no) => {
          reject = no;
        }),
    )
    .mockImplementation(async () => response());
  vi.stubGlobal("fetch", fetch);
  const first = api.saveDocumentNote("one", "a".repeat(40000));
  const failed = expect(first).rejects.toThrow("offline");
  await api.saveDocumentNote("two", "b".repeat(40000));
  expect(fetch.mock.calls[0][1].keepalive).toBe(true);
  expect(fetch.mock.calls[1][1].keepalive).toBe(false);
  reject(new Error("offline"));
  await failed;
  await api.saveDocumentNote("three", "c".repeat(40000));
  expect(fetch.mock.calls[2][1].keepalive).toBe(true);
});
