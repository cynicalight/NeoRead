import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRun, Message } from "@neoread/core";
import type { ChatStreamEvent } from "@neoread/api";
import {
  ChatSession,
  chatRetryAction,
  type ChatInput,
  type ChatTransport,
} from "./chat-session";
const input: ChatInput = {
  provider: "codex",
  prompt: "question",
  context: "",
  references: [],
  attachments: [],
};
const message = (
  id: string,
  role: "user" | "assistant",
  content: string,
): Message => ({
  id,
  role,
  content,
  documentId: "doc",
  context: "",
  createdAt: "2026-10-05",
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(
  messages = vi.fn<ChatTransport["messages"]>().mockResolvedValue([]),
) {
  const wait = deferred<void>();
  let emit!: (event: ChatStreamEvent) => void;
  let signal!: AbortSignal;
  const session = new ChatSession("doc", {
    messages,
    stream: async (_, __, abort, callback) => {
      signal = abort;
      emit = callback;
      await wait.promise;
    },
  });
  return {
    session,
    messages,
    wait,
    emit: (event: ChatStreamEvent) => emit(event),
    signal: () => signal,
  };
}
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    setTimeout(callback, 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
afterEach(() => vi.unstubAllGlobals());
describe("chat request lifecycle", () => {
  it("regenerates a failed question with the current provider and replaces all partial output", async () => {
    let history: Message[] = [];
    const requests: ChatInput[] = [];
    const stream = vi.fn<ChatTransport["stream"]>(
      async (_, request, _signal, emit) => {
        requests.push(request);
        history = [message(request.userMessageId!, "user", request.prompt)];
        if (requests.length === 1) {
          emit({ event: "reasoning", data: { text: "old thinking" } });
          emit({ event: "draft", data: { text: "old draft", reset: false } });
          emit({ event: "error", data: { error: "failed" } });
          return;
        }
        expect(session.getSnapshot().pending).toMatchObject({
          content: "",
          phase: "generating",
        });
        expect(session.getSnapshot().pending?.draft).toBeUndefined();
        expect(session.getSnapshot().pending?.reasoning).toBeUndefined();
        history.push(message("answer", "assistant", "new answer"));
        emit({ event: "delta", data: { text: "new answer" } });
        emit({ event: "done", data: { ok: true } });
      },
    );
    const session = new ChatSession("doc", {
      messages: async () => history,
      stream,
    });
    await session.load();
    const original: ChatInput = {
      ...input,
      context: "original selection",
      readingLocation: { type: "pdf", page: 4 },
      attachments: [
        { id: "p4-b1", page: 4, label: "Figure", caption: "original" },
      ],
    };
    await session.send(original);
    await session.regenerate("api");
    expect(stream).toHaveBeenCalledTimes(2);
    expect(requests[0].userMessageId).toMatch(/^[a-f0-9]{32}$/);
    expect(requests[1]).toEqual({ ...requests[0], provider: "api" });
    expect(session.getSnapshot()).toMatchObject({
      busy: false,
      archived: [],
      pending: { phase: "saved", content: "new answer" },
    });
    expect(session.getSnapshot().messages).toHaveLength(2);
    session.dispose();
  });
  it("keeps thinking separate through tool activity, final text and history synchronization", async () => {
    const h = setup();
    await h.session.load();
    const send = h.session.send(input);
    h.emit({ event: "reasoning", data: { text: "先查看图片。" } });
    h.emit({
      event: "activity",
      data: {
        phase: "reading",
        tool: "read_pdf_pages",
        message: "正在查看第 2 页图像",
      },
    });
    expect(h.session.getSnapshot().pending?.reasoning).toBe("先查看图片。");
    h.emit({ event: "reasoning", data: { text: "\n\n再核对图例。" } });
    h.emit({ event: "delta", data: { text: "答案" } });
    h.emit({ event: "done", data: { ok: true } });
    const saved = {
      ...message("a", "assistant", "答案"),
      reasoning: "先查看图片。\n\n再核对图例。",
    };
    h.messages.mockResolvedValue([
      message(
        h.session.getSnapshot().pending!.input.userMessageId!,
        "user",
        "question",
      ),
      saved,
    ]);
    h.wait.resolve();
    await send;
    expect(h.session.getSnapshot().pending).toMatchObject({
      content: "答案",
      reasoning: saved.reasoning,
      phase: "saved",
    });
    expect(h.session.getSnapshot().messages[1].reasoning).toBe(saved.reasoning);
  });
  it("retains partial thinking after cancellation and ignores late fragments", async () => {
    const h = setup();
    await h.session.load();
    const send = h.session.send(input);
    h.emit({ event: "reasoning", data: { text: "已收到的思考" } });
    h.session.cancel();
    h.emit({ event: "reasoning", data: { text: "迟到内容" } });
    h.wait.resolve();
    await send;
    expect(h.session.getSnapshot().pending).toMatchObject({
      reasoning: "已收到的思考",
      content: "",
      phase: "cancelled",
    });
  });
  it("streams a candidate then commits the answer without duplicate text", async () => {
    const h = setup();
    await h.session.load();
    const send = h.session.send(input);
    h.emit({ event: "draft", data: { text: "准备查找", reset: false } });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(h.session.getSnapshot().pending).toMatchObject({
      content: "",
      draft: "准备查找",
    });
    h.emit({ event: "draft", data: { text: "", reset: true } });
    h.emit({ event: "draft", data: { text: "正式", reset: false } });
    h.emit({ event: "draft", data: { text: "答案", reset: false } });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(h.session.getSnapshot().pending?.draft).toBe("正式答案");
    h.emit({ event: "delta", data: { text: "正式答案" } });
    h.emit({ event: "done", data: { ok: true } });
    h.messages.mockResolvedValue([
      message(
        h.session.getSnapshot().pending!.input.userMessageId!,
        "user",
        "question",
      ),
      message("a", "assistant", "正式答案"),
    ]);
    h.wait.resolve();
    await send;
    expect(h.session.getSnapshot().pending).toMatchObject({
      content: "正式答案",
      draft: "",
      phase: "saved",
    });
  });

  it("keeps tool activity outside the answer and clears it when final text arrives", async () => {
    const h = setup();
    await h.session.load();
    const send = h.session.send(input);
    h.emit({
      event: "activity",
      data: {
        phase: "reading",
        tool: "read_passage",
        message: "正在查看第 12 页 · 阅读原文与相邻段落",
      },
    });
    expect(h.session.getSnapshot().pending).toMatchObject({
      content: "",
      activity: { tool: "read_passage" },
      notice: expect.stringContaining("第 12 页"),
    });
    h.emit({ event: "delta", data: { text: "最终答案" } });
    h.emit({ event: "done", data: { ok: true } });
    h.wait.resolve();
    await send;
    expect(h.session.getSnapshot().pending?.content).toBe("最终答案");
    expect(h.session.getSnapshot().pending?.activity).toBeUndefined();
  });
  it("retains raw text when done is followed by messages failure; retry replaces, never appends", async () => {
    const h = setup();
    await h.session.load();
    h.messages.mockRejectedValueOnce(new Error("offline"));
    const send = h.session.send(input);
    const beforeDelta = h.session.getSnapshot();
    h.emit({ event: "delta", data: { text: "**answer" } });
    expect(beforeDelta.pending?.content).toBe("");
    h.emit({ event: "done", data: { ok: true } });
    h.emit({ event: "delta", data: { text: "late" } });
    h.wait.resolve();
    await send;
    expect(h.session.getSnapshot().pending).toMatchObject({
      content: "**answer",
      phase: "syncing",
      notice: expect.stringContaining("已保存"),
    });
    h.messages.mockResolvedValue([
      message(
        h.session.getSnapshot().pending!.input.userMessageId!,
        "user",
        "question",
      ),
      message("a", "assistant", "**answer**"),
    ]);
    await h.session.retrySync();
    expect(h.session.getSnapshot().pending).toMatchObject({
      content: "**answer**",
      phase: "saved",
      savedId: "a",
    });
  });
  it("provider error preserves partial and rejects late terminal/delta", async () => {
    const h = setup();
    await h.session.load();
    const send = h.session.send(input);
    h.emit({ event: "delta", data: { text: "partial" } });
    h.emit({ event: "error", data: { error: "failed" } });
    h.emit({ event: "done", data: { ok: true } });
    h.wait.reject(new Error("failed"));
    await send;
    expect(h.session.getSnapshot().pending).toMatchObject({
      content: "partial",
      phase: "incomplete",
    });
  });
  it("cancel aborts immediately, preserves tail, and reconciles save race", async () => {
    const h = setup();
    await h.session.load();
    const send = h.session.send(input);
    h.emit({ event: "delta", data: { text: "tail" } });
    h.session.cancel();
    expect(h.signal().aborted).toBe(true);
    expect(h.session.getSnapshot().pending?.phase).toBe("cancelled");
    h.emit({ event: "delta", data: { text: "late" } });
    h.messages.mockResolvedValue([
      message(
        h.session.getSnapshot().pending!.input.userMessageId!,
        "user",
        "question",
      ),
      message("a", "assistant", "tail"),
    ]);
    h.wait.reject(new Error("aborted"));
    await send;
    expect(h.session.getSnapshot().pending).toMatchObject({
      content: "tail",
      savedId: "a",
    });
  });
  it("unmount blocks callbacks, finally and stale message queries", async () => {
    const h = setup();
    await h.session.load();
    const query = deferred<Message[]>();
    h.messages.mockReturnValueOnce(query.promise);
    const send = h.session.send(input);
    h.emit({ event: "done", data: { ok: true } });
    h.wait.resolve();
    await Promise.resolve();
    await Promise.resolve();
    h.session.dispose();
    const previous = h.session.getSnapshot();
    h.emit({ event: "delta", data: { text: "late" } });
    query.resolve([message("a", "assistant", "old")]);
    await send;
    expect(h.session.getSnapshot()).toBe(previous);
  });
  it("does not identify an old equal-content answer as this request", async () => {
    const h = setup(
      vi
        .fn<ChatTransport["messages"]>()
        .mockResolvedValue([message("old", "assistant", "answer")]),
    );
    await h.session.load();
    const send = h.session.send(input);
    h.emit({ event: "delta", data: { text: "answer" } });
    h.emit({ event: "done", data: { ok: true } });
    h.wait.resolve();
    await send;
    expect(h.session.getSnapshot().pending?.savedId).toBeUndefined();
    expect(h.session.getSnapshot().pending?.phase).toBe("syncing");
  });
  it("ambiguous concurrent records stay pending, and EOF never implies saved", async () => {
    const h = setup();
    await h.session.load();
    const send = h.session.send(input);
    h.emit({ event: "delta", data: { text: "answer" } });
    h.messages.mockResolvedValue([
      message(
        h.session.getSnapshot().pending!.input.userMessageId!,
        "user",
        "question",
      ),
      message("a", "assistant", "answer"),
      message("b", "assistant", "answer"),
    ]);
    h.wait.resolve();
    await send;
    expect(h.session.getSnapshot().pending).toMatchObject({
      phase: "unconfirmed",
      content: "answer",
    });
  });
  it("serializes requests synchronously and preserves unsaved partial on next request", async () => {
    const h = setup();
    await h.session.load();
    const first = h.session.send(input);
    await h.session.send(input);
    h.emit({ event: "delta", data: { text: "partial" } });
    h.wait.resolve();
    await first;
    await h.session.send(input);
    expect(h.session.getSnapshot().archived[0].content).toBe("partial");
  });
});

describe("independent session lifecycle", () => {
  it("keeps the original stream running while another session loads and cancels", async () => {
    const a = setup(),
      b = setup();
    await a.session.load();
    await b.session.load();
    const first = a.session.send({ ...input, prompt: "alpha" });
    const second = b.session.send({ ...input, prompt: "beta" });
    // No dispose occurs when a view changes its subscription.
    const unsubscribe = a.session.subscribe(() => {});
    unsubscribe();
    b.session.cancel();
    expect(a.session.getSnapshot().busy).toBe(true);
    expect(a.session.getSnapshot().pending?.controller.signal.aborted).toBe(
      false,
    );
    a.wait.resolve();
    b.wait.resolve();
    await Promise.all([first, second]);
  });
  it("reattaches a running thread after reload without posting the question", async () => {
    const wait = deferred<void>();
    const run = {
      id: "run",
      sessionId: "a",
      documentId: "doc",
      userMessageId: "q",
      provider: "api",
      status: "running" as const,
      startedAt: "now",
    };
    const stream = vi.fn<ChatTransport["stream"]>();
    const resume = vi
      .fn<NonNullable<ChatTransport["resume"]>>()
      .mockImplementation(async (_run, _signal, emit) => {
        emit({ event: "draft", data: { text: "restored", reset: false } });
        await wait.promise;
        emit({ event: "done", data: { ok: true } });
      });
    const io: ChatTransport = {
      messages: vi
        .fn()
        .mockResolvedValue([
          { ...message("q", "user", "old question"), sessionId: "a" },
        ]),
      latestRun: vi.fn().mockResolvedValue(run),
      stream,
      resume,
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const session = new ChatSession("doc", io, "a");
    await session.load();
    expect(stream).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
    expect(session.getSnapshot().busy).toBe(true);
    await vi.waitFor(() =>
      expect(session.getSnapshot().pending?.draft).toBe("restored"),
    );
    session.cancel();
    expect(io.cancel).toHaveBeenCalledOnce();
    expect(session.getSnapshot().pending?.controller.signal.aborted).toBe(true);
    wait.resolve();
    await vi.waitFor(() => expect(session.getSnapshot().busy).toBe(false));
  });
});

it("releases the busy flag when checking an existing run fails before regeneration", async () => {
  const stream = vi.fn<ChatTransport["stream"]>();
  const session = new ChatSession("doc", {
    messages: async () => [message("q", "user", "question")],
    stream,
    latestRun: vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline")),
  });
  await session.load();
  await expect(session.regenerate("api")).rejects.toThrow("offline");
  expect(session.getSnapshot().busy).toBe(false);
  expect(stream).not.toHaveBeenCalled();
  session.dispose();
});

it("keeps keyed tool steps when answer deltas arrive and persists the web permission for retry", async () => {
  const h = setup();
  await h.session.load();
  const sending = h.session.send({ ...input, webSearch: true });
  const tool = {
    id: "search",
    kind: "search" as const,
    tool: "web_search",
    title: "搜索网页",
    target: "official docs",
    status: "running" as const,
    startedAt: "2026-10-23T00:00:00Z",
  };
  h.emit({ event: "tool", data: tool });
  h.emit({ event: "tool", data: { ...tool, status: "completed" } });
  h.emit({ event: "delta", data: { text: "Answer" } });
  expect(h.session.getSnapshot().pending?.tools).toEqual([
    { ...tool, status: "completed" },
  ]);
  expect(h.session.getSnapshot().pending?.input.webSearch).toBe(true);
  h.wait.resolve();
  await sending;
});

it("uses persisted completed tool states when history confirms a reply after a stream disconnect", async () => {
  const h = setup();
  await h.session.load();
  const sending = h.session.send(input);
  const tool = {
    id: "read",
    kind: "web" as const,
    tool: "web_fetch",
    title: "读取网页",
    status: "running" as const,
    startedAt: "2026-10-23T00:00:00Z",
  };
  h.emit({ event: "tool", data: tool });
  const question = h.session.getSnapshot().pending!.input;
  const saved = {
    ...message("answer", "assistant", "Saved answer"),
    tools: [{ ...tool, status: "completed" as const }],
  };
  h.messages.mockResolvedValue([
    message(question.userMessageId!, "user", question.prompt),
    saved,
  ]);
  h.wait.resolve();
  await sending;
  expect(h.session.getSnapshot().pending?.phase).toBe("saved");
  expect(h.session.getSnapshot().pending?.tools).toEqual(saved.tools);
});

it("continues a checkpoint with the same question and completed tools without regenerating", async () => {
  let history: Message[] = [];
  let run: ChatRun | undefined;
  const completed = {
    id: "known-tool",
    kind: "web" as const,
    tool: "web_fetch",
    title: "读取",
    status: "completed" as const,
    startedAt: "now",
  };
  const stream = vi.fn<ChatTransport["stream"]>(
    async (_id, input, _signal, emit) => {
      history = [message(input.userMessageId!, "user", input.prompt)];
      run = {
        id: "run",
        documentId: "doc",
        sessionId: "session",
        userMessageId: input.userMessageId!,
        provider: "api",
        status: "failed",
        resumable: true,
        startedAt: "now",
      };
      emit({ event: "tool", data: completed });
      emit({ event: "delta", data: { text: "incomplete fragment" } });
      emit({ event: "error", data: { error: "upstream 502" } });
    },
  );
  const continueRun = vi.fn<NonNullable<ChatTransport["continueRun"]>>(
    async (active, _signal, emit) => {
      expect(active.id).toBe("run");
      expect(active.userMessageId).toBe(history[0].id);
      expect(session.getSnapshot().pending).toMatchObject({
        content: "",
        tools: [completed],
      });
      history.push(message("answer", "assistant", "continued answer"));
      run = { ...active, status: "completed", resumable: false };
      emit({ event: "tool", data: completed });
      emit({ event: "delta", data: { text: "continued answer" } });
      emit({ event: "done", data: { ok: true } });
    },
  );
  const session = new ChatSession("doc", {
    messages: async () => history,
    latestRun: async () => run,
    stream,
    continueRun,
  });
  await session.load();
  await session.send(input);
  expect(chatRetryAction(session.getSnapshot())).toBe("continue");
  expect(session.getSnapshot().pending?.notice).not.toContain("502");
  await session.continueRun();
  expect(stream).toHaveBeenCalledOnce();
  expect(continueRun).toHaveBeenCalledOnce();
  expect(history.filter((m) => m.role === "user")).toHaveLength(1);
  expect(session.getSnapshot().pending).toMatchObject({
    phase: "saved",
    content: "continued answer",
  });
  session.dispose();
});

it("manual reconnect attaches an existing running run without a new generation", async () => {
  let run: ChatRun | undefined;
  let history: Message[] = [];
  const stream = vi.fn<ChatTransport["stream"]>(async (_id, input) => {
    history = [message(input.userMessageId!, "user", input.prompt)];
    run = {
      id: "run",
      documentId: "doc",
      sessionId: "session",
      userMessageId: input.userMessageId!,
      provider: "api",
      status: "running",
      startedAt: "now",
    };
    throw new Error("offline");
  });
  const resume = vi.fn<NonNullable<ChatTransport["resume"]>>(
    async (active, _signal, emit) => {
      history.push(message("answer", "assistant", "same run"));
      run = { ...active, status: "completed" };
      emit({ event: "done", data: { ok: true } });
    },
  );
  const session = new ChatSession("doc", {
    messages: async () => history,
    latestRun: async () => run,
    stream,
    resume,
  });
  await session.load();
  await session.send(input);
  expect(chatRetryAction(session.getSnapshot())).toBe("reconnect");
  await session.reconnect();
  expect(stream).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenCalledOnce();
  expect(session.getSnapshot().pending?.content).toBe("same run");
  session.dispose();
});

it("does not offer regeneration while checkpoint status cannot be confirmed", async () => {
  let history: Message[] = [];
  const stream = vi.fn<ChatTransport["stream"]>(
    async (_id, input, _signal, emit) => {
      history = [message(input.userMessageId!, "user", input.prompt)];
      emit({ event: "error", data: { error: "502" } });
    },
  );
  const latestRun = vi
    .fn<NonNullable<ChatTransport["latestRun"]>>()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(new Error("offline"));
  const session = new ChatSession("doc", {
    messages: async () => history,
    latestRun,
    stream,
  });
  await session.load();
  await session.send(input);
  expect(chatRetryAction(session.getSnapshot())).toBe("sync");
  expect(session.getSnapshot().pending?.notice).not.toContain("重新生成");
  session.dispose();
});

it("keeps a definitive continuation rejection even when the old checkpoint remains resumable", async () => {
  const { RequestError } = await import("@neoread/api");
  let history: Message[] = [];
  let run: ChatRun | undefined;
  const stream = vi.fn<ChatTransport["stream"]>(
    async (_id, input, _signal, emit) => {
      history = [message(input.userMessageId!, "user", input.prompt)];
      run = {
        id: "rejected-run",
        documentId: "doc",
        sessionId: "session",
        userMessageId: input.userMessageId!,
        provider: "api",
        status: "failed",
        resumable: true,
        startedAt: "now",
      };
      emit({ event: "error", data: { error: "502" } });
    },
  );
  const continueRun = vi
    .fn<NonNullable<ChatTransport["continueRun"]>>()
    .mockRejectedValue(
      new RequestError(
        "API 配置或模型已改变，请重新生成。",
        undefined,
        undefined,
        409,
      ),
    );
  const session = new ChatSession("doc", {
    messages: async () => history,
    latestRun: async () => run,
    stream,
    continueRun,
  });
  await session.load();
  await session.send(input);
  expect(chatRetryAction(session.getSnapshot())).toBe("continue");
  await session.continueRun();
  expect(chatRetryAction(session.getSnapshot())).toBe("regenerate");
  expect(session.getSnapshot().pending?.notice).toContain(
    "API 配置或模型已改变",
  );
  expect(session.getSnapshot().pending?.notice).not.toContain(
    "可从已保存的进度继续",
  );
  await session.retrySync();
  await session.continueRun();
  expect(chatRetryAction(session.getSnapshot())).toBe("regenerate");
  expect(continueRun).toHaveBeenCalledOnce();
  run = { ...run!, id: "new-eligible-run" };
  await session.retrySync();
  expect(chatRetryAction(session.getSnapshot())).toBe("continue");
  session.dispose();
});

it("keeps continuation available after an ambiguous network failure", async () => {
  let history: Message[] = [];
  let run: ChatRun | undefined;
  const stream: ChatTransport["stream"] = async (_id, input, _signal, emit) => {
    history = [message(input.userMessageId!, "user", input.prompt)];
    run = {
      id: "network-run",
      documentId: "doc",
      sessionId: "session",
      userMessageId: input.userMessageId!,
      provider: "api",
      status: "failed",
      resumable: true,
      startedAt: "now",
    };
    emit({ event: "error", data: { error: "502" } });
  };
  const continueRun = vi
    .fn<NonNullable<ChatTransport["continueRun"]>>()
    .mockRejectedValue(new TypeError("network unavailable"));
  const session = new ChatSession("doc", {
    messages: async () => history,
    latestRun: async () => run,
    stream,
    continueRun,
  });
  await session.load();
  await session.send(input);
  await session.continueRun();
  expect(chatRetryAction(session.getSnapshot())).toBe("continue");
  session.dispose();
});
