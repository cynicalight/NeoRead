import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@reader/core";
import type { ChatStreamEvent } from "@reader/api";
import {
  ChatSession,
  chatRetryAction,
  type ChatInput,
  type ChatTransport,
} from "./chat-session";

const input: ChatInput = {
  provider: "codex",
  prompt: "question",
  context: "source",
  references: [],
  attachments: [],
};
const user = (id: string): Message => ({
  id,
  documentId: "doc",
  role: "user",
  content: "question",
  context: "source",
  createdAt: "2026-10-15",
});
const answer: Message = {
  id: "answer",
  documentId: "doc",
  role: "assistant",
  content: "saved answer",
  createdAt: "2026-10-15",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(mode: "error" | "cancel" | "eof" | "done" = "error") {
  let history: Message[] = [];
  const requests: ChatInput[] = [];
  const callbacks: ((event: ChatStreamEvent) => void)[] = [];
  const messages = vi.fn<ChatTransport["messages"]>(async () => [...history]);
  const stream = vi.fn<ChatTransport["stream"]>(
    async (_, request, _signal, emit) => {
      requests.push(request);
      if (!history.length) history.push(user(request.userMessageId!));
      emit({ event: "delta", data: { text: "partial" } });
      callbacks.push(emit);
      if (mode === "error")
        emit({ event: "error", data: { error: "upstream failed" } });
      if (mode === "cancel") session.cancel();
      if (mode === "done") {
        history.push(answer);
        emit({ event: "done", data: { ok: true } });
      }
    },
  );
  const session = new ChatSession("doc", { messages, stream });
  return {
    session,
    messages,
    stream,
    requests,
    callbacks,
    save: () => history.push(answer),
  };
}
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
afterEach(() => vi.unstubAllGlobals());

it.each(["error", "cancel", "eof"] as const)(
  "offers regeneration after %s, while sync never resends",
  async (mode) => {
    const h = setup(mode);
    await h.session.load();
    await h.session.send(input);
    expect(chatRetryAction(h.session.getSnapshot())).toBe("regenerate");
    await h.session.retrySync();
    expect(h.stream).toHaveBeenCalledTimes(1);
    await h.session.regenerate("api");
    expect(h.stream).toHaveBeenCalledTimes(2);
    expect(h.requests[1]).toEqual({ ...h.requests[0], provider: "api" });
    expect(h.session.getSnapshot().archived).toEqual([]);
    h.session.dispose();
  },
);

it.each(["error", "cancel", "eof"] as const)(
  "keeps regeneration after %s when either history check fails, without replaying offline",
  async (mode) => {
    const h = setup(mode);
    await h.session.load();
    h.messages.mockRejectedValueOnce(new Error("offline after generation"));
    await h.session.send(input);
    expect(chatRetryAction(h.session.getSnapshot())).toBe("regenerate");
    h.messages.mockRejectedValueOnce(new Error("offline before regeneration"));
    await h.session.regenerate("api");
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(h.session.getSnapshot()).toMatchObject({
      busy: false,
      pending: {
        content: "partial",
        notice: "暂时无法读取对话记录，请稍后重试。",
      },
    });
    expect(chatRetryAction(h.session.getSnapshot())).toBe("regenerate");
    await h.session.regenerate("api");
    expect(h.stream).toHaveBeenCalledTimes(2);
    expect(h.requests[1]).toEqual({ ...h.requests[0], provider: "api" });
    h.session.dispose();
  },
);

it.each(["cancel", "eof"] as const)(
  "reconciles a late successful save after %s instead of regenerating",
  async (mode) => {
    const h = setup(mode);
    await h.session.load();
    await h.session.send(input);
    h.save();
    await h.session.regenerate("api");
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(h.session.getSnapshot().pending).toMatchObject({
      phase: "saved",
      content: "saved answer",
    });
    expect(chatRetryAction(h.session.getSnapshot())).toBeUndefined();
    h.session.dispose();
  },
);

it("only synchronizes after done even when the message query fails", async () => {
  const h = setup("done");
  await h.session.load();
  h.messages.mockRejectedValueOnce(new Error("offline"));
  await h.session.send(input);
  expect(chatRetryAction(h.session.getSnapshot())).toBe("sync");
  await h.session.regenerate("api");
  expect(h.stream).toHaveBeenCalledTimes(1);
  await h.session.retrySync();
  expect(h.session.getSnapshot().pending?.phase).toBe("saved");
  h.session.dispose();
});

it("retries a history load failure without generating", async () => {
  const h = setup();
  h.messages.mockRejectedValueOnce(new Error("offline"));
  await h.session.load();
  expect(chatRetryAction(h.session.getSnapshot())).toBe("reload");
  await h.session.retrySync();
  expect(h.session.getSnapshot().loaded).toBe(true);
  expect(h.stream).not.toHaveBeenCalled();
  h.session.dispose();
});

it("serializes double clicks through preflight and ignores old attempt callbacks", async () => {
  const h = setup("eof");
  await h.session.load();
  await h.session.send(input);
  const late = h.callbacks[0];
  const query = deferred<Message[]>();
  h.messages.mockReturnValueOnce(query.promise);
  const first = h.session.regenerate("api");
  await h.session.regenerate("kimi");
  await h.session.send({ ...input, prompt: "another question" });
  expect(h.stream).toHaveBeenCalledTimes(1);
  query.resolve([user(h.requests[0].userMessageId!)]);
  await first;
  expect(h.stream).toHaveBeenCalledTimes(2);
  expect(h.requests[1].provider).toBe("api");
  // The second attempt has no terminal event; a late event must not save it.
  late({ event: "delta", data: { text: "late old answer" } });
  late({ event: "done", data: { ok: true } });
  expect(h.session.getSnapshot().pending?.phase).toBe("unconfirmed");
  expect(h.session.getSnapshot().pending?.content).toBe("partial");
  h.session.dispose();
});

it("preserves the failed output when another question has since been sent", async () => {
  const h = setup();
  await h.session.load();
  await h.session.send(input);
  h.messages.mockResolvedValue([
    user(h.requests[0].userMessageId!),
    { ...user("another"), content: "another question" },
  ]);
  await h.session.regenerate("api");
  expect(h.stream).toHaveBeenCalledTimes(1);
  expect(h.session.getSnapshot().pending?.content).toBe("partial");
  expect(chatRetryAction(h.session.getSnapshot())).toBeUndefined();
  h.session.dispose();
});

it("does not send after disposal while checking saved state", async () => {
  const h = setup();
  await h.session.load();
  await h.session.send(input);
  const query = deferred<Message[]>();
  h.messages.mockReturnValueOnce(query.promise);
  const retry = h.session.regenerate("api");
  h.session.dispose();
  const snapshot = h.session.getSnapshot();
  query.resolve([]);
  await retry;
  expect(h.stream).toHaveBeenCalledTimes(1);
  expect(h.session.getSnapshot()).toBe(snapshot);
});

it("stops regeneration during the history check without losing the previous output", async () => {
  const h = setup();
  await h.session.load();
  await h.session.send(input);
  const query = deferred<Message[]>();
  h.messages.mockReturnValueOnce(query.promise);
  const retry = h.session.regenerate("api");
  h.session.cancel();
  query.resolve([user(h.requests[0].userMessageId!)]);
  await retry;
  expect(h.stream).toHaveBeenCalledTimes(1);
  expect(h.session.getSnapshot()).toMatchObject({
    busy: false,
    pending: { content: "partial" },
  });
  h.session.dispose();
});

it("keeps the previous output when a retry is rejected before the stream starts", async () => {
  const h = setup();
  await h.session.load();
  await h.session.send(input);
  h.stream.mockRejectedValueOnce(new Error("model configuration invalid"));
  await h.session.regenerate("api");
  expect(h.session.getSnapshot().pending).toMatchObject({
    content: "partial",
    phase: "unconfirmed",
  });
  expect(h.session.getSnapshot().archived).toEqual([]);
  expect(h.session.getSnapshot().pending?.notice).toContain(
    "model configuration invalid",
  );
  h.session.dispose();
});

it("restores the unanswered tail after reopening without duplicating its row", async () => {
  const savedUser = {
    ...user("11111111111111111111111111111111"),
    readingLocation: { type: "pdf" as const, page: 7 },
  };
  const history: Message[] = [savedUser];
  const stream = vi.fn<ChatTransport["stream"]>(
    async (_, request, _signal, emit) => {
      expect(request).toMatchObject({
        userMessageId: savedUser.id,
        prompt: "question",
        context: "source",
        readingLocation: savedUser.readingLocation,
        provider: "api",
      });
      history.push(answer);
      emit({ event: "done", data: { ok: true } });
    },
  );
  const session = new ChatSession("doc", {
    messages: async () => [...history],
    stream,
  });
  await session.load();
  expect(chatRetryAction(session.getSnapshot())).toBe("regenerate");
  expect(session.getSnapshot().messageKeys[savedUser.id]).toBe(
    `${session.getSnapshot().pending?.key}-user`,
  );
  await session.regenerate("api");
  expect(session.getSnapshot().messages).toHaveLength(2);
  expect(session.getSnapshot().pending?.phase).toBe("saved");
  session.dispose();
});
