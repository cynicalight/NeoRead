import { afterEach, expect, it, vi } from "vitest";
import type { ChatRun, Message } from "@neoread/core";
import { api, watchChatRun } from "@neoread/api";
import { getChatSession } from "./session-registry";
vi.mock("../store", () => ({
  refreshAIConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@neoread/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@neoread/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      startChatRun: vi.fn(),
      continueChatRun: vi.fn(),
      chatSessions: vi.fn(),
      sessionMessages: vi.fn(),
      cancelChatRun: vi.fn(),
    },
    watchChatRun: vi.fn(),
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("reconnects one run automatically, then continues its checkpoint through the resume endpoint", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    setTimeout(callback, 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  let run: ChatRun | undefined;
  let history: Message[] = [];
  vi.mocked(api.sessionMessages).mockImplementation(async () => history);
  vi.mocked(api.chatSessions).mockImplementation(async () =>
    run
      ? [
          {
            id: "session",
            documentId: "registry-doc",
            title: "",
            provider: "api",
            createdAt: "",
            updatedAt: "",
            latestRun: run,
          },
        ]
      : [],
  );
  vi.mocked(api.startChatRun).mockImplementation(
    async (_doc, _session, input) => {
      run = {
        id: "run",
        documentId: "registry-doc",
        sessionId: "session",
        userMessageId: input.userMessageId!,
        provider: "api",
        status: "running",
        startedAt: "now",
      };
      history = [
        {
          id: run.userMessageId,
          documentId: "registry-doc",
          sessionId: "session",
          role: "user",
          content: input.prompt,
          createdAt: "",
        },
      ];
      return run;
    },
  );
  vi.mocked(watchChatRun)
    .mockImplementationOnce(async (_doc, _session, _run, _signal, emit) => {
      emit({ event: "delta", data: { text: "partial" } });
      throw new Error("disconnected");
    })
    .mockImplementationOnce(async (_doc, _session, _run, _signal, emit) => {
      emit({ event: "delta", data: { text: "partial" } });
      run = { ...run!, status: "failed", resumable: true };
      emit({ event: "error", data: { error: "502" } });
      throw new Error("502");
    })
    .mockImplementationOnce(async (_doc, _session, _run, _signal, emit) => {
      emit({ event: "delta", data: { text: "continued" } });
      history.push({
        id: "answer",
        documentId: "registry-doc",
        sessionId: "session",
        role: "assistant",
        content: "continued",
        createdAt: "",
      });
      run = { ...run!, status: "completed", resumable: false };
      emit({ event: "done", data: { ok: true } });
    });
  vi.mocked(api.continueChatRun).mockImplementation(async () => {
    run = { ...run!, status: "running", resumable: false };
    return run;
  });
  const session = getChatSession("registry-doc", "session");
  await session.load();
  const sending = session.send({
    provider: "api",
    prompt: "question",
    context: "",
    references: [],
    attachments: [],
  });
  await vi.advanceTimersByTimeAsync(1000);
  await sending;
  expect(api.startChatRun).toHaveBeenCalledOnce();
  expect(watchChatRun).toHaveBeenCalledTimes(2);
  expect(session.getSnapshot().pending?.content).toBe("partial");
  expect(session.getSnapshot().pending?.resumable).toBe(true);
  await session.continueRun();
  expect(api.startChatRun).toHaveBeenCalledOnce();
  expect(api.continueChatRun).toHaveBeenCalledWith(
    "registry-doc",
    "session",
    "run",
  );
  expect(history.filter((m) => m.role === "user")).toHaveLength(1);
  expect(session.getSnapshot().pending?.content).toBe("continued");
  session.dispose();
});

it("cancels a continuation accepted after the viewer was stopped", async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    setTimeout(callback, 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  let run: ChatRun = {
    id: "pending-run",
    documentId: "cancel-doc",
    sessionId: "cancel-session",
    userMessageId: "question",
    provider: "api",
    status: "failed",
    resumable: true,
    startedAt: "now",
  };
  vi.mocked(api.sessionMessages).mockResolvedValue([
    {
      id: "question",
      documentId: "cancel-doc",
      sessionId: "cancel-session",
      role: "user",
      content: "question",
      createdAt: "now",
    },
  ]);
  vi.mocked(api.chatSessions).mockImplementation(async () => [
    {
      id: "cancel-session",
      documentId: "cancel-doc",
      title: "",
      provider: "api",
      createdAt: "",
      updatedAt: "",
      latestRun: run,
    },
  ]);
  vi.mocked(watchChatRun).mockImplementation(
    async (_doc, _session, _run, _signal, emit) => {
      emit({ event: "error", data: { error: "502" } });
    },
  );
  let accepted!: (run: ChatRun) => void;
  vi.mocked(api.continueChatRun).mockImplementation(
    () =>
      new Promise((resolve) => {
        accepted = resolve;
      }),
  );
  vi.mocked(api.cancelChatRun).mockImplementation(async () => {
    run = { ...run, status: "cancelled", resumable: true };
    return { ok: true };
  });
  const session = getChatSession("cancel-doc", "cancel-session");
  await session.load();
  await vi.waitFor(() => expect(session.getSnapshot().busy).toBe(false));
  const continuing = session.continueRun();
  await vi.waitFor(() => expect(api.continueChatRun).toHaveBeenCalledOnce());
  session.cancel();
  expect(session.getSnapshot().pending?.controller.signal.aborted).toBe(true);
  expect(api.cancelChatRun).not.toHaveBeenCalled();
  accepted({ ...run, status: "running", resumable: false });
  await continuing;
  await vi.waitFor(() =>
    expect(api.cancelChatRun).toHaveBeenCalledWith(
      "cancel-doc",
      "cancel-session",
      "pending-run",
    ),
  );
  expect(watchChatRun).toHaveBeenCalledOnce();
  expect(api.startChatRun).not.toHaveBeenCalled();
  session.dispose();
});

it("preserves a continuation 409 instead of replacing it with a failed status lookup", async () => {
  const { RequestError } = await import("@neoread/api");
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    setTimeout(callback, 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  const run: ChatRun = {
    id: "binding-run",
    documentId: "binding-doc",
    sessionId: "binding-session",
    userMessageId: "question",
    provider: "api",
    status: "failed",
    resumable: true,
    startedAt: "now",
  };
  let rejected = false;
  vi.mocked(api.sessionMessages).mockResolvedValue([
    {
      id: "question",
      documentId: "binding-doc",
      sessionId: "binding-session",
      role: "user",
      content: "question",
      createdAt: "now",
    },
  ]);
  vi.mocked(api.chatSessions).mockImplementation(async () => {
    if (rejected) throw new Error("status temporarily offline");
    return [
      {
        id: "binding-session",
        documentId: "binding-doc",
        title: "",
        provider: "api",
        createdAt: "",
        updatedAt: "",
        latestRun: run,
      },
    ];
  });
  vi.mocked(watchChatRun).mockImplementation(
    async (_doc, _session, _run, _signal, emit) => {
      emit({ event: "error", data: { error: "502" } });
    },
  );
  vi.mocked(api.continueChatRun).mockImplementation(async () => {
    rejected = true;
    throw new RequestError(
      "模型配置已改变，请重新生成。",
      undefined,
      undefined,
      409,
    );
  });
  const session = getChatSession("binding-doc", "binding-session");
  await session.load();
  await vi.waitFor(() => expect(session.getSnapshot().busy).toBe(false));
  await session.continueRun();
  expect(session.getSnapshot().pending).toMatchObject({
    continuationRejected: true,
    resumable: false,
    error: "模型配置已改变，请重新生成。",
  });
  expect(session.getSnapshot().pending?.notice).toContain("模型配置已改变");
  expect(api.continueChatRun).toHaveBeenCalledOnce();
  session.dispose();
});
