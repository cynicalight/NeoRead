import { api, RequestError, watchChatRun } from "@neoread/api";
import type { ChatRun } from "@neoread/core";
import { ChatSession, type ChatTransport } from "./chat-session";
import { refreshAIConfig } from "../store";
import { watchRunWithReconnect } from "./run-stream";

const sessions = new Map<string, ChatSession>();
/** Viewer lifetime is independent of run lifetime. Active stores are never evicted. */
export function getChatSession(
  documentId: string,
  sessionId: string,
): ChatSession {
  const key = `${documentId}:${sessionId}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  let run: ChatRun | undefined;
  let starting: Promise<ChatRun> | undefined;
  const latestRun = async (signal?: AbortSignal) =>
    (
      await api.chatSessions(
        documentId,
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      )
    ).find((s) => s.id === sessionId)?.latestRun;
  const watch: NonNullable<ChatTransport["resume"]> = (active, signal, emit) =>
    watchRunWithReconnect(
      active,
      signal,
      emit,
      (current, abort, receive) =>
        watchChatRun(documentId, sessionId, current.id, abort, receive),
      () => latestRun(signal),
    );
  const io: ChatTransport = {
    messages: (_id, signal) =>
      api.sessionMessages(documentId, sessionId, signal),
    latestRun,
    resume: async (active, signal, emit) => {
      run = active;
      await watch(active, signal, emit);
    },
    continueRun: async (active, signal, emit) => {
      run = active;
      // Let the POST acceptance resolve before server cancellation, just like a new run.
      // Aborting the viewer stream must not hide a successfully accepted continuation.
      starting = api
        .continueChatRun(documentId, sessionId, active.id)
        .catch(async (error) => {
          // The accepted continuation can outlive a lost POST response; only attach,
          // never issue another continuation or create a new question automatically.
          if (
            signal.aborted ||
            (error instanceof RequestError && error.status === 409)
          )
            throw error;
          const accepted = await latestRun();
          if (
            accepted?.id === active.id &&
            accepted.userMessageId === active.userMessageId &&
            (accepted.status === "running" || accepted.status === "completed")
          )
            return accepted;
          throw error;
        });
      try {
        run = await starting;
        await watch(run, signal, emit);
      } finally {
        starting = undefined;
      }
    },
    stream: async (_id, input, signal, emit) => {
      starting = api
        .startChatRun(documentId, sessionId, {
          ...input,
          attachments: input.attachments.map((i) => i.id),
        })
        .catch(async (error) => {
          // POST may have been accepted before its response was lost. Query by
          // stable question ID; never retry the POST automatically.
          const accepted = await latestRun();
          if (accepted && accepted.userMessageId === input.userMessageId)
            return accepted;
          throw error;
        });
      try {
        run = await starting;
        await watch(run, signal, emit);
      } finally {
        starting = undefined;
        if (!signal.aborted) void refreshAIConfig().catch(() => {});
      }
    },
    cancel: async () => {
      const active = starting
        ? await starting.catch(() => run ?? latestRun())
        : (run ?? (await latestRun()));
      if (active) await api.cancelChatRun(documentId, sessionId, active.id);
    },
  };
  const session = new ChatSession(documentId, io, sessionId);
  sessions.set(key, session);
  if (sessions.size > 24) {
    for (const [oldKey, old] of sessions) {
      if (oldKey !== key && !old.getSnapshot().busy) {
        old.dispose();
        sessions.delete(oldKey);
        break;
      }
    }
  }
  return session;
}
