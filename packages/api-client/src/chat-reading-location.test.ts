import { afterEach, expect, it, vi } from "vitest";
import { chat, configureAPI } from "./index";

afterEach(() => vi.unstubAllGlobals());

it("sends a navigation snapshot separately from original text and citations", async () => {
  configureAPI("test-token");
  let body: unknown;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/chat")) {
        body = JSON.parse(String(init.body));
        return new Response(
          'event: delta\ndata: {"text":"answer"}\n\nevent: done\ndata: {"ok":true}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response("{}", { status: 200 });
    }),
  );
  await chat(
    "doc",
    "codex",
    "这页讲什么",
    "",
    new AbortController().signal,
    () => {},
    [],
    [],
    undefined,
    undefined,
    { type: "pdf", page: 13 },
    "11111111111111111111111111111111",
  );
  expect(body).toMatchObject({
    context: "",
    references: [],
    readingLocation: { type: "pdf", page: 13 },
    userMessageId: "11111111111111111111111111111111",
  });
});
