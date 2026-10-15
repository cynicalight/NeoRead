import { lazy, Suspense, useSyncExternalStore, type ReactNode } from "react";
import { ArrowDown, BookOpen, LoaderCircle } from "lucide-react";
import { ProviderGlyph } from "../ProviderIdentity";
import type { Message } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { ScrollArea } from "@reader/ui/components/scroll-area";
import {
  ChatSession,
  chatRetryAction,
  type ChatSnapshot,
  type PendingAnswer,
} from "./chat-session";
import { AnswerActions } from "./AnswerActions";
import { Thinking } from "./Thinking";
const MessageMarkdown = lazy(() =>
  import("./MessageMarkdown").then((module) => ({
    default: module.MessageMarkdown,
  })),
);
import { useChatScroll } from "./useChatScroll";
export type ChatRow = {
  key: string;
  message?: Message;
  pending?: PendingAnswer;
};
export function chatRows(state: ChatSnapshot): ChatRow[] {
  const { pending } = state;
  const rows: ChatRow[] = state.messages.map((message) => ({
    key: state.messageKeys[message.id] || message.id,
    message,
    pending: pending?.savedId === message.id ? pending : undefined,
  }));
  for (const answer of state.archived) {
    const userIndex = rows.findIndex((row) => row.key === `${answer.key}-user`);
    rows.splice(userIndex < 0 ? rows.length : userIndex + 1, 0, {
      key: answer.key,
      pending: answer,
    });
  }
  if (pending && !pending.savedId) {
    if (!rows.some((row) => row.key === `${pending.key}-user`))
      rows.push({
        key: `${pending.key}-user`,
        message: {
          id: `${pending.key}-user`,
          documentId: "",
          role: "user",
          content: pending.input.prompt,
          context: pending.input.context,
          readingLocation: pending.input.readingLocation,
          references: pending.input.references,
          attachments: pending.input.attachments,
          createdAt: "",
        },
      });
    rows.push({ key: pending.key, pending });
  }
  return rows;
}
export function AssistantPanel({
  session,
  empty,
  extras,
  references,
  onRegenerate,
  regenerateDisabled = false,
}: {
  session: ChatSession;
  empty: ReactNode;
  extras: (message: Message) => ReactNode;
  references: (message: Message) => ReactNode;
  onRegenerate: () => void;
  regenerateDisabled?: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const scroll = useChatScroll(state.pending?.key);
  const pending = state.pending;
  const retryAction = chatRetryAction(state);
  return (
    <div className="chat-thread">
      <ScrollArea className="chat-scroll" viewportRef={scroll.viewportRef}>
        <div className="chat-messages" ref={scroll.contentRef}>
          {!state.loaded && (
            <p className="chat-status">{state.loadError || "正在加载对话…"}</p>
          )}
          {!state.messages.length && !pending && state.loaded && empty}
          {chatRows(state).map(({ key, message, pending: answer }) => {
            const assistant = answer || message?.role === "assistant",
              content = answer
                ? answer.content + (answer.draft || "")
                : (message?.content ?? "");
            const reasoning = answer?.reasoning ?? message?.reasoning ?? "";
            const waiting =
              answer?.phase === "generating" &&
              !content &&
              (!reasoning || !!answer.activity);
            const timestamp = message?.createdAt
              ? new Date(message.createdAt)
              : undefined;
            return (
              <div
                key={key}
                data-message-id={message?.id}
                className={`chat-message ${assistant ? "assistant" : "user"}`}
              >
                {waiting && (
                  <div
                    className="chat-waiting"
                    role="status"
                    aria-label={answer.notice ? undefined : "正在等待回答"}
                  >
                    <span
                      className={`chat-waiting-icon${answer.activity ? " chat-waiting-icon--activity" : ""}`}
                      aria-hidden="true"
                    >
                      {answer.activity ? (
                        <BookOpen size={16} strokeWidth={1.5} />
                      ) : answer.fallback ||
                        !["codex", "claude", "kimi", "api"].includes(
                          answer.input.provider,
                        ) ? (
                        <LoaderCircle size={16} />
                      ) : (
                        <ProviderGlyph
                          provider={answer.input.provider}
                          size={16}
                        />
                      )}
                    </span>
                    {answer.notice && (
                      <span className="chat-status" title={answer.notice}>
                        {answer.notice}
                      </span>
                    )}
                  </div>
                )}
                {assistant && reasoning && (
                  <Thinking
                    text={reasoning}
                    active={answer?.phase === "generating" && !content}
                    incomplete={
                      !!answer &&
                      ["incomplete", "unconfirmed", "cancelled"].includes(
                        answer.phase,
                      )
                    }
                  />
                )}
                {assistant ? (
                  <Suspense
                    fallback={
                      <div style={{ whiteSpace: "pre-wrap" }}>{content}</div>
                    }
                  >
                    <MessageMarkdown
                      content={content}
                      generating={answer?.phase === "generating"}
                    />
                  </Suspense>
                ) : (
                  <>
                    {message && references(message)}
                    <div className="chat-question">{content}</div>
                  </>
                )}
                {answer?.fallback && (
                  <p className="chat-status">{answer.fallback}</p>
                )}
                {answer?.notice && !waiting && (
                  <p role="status" className="chat-status">
                    {answer.notice}
                  </p>
                )}
                {assistant && !!content && (
                  <AnswerActions content={content} timestamp={timestamp} />
                )}
                {message && extras(message)}
              </div>
            );
          })}
          {retryAction && (
            <Button
              variant="ghost"
              size="sm"
              disabled={
                state.busy ||
                (retryAction === "regenerate" && regenerateDisabled)
              }
              onClick={() =>
                retryAction === "regenerate"
                  ? onRegenerate()
                  : void session.retrySync()
              }
            >
              {
                {
                  reload: "重新加载",
                  sync: "恢复回答",
                  regenerate: "重新生成",
                }[retryAction]
              }
            </Button>
          )}
        </div>
      </ScrollArea>
      {!scroll.following && (
        <Button
          className="chat-follow"
          variant="outline"
          size="icon"
          aria-label="回到底部"
          title="回到底部"
          onClick={scroll.bottom}
        >
          <ArrowDown aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
