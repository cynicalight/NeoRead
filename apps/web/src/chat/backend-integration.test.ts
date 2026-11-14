import { readFile, appendFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, chat, configureAPI, type ChatStreamEvent } from "@neoread/api";
import { consumeChatStream } from "../../../../packages/api-client/src/chat-stream";
import { ChatSession } from "./chat-session";
// Explicit opt-in: local disposable backend, no credential files, no automatic model calls in pnpm test.
const readyFile = process.env.NEOREAD_INTEGRATION_READY;
const fixtureFile = process.env.NEOREAD_INTEGRATION_FIXTURES;
async function report(value: Record<string, unknown>) {
  const line = JSON.stringify(value);
  console.log(line);
  if (process.env.NEOREAD_INTEGRATION_OUTPUT)
    await appendFile(process.env.NEOREAD_INTEGRATION_OUTPUT, line + "\n");
}
const provider = process.env.NEOREAD_INTEGRATION_PROVIDER || "codex";
beforeAll(async () => {
  if (!readyFile) return;
  const ready = JSON.parse(await readFile(readyFile, "utf8")) as {
    url: string;
    token: string;
  };
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    nativeFetch(
      typeof input === "string" && input.startsWith("/")
        ? new URL(input, ready.url)
        : input,
      init,
    ),
  );
  configureAPI(ready.token);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    setTimeout(callback, 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
afterAll(() => vi.unstubAllGlobals());
it.skipIf(!fixtureFile)(
  "consumes the backend writer's frozen fixtures without changing event semantics",
  async () => {
    const fixtures = JSON.parse(await readFile(fixtureFile!, "utf8")) as {
      name: string;
      wire: string;
      text: string;
      terminal: string | null;
    }[];
    for (const fixture of fixtures) {
      const events: ChatStreamEvent[] = [];
      const bytes = new TextEncoder().encode(fixture.wire);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      });
      const result = consumeChatStream(
        body,
        new AbortController().signal,
        (event) => events.push(event),
      );
      if (fixture.terminal === "done") await result;
      else await expect(result).rejects.toThrow();
      expect(
        events
          .filter((event) => event.event === "delta")
          .map((event) => event.data.text)
          .join(""),
      ).toBe(fixture.text);
    }
  },
);
it.skipIf(!readyFile)(
  "real backend SDK -> session -> saved messages, followed by cancellation reconciliation",
  async () => {
    const bytes = await readFile(
      new URL("../../public/samples/the-art-of-reading.epub", import.meta.url),
    );
    const document = await api.import(
      new File([bytes], `streaming-smoke-${provider}.epub`, {
        type: "application/epub+zip",
      }),
    );
    const started = performance.now();
    let first = 0,
      terminal = 0,
      chunks = 0,
      emitted = "";
    const session = new ChatSession(document.id, {
      messages: api.messages,
      stream: (id, input, signal, emit) =>
        chat(
          id,
          input.provider,
          input.prompt,
          input.context,
          signal,
          () => {},
          input.references,
          [],
          undefined,
          (event) => {
            if (event.event === "delta") {
              if (!first) first = performance.now() - started;
              chunks++;
              emitted += event.data.text;
            }
            if (event.event === "done") terminal = performance.now() - started;
            emit(event);
          },
        ),
    });
    await session.load();
    const previousAssistants = session
      .getSnapshot()
      .messages.filter((message) => message.role === "assistant").length;
    await session.send({
      provider,
      prompt:
        "Use only this original task. Write a short Markdown explanation of HTTP streaming in Chinese, including a heading, a numbered list, a TypeScript code fence and the formula $E=mc^2$. Do not use tools or read files. About 180 words.",
      context: "",
      references: [],
      attachments: [],
    });
    const state = session.getSnapshot();
    expect(state.pending?.phase, state.pending?.notice).toBe("saved");
    expect(state.pending?.content).toBe(emitted);
    expect(chunks).toBeGreaterThan(1);
    expect(first).toBeLessThan(terminal);
    expect(
      state.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(previousAssistants + 1);
    await report({
      integration: "real-http-sdk-session",
      provider,
      input: "original-text",
      chunks,
      bytes: new TextEncoder().encode(emitted).length,
      firstMs: first,
      terminalMs: terminal,
      saved: true,
    });
    session.dispose();
    let cancelAt = 0,
      cancelChunks = 0;
    const cancelled = new ChatSession(document.id, {
      messages: api.messages,
      stream: (id, input, signal, emit) =>
        chat(
          id,
          input.provider,
          input.prompt,
          input.context,
          signal,
          () => {},
          [],
          [],
          undefined,
          (event) => {
            emit(event);
            if (event.event === "delta" && !cancelAt) {
              cancelChunks++;
              cancelAt = performance.now();
              cancelled.cancel();
            }
          },
        ),
    });
    await cancelled.load();
    await cancelled.send({
      provider,
      prompt:
        "Write a detailed 2000-word explanation of streaming HTTP. Do not use tools or read files.",
      context: "",
      references: [],
      attachments: [],
    });
    expect(cancelAt).toBeGreaterThan(0);
    expect(cancelled.getSnapshot().pending?.content.length).toBeGreaterThan(0);
    expect(["cancelled", "saved"]).toContain(
      cancelled.getSnapshot().pending?.phase,
    );
    await report({
      integration: "real-http-sdk-cancel",
      provider,
      cancelChunks,
      returnMs: performance.now() - cancelAt,
      phase: cancelled.getSnapshot().pending?.phase,
      assistantCount: cancelled
        .getSnapshot()
        .messages.filter((message) => message.role === "assistant").length,
    });
    cancelled.dispose();
  },
  180_000,
);

it.skipIf(!readyFile || !process.env.NEOREAD_INTEGRATION_IMAGE)(
  "real image attachment uses the same SDK events and persistence",
  async () => {
    const capability = await api.testAI(provider);
    expect(capability.vision, capability.error).toBe(true);
    const id = process.env.NEOREAD_INTEGRATION_IMAGE!;
    const blocks = await api.blocks(id);
    const block = blocks.find((item) => item.id === "p1-b1")!;
    expect(block).toBeDefined();
    let text = "",
      chunks = 0,
      first = 0,
      done = 0;
    const start = performance.now();
    const session = new ChatSession(id, {
      messages: api.messages,
      stream: (doc, input, signal, emit) =>
        chat(
          doc,
          input.provider,
          input.prompt,
          input.context,
          signal,
          () => {},
          input.references,
          input.attachments.map((image) => image.id),
          undefined,
          (event) => {
            if (event.event === "delta") {
              chunks++;
              text += event.data.text;
              if (!first) first = performance.now() - start;
            }
            if (event.event === "done") done = performance.now() - start;
            emit(event);
          },
        ),
    });
    await session.load();
    const before = session.getSnapshot().messages.length;
    await session.send({
      provider,
      prompt:
        "Describe the colors and left/right layout of this synthetic image in about 80 words. Do not use tools or read files.",
      context: "",
      references: [],
      attachments: [{ id: block.id, page: block.page, label: block.label }],
    });
    const state = session.getSnapshot();
    expect(state.pending?.phase, state.pending?.notice).toBe("saved");
    expect(state.pending?.content).toBe(text);
    expect(chunks).toBeGreaterThan(1);
    expect(first).toBeLessThan(done);
    expect(state.messages.length).toBe(before + 2);
    expect(state.messages.at(-2)?.attachments?.[0].id).toBe("p1-b1");
    await report({
      integration: "real-http-sdk-session",
      provider,
      input: "seeded-synthetic-image",
      chunks,
      bytes: new TextEncoder().encode(text).length,
      firstMs: first,
      terminalMs: done,
      saved: true,
    });
    session.dispose();
  },
  180_000,
);
