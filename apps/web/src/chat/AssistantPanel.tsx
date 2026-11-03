import { ChatSelectionToolbar } from "./ChatSelectionToolbar";
import { ToolActivities } from "./ToolActivities";
import {
  lazy,
  memo,
  Suspense,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ArrowDown, BookOpen, LoaderCircle } from "lucide-react";
import { ProviderGlyph } from "../ProviderIdentity";
import type { Message } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { ScrollArea } from "@neoread/ui/components/scroll-area";
import {
  Trace,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@neoread/ui/components/trace";
import {
  ChatSession,
  chatRetryAction,
  type ChatSnapshot,
  type PendingAnswer,
} from "./chat-session";
import { AnswerActions } from "./AnswerActions";
import { QuestionActions } from "./QuestionActions";
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
type AssistantPanelProps = {
  session: ChatSession;
  empty: ReactNode;
  extras: (message: Message) => ReactNode;
  references: (message: Message) => ReactNode;
  onRegenerate: () => void;
  onWithdraw?: (message: Message) => void;
  onQuote?: (text: string) => void;
  regenerateDisabled?: boolean;
  renderAnswer?: (message: Message, content: ReactNode) => ReactNode;
};
const plainAnswer = (_message: Message, content: ReactNode) => content;

export function AssistantPanel({
  session,
  empty,
  extras,
  references,
  onRegenerate,
  onWithdraw,
  onQuote,
  regenerateDisabled = false,
  renderAnswer = plainAnswer,
}: AssistantPanelProps) {
  const thread = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const scroll = useChatScroll(state.pending?.key);
  const savedIndexes = useMemo(
    () => new Map(state.messages.map((message, index) => [message.id, index])),
    [state.messages],
  );
  const pending = state.pending;
  const retryAction = chatRetryAction(state);
  return (
    <div className="chat-thread" ref={thread}>
      <ScrollArea className="chat-scroll" viewportRef={scroll.viewportRef}>
        <div className="chat-messages" ref={scroll.contentRef}>
          {!state.loaded && (
            <p className="chat-status">{state.loadError || "正在加载对话…"}</p>
          )}
          {!state.messages.length && !pending && state.loaded && empty}
          {chatRows(state).map(({ key, message, pending: answer }) => (
            <ChatMessage
              key={key}
              message={message}
              answer={answer}
              saved={!!message && savedIndexes.has(message.id)}
              following={
                message
                  ? state.messages.length -
                    (savedIndexes.get(message.id) ?? state.messages.length) -
                    1
                  : 0
              }
              session={session}
              busy={state.busy}
              extras={extras}
              references={references}
              renderAnswer={renderAnswer}
              onRegenerate={onRegenerate}
              onWithdraw={onWithdraw}
              regenerateDisabled={regenerateDisabled}
            />
          ))}
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
      {onQuote && (
        <ChatSelectionToolbar
          content={scroll.contentRef}
          pane={thread}
          identity={session}
          onQuote={onQuote}
        />
      )}
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

const ChatMessage = memo(function ChatMessage({
  message,
  answer,
  saved,
  following,
  session,
  busy,
  extras,
  references,
  renderAnswer = plainAnswer,
  onRegenerate,
  onWithdraw,
  regenerateDisabled = false,
}: Omit<AssistantPanelProps, "empty"> & {
  message?: Message;
  answer?: PendingAnswer;
  saved: boolean;
  following: number;
  busy: boolean;
}) {
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
  const markdown = (
    <Suspense
      fallback={<div style={{ whiteSpace: "pre-wrap" }}>{content}</div>}
    >
      <MessageMarkdown
        content={content}
        generating={answer?.phase === "generating"}
      />
    </Suspense>
  );
  return (
    <div
      data-message-id={message?.id}
      data-generating={answer?.phase === "generating" || undefined}
      className={`chat-message ${assistant ? "assistant" : "user"}`}
    >
      <ToolActivities
        tools={answer?.tools ?? message?.tools}
        sources={message?.webSources}
      />
      {(waiting || answer?.activity) && (
        <Trace className="mb-2" role="status">
          <TraceLine status="running">
            <TraceIcon>
              {answer.activity ? (
                <BookOpen size={16} strokeWidth={1.5} />
              ) : answer.fallback ||
                !["codex", "claude", "kimi", "api"].includes(
                  answer.input.provider,
                ) ? (
                <LoaderCircle size={16} />
              ) : (
                <ProviderGlyph provider={answer.input.provider} size={16} />
              )}
            </TraceIcon>
            <TraceTitle title={answer.notice}>
              {answer.notice || "正在等待回答…"}
            </TraceTitle>
          </TraceLine>
        </Trace>
      )}
      {assistant && reasoning && (
        <Thinking
          text={reasoning}
          active={answer?.phase === "generating" && !content}
          incomplete={
            !!answer &&
            ["incomplete", "unconfirmed", "cancelled"].includes(answer.phase)
          }
        />
      )}
      {assistant ? (
        <div data-chat-text>
          {message ? renderAnswer(message, markdown) : markdown}
        </div>
      ) : (
        <>
          {message && references(message)}
          <div className="chat-question" data-chat-text>
            {content}
          </div>
        </>
      )}
      {answer?.fallback && <p className="chat-status">{answer.fallback}</p>}
      {answer?.notice && !waiting && !answer.activity && (
        <p role="status" className="chat-status">
          {answer.notice}
        </p>
      )}
      {assistant && !!content && (
        <AnswerActions content={content} timestamp={timestamp} />
      )}
      {!assistant && message && onWithdraw && saved && (
        <QuestionActions
          message={message}
          following={following}
          session={session}
          disabled={busy || regenerateDisabled}
          onRegenerate={onRegenerate}
          onWithdraw={onWithdraw}
        />
      )}
      {message && extras(message)}
    </div>
  );
});
