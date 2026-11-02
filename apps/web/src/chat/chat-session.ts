import { api, chat, type ChatStreamEvent } from "@neoread/api";
import type {
  ChatRun,
  ChatMessageChange,
  ChatMessageChangeResult,
  ToolActivity,
  DocumentLocation,
  ImageAttachment,
  Message,
  SourceReference,
} from "@neoread/core";
import { refreshAIConfig } from "../store";
export type ChatInput = {
  webSearch?: boolean;
  /** Stable identity of the question across explicit regeneration attempts. */
  userMessageId?: string;
  readingLocation?: DocumentLocation;
  provider: string;
  prompt: string;
  context: string;
  references: SourceReference[];
  attachments: ImageAttachment[];
};
export type PendingAnswer = {
  tools?: ToolActivity[];
  reasoning?: string;
  draft?: string;
  key: string;
  content: string;
  phase:
    | "generating"
    | "syncing"
    | "saved"
    | "incomplete"
    | "unconfirmed"
    | "cancelled";
  notice: string;
  activity?: Extract<ChatStreamEvent, { event: "activity" }>["data"];
  fallback: string;
  input: ChatInput;
  savedId?: string;
  error?: string;
  regenerationBlocked?: boolean;
  controller: AbortController;
};
export type ChatSnapshot = {
  messages: Message[];
  messageKeys: Record<string, string>;
  pending?: PendingAnswer;
  archived: PendingAnswer[];
  busy: boolean;
  loaded: boolean;
  loadError?: string;
};
export interface ChatTransport {
  messages: typeof api.messages;
  changeMessage?: (
    messageId: string,
    change: ChatMessageChange,
  ) => Promise<ChatMessageChangeResult>;
  latestRun?: () => Promise<ChatRun | undefined>;
  resume?: (
    run: ChatRun,
    signal: AbortSignal,
    emit: (event: ChatStreamEvent) => void,
  ) => Promise<void>;
  cancel?: () => Promise<unknown>;
  stream: (
    id: string,
    input: ChatInput,
    signal: AbortSignal,
    emit: (event: ChatStreamEvent) => void,
  ) => Promise<void>;
}
const transport: ChatTransport = {
  messages: api.messages,
  stream: async (id, input, signal, emit) => {
    try {
      await chat(
        id,
        input.provider,
        input.prompt,
        input.context,
        signal,
        () => {},
        input.references,
        input.attachments.map((image) => image.id),
        undefined,
        emit,
        input.readingLocation,
        input.userMessageId,
        input.webSearch,
      );
    } finally {
      // The server records failed primary attempts even when a fallback succeeds.
      void refreshAIConfig().catch(() => {});
    }
  },
};
function unansweredQuestion(message: Message): PendingAnswer {
  return {
    key: `question-${message.id}`,
    content: "",
    phase: "incomplete",
    notice: "问题已保存，可重新生成回答。",
    fallback: "",
    input: {
      userMessageId: message.id,
      provider: "",
      prompt: message.content,
      context: message.context ?? "",
      references: message.references ?? [],
      attachments: message.attachments ?? [],
      readingLocation: message.readingLocation,
      webSearch: message.webSearch,
    },
    controller: new AbortController(),
  };
}
/** A per-document store keeps delta renders inside AssistantPanel, outside Workspace. */
export class ChatSession {
  private state: ChatSnapshot = {
    messages: [],
    messageKeys: {},
    archived: [],
    busy: false,
    loaded: false,
  };
  private active?: PendingAnswer;
  private query?: AbortController;
  private listeners = new Set<() => void>();
  private serial = 0;
  private regeneration?: number;
  private alive = true;
  private frame = 0;
  constructor(
    readonly documentId: string,
    private io = transport,
    readonly sessionId?: string,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<ChatSnapshot> = {}) {
    this.state = {
      ...this.state,
      ...patch,
      pending: this.active ? { ...this.active } : undefined,
    };
    for (const listener of this.listeners) listener();
  }
  private flush = () => {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.publish();
  };
  activate() {
    this.alive = true;
  }
  private querySignal() {
    this.query?.abort();
    this.query = new AbortController();
    return AbortSignal.any([this.query.signal, AbortSignal.timeout(15_000)]);
  }
  async load() {
    if (this.state.busy) return;
    const serial = ++this.serial;
    try {
      const [messages, run] = await Promise.all([
        this.io.messages(this.documentId, this.querySignal()),
        this.io.latestRun?.(),
      ]);
      if (this.alive && serial === this.serial) {
        const last = messages.at(-1);
        const messageKeys = { ...this.state.messageKeys };
        if (!this.active && last?.role === "user") {
          this.active = unansweredQuestion(last);
          this.active.notice = "上一轮回答未完成，可重新生成。";
          messageKeys[last.id] = `${this.active.key}-user`;
        }
        this.publish({
          messages,
          messageKeys,
          loaded: true,
          loadError: undefined,
        });
        if (
          run &&
          this.current(serial) &&
          (run.status === "running" ||
            (last?.role === "user" && run.userMessageId === last.id))
        ) {
          const question = messages.find((m) => m.id === run.userMessageId);
          if (question)
            void this.generate(
              {
                userMessageId: question.id,
                provider: run.provider,
                prompt: question.content,
                context: question.context ?? "",
                references: question.references ?? [],
                attachments: question.attachments ?? [],
                readingLocation: question.readingLocation,
                webSearch: question.webSearch,
              },
              this.active,
              run,
            );
        }
      }
    } catch (error) {
      if (this.alive && serial === this.serial)
        this.publish({ loaded: false, loadError: (error as Error).message });
    }
  }
  dispose() {
    this.alive = false;
    this.serial++;
    this.active?.controller.abort();
    this.query?.abort();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
  private current(serial: number) {
    return this.alive && serial === this.serial;
  }
  async send(input: ChatInput) {
    if (!this.alive || this.state.busy) return;
    if (!this.state.loaded)
      throw new Error("对话记录尚未加载，请重新加载后发送。");
    await this.generate({
      ...structuredClone(input),
      userMessageId: crypto.randomUUID().replaceAll("-", ""),
    });
  }
  async changeMessage(message: Message, content?: string) {
    if (!this.alive || this.state.busy || !this.state.loaded)
      throw new Error("请等待当前操作结束后再修改问题。");
    if (!this.io.changeMessage)
      throw new Error("当前会话不支持修改，请重新打开文档。");
    const saved = this.state.messages.find((item) => item.id === message.id);
    const last = this.state.messages.at(-1);
    if (!saved || saved.role !== "user" || !last)
      throw new Error("问题尚未保存，请先同步对话记录。");
    const serial = ++this.serial;
    this.query?.abort();
    this.publish({ busy: true });
    try {
      const result = await this.io.changeMessage(message.id, {
        expectedLastMessageId: last.id,
        expectedContent: message.content,
        content,
      });
      if (this.current(serial)) {
        this.active?.controller.abort();
        this.active = undefined;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = 0;
        const question = result.messages.at(-1);
        const messageKeys: Record<string, string> = {};
        if (question?.role === "user") {
          this.active = unansweredQuestion(question);
          messageKeys[question.id] = `${this.active.key}-user`;
        }
        this.publish({
          messages: result.messages,
          messageKeys,
          archived: [],
          loaded: true,
          loadError: undefined,
        });
      }
      return result.message;
    } finally {
      if (this.current(serial)) this.publish({ busy: false });
    }
  }
  private async generate(
    input: ChatInput,
    replacing?: PendingAnswer,
    resumeRun?: ChatRun,
  ) {
    const serial = ++this.serial;
    const controller = new AbortController();
    const pending: PendingAnswer = {
      key: replacing?.key ?? `request-${serial}`,
      content: "",
      phase: "generating",
      notice: "正在阅读上下文…",
      fallback: "",
      input,
      controller,
    };
    const prior = this.state.pending;
    this.active = pending;
    this.publish({
      pending,
      busy: true,
      archived:
        prior && !prior.savedId && !replacing
          ? [...this.state.archived, prior]
          : this.state.archived,
    });
    let terminal = false,
      received = false;
    const emit = (event: ChatStreamEvent) => {
      if (!this.current(serial) || controller.signal.aborted || terminal)
        return;
      received = true;
      if (event.event === "tool") {
        const tools = [...(pending.tools ?? [])];
        const index = tools.findIndex((t) => t.id === event.data.id);
        if (index < 0) {
          if (tools.length < 256) tools.push(event.data);
        } else tools[index] = event.data;
        pending.tools = tools;
        this.flush();
        return;
      }
      if (event.event === "reasoning") {
        pending.reasoning = (pending.reasoning || "") + event.data.text;
        pending.notice = "";
        pending.activity = undefined;
        if (!this.frame) this.frame = requestAnimationFrame(this.flush);
        return;
      }
      if (event.event === "draft") {
        pending.draft = event.data.reset
          ? ""
          : (pending.draft || "") + event.data.text;
        if (pending.draft) {
          pending.notice = "";
          pending.activity = undefined;
        }
        if (!this.frame) this.frame = requestAnimationFrame(this.flush);
        return;
      }
      if (event.event === "delta") {
        pending.draft = "";
        pending.content += event.data.text;
        pending.notice = "";
        pending.activity = undefined;
        if (!this.frame) this.frame = requestAnimationFrame(this.flush);
        return;
      }
      if (event.event === "status") {
        pending.activity = undefined;
        pending.notice =
          event.data.status === "reading-image"
            ? "正在阅读图片…"
            : "正在阅读上下文…";
      }
      if (event.event === "fallback") {
        pending.activity = undefined;
        pending.fallback = event.data.message;
      }
      if (event.event === "activity") {
        pending.activity = event.data;
        pending.notice = event.data.message;
      }
      if (event.event === "error") {
        pending.tools = pending.tools?.map((t) =>
          t.status === "running" ? { ...t, status: "failed" } : t,
        );
        pending.error = event.data.error;
        pending.activity = undefined;
        terminal = true;
        pending.phase = "incomplete";
        pending.notice = `${event.data.error}（回答未完成）`;
      }
      if (event.event === "done") {
        pending.activity = undefined;
        terminal = true;
        pending.phase = "syncing";
        pending.notice = "回答已保存，正在同步…";
      }
      this.flush();
    };
    try {
      if (resumeRun && this.io.resume)
        await this.io.resume(resumeRun, controller.signal, emit);
      else
        await this.io.stream(this.documentId, input, controller.signal, emit);
      if (!this.current(serial)) return;
      if (!terminal && !controller.signal.aborted) {
        pending.tools = pending.tools?.map((t) =>
          t.status === "running" ? { ...t, status: "failed" } : t,
        );
        pending.phase = "unconfirmed";
        pending.notice = "完成状态未确认";
      }
    } catch (error) {
      if (!this.current(serial)) return;
      if (!terminal && !controller.signal.aborted) {
        pending.tools = pending.tools?.map((t) =>
          t.status === "running" ? { ...t, status: "failed" } : t,
        );
        pending.phase = "unconfirmed";
        pending.error = (error as Error).message;
        pending.notice = `${(error as Error).message}；完成状态未确认`;
      }
    } finally {
      if (this.current(serial)) {
        if (replacing && !received) {
          pending.content = replacing.content;
          pending.draft = replacing.draft;
          pending.reasoning = replacing.reasoning;
        }
        this.flush();
        // Keep the single-request lock until this reconciliation ends. No automatic re-POST.
        await this.reconcile(serial, pending);
        if (this.current(serial)) this.publish({ busy: false });
      }
    }
  }
  cancel() {
    const pending = this.active;
    if (pending && this.regeneration === this.serial) {
      this.serial++;
      this.regeneration = undefined;
      this.query?.abort();
      pending.tools = pending.tools?.map((t) =>
        t.status === "running" ? { ...t, status: "cancelled" } : t,
      );
      pending.phase = "cancelled";
      pending.notice = "已取消重新生成。";
      this.publish({ busy: false });
      return;
    }
    if (
      !pending ||
      (pending.phase !== "generating" &&
        !(this.io.cancel && pending.phase === "unconfirmed"))
    )
      return;
    pending.tools = pending.tools?.map((t) =>
      t.status === "running" ? { ...t, status: "cancelled" } : t,
    );
    pending.phase = "cancelled";
    pending.notice = "已停止；正在核对保存状态";
    if (this.io.cancel) {
      void this.io.cancel().catch((error: Error) => {
        pending.tools = pending.tools?.map((t) =>
          t.status === "running" ? { ...t, status: "failed" } : t,
        );
        pending.phase = "unconfirmed";
        pending.notice = `停止状态未确认：${error.message}`;
        this.flush();
      });
    } else pending.controller.abort();
    this.flush();
  }
  retrySync = async () => {
    if (!this.alive || this.state.busy) return;
    if (!this.state.loaded) {
      await this.load();
      return;
    }
    if (this.state.busy || !this.active) return;
    const serial = this.serial,
      pending = this.active;
    this.publish({ busy: true });
    await this.reconcile(serial, pending);
    if (this.current(serial)) this.publish({ busy: false });
  };
  regenerate = async (provider: string) => {
    const pending = this.active;
    if (
      !this.alive ||
      this.state.busy ||
      !this.state.loaded ||
      !provider ||
      !pending ||
      ["generating", "syncing", "saved"].includes(pending.phase)
    )
      return;
    const serial = ++this.serial;
    this.regeneration = serial;
    this.publish({ busy: true });
    // A disconnect can race a successful save. Never replay until history is
    // reachable, and let the server enforce the unanswered-tail boundary again.
    const synced = await this.reconcile(serial, pending);
    if (this.regeneration === serial) this.regeneration = undefined;
    if (!this.current(serial)) return;
    if (!synced || pending.savedId || pending.regenerationBlocked) {
      this.publish({ busy: false });
      return;
    }
    try {
      const run = await this.io.latestRun?.();
      if (!this.current(serial)) return;
      if (run?.status === "running" && this.io.resume) {
        await this.generate(
          { ...pending.input, provider: run.provider },
          pending,
          run,
        );
      } else await this.generate({ ...pending.input, provider }, pending);
    } catch (error) {
      if (this.current(serial)) this.publish({ busy: false });
      throw error;
    }
  };
  private async reconcile(serial: number, pending: PendingAnswer) {
    try {
      const messages = await this.io.messages(
        this.documentId,
        this.querySignal(),
      );
      if (!this.current(serial) || this.active !== pending) return false;
      const userIndex = messages.findIndex(
        (message) =>
          message.id === pending.input.userMessageId && message.role === "user",
      );
      const turn = userIndex < 0 ? [] : messages.slice(userIndex + 1);
      const nextUser = turn.findIndex((message) => message.role === "user");
      const assistants = (nextUser < 0 ? turn : turn.slice(0, nextUser)).filter(
        (message) => message.role === "assistant",
      );
      const user = messages[userIndex],
        assistant = assistants[0];
      const associated =
        !!user &&
        assistants.length === 1 &&
        user.content === pending.input.prompt &&
        messages.every(
          (message) =>
            message.documentId === this.documentId &&
            (!this.sessionId || message.sessionId === this.sessionId),
        );
      pending.regenerationBlocked =
        userIndex >= 0 &&
        !associated &&
        (userIndex !== messages.length - 1 ||
          user.content !== pending.input.prompt);
      const messageKeys = { ...this.state.messageKeys };
      if (user && user.content === pending.input.prompt)
        messageKeys[user.id] = `${pending.key}-user`;
      if (associated) {
        messageKeys[assistant.id] = pending.key;
        pending.savedId = assistant.id;
        pending.content = assistant.content;
        pending.reasoning = assistant.reasoning;
        pending.tools = assistant.tools;
        pending.draft = "";
        pending.phase = "saved";
        pending.notice = "";
      } else {
        pending.notice = pending.regenerationBlocked
          ? "这轮问题已有后续记录，无法重新生成。"
          : pending.phase === "syncing"
            ? "回答已保存，暂未读取到对应记录，请重试。"
            : pending.phase === "cancelled"
              ? "已停止，可重新生成。"
              : pending.error
                ? `${pending.error}（回答未完成，可重新生成）`
                : "回答未完成，可重新生成。";
      }
      this.publish({ messages, messageKeys });
      return true;
    } catch {
      if (!this.current(serial)) return false;
      pending.notice =
        pending.phase === "syncing"
          ? "回答已保存，暂时无法读取，请稍后重试。"
          : "暂时无法读取对话记录，请稍后重试。";
      this.publish({ pending: { ...pending } });
      return false;
    }
  }
}

export function chatRetryAction(
  state: ChatSnapshot,
): "reload" | "sync" | "regenerate" | undefined {
  if (state.loadError) return "reload";
  const pending = state.pending;
  if (
    !pending ||
    pending.regenerationBlocked ||
    ["generating", "saved"].includes(pending.phase)
  )
    return;
  return pending.phase === "syncing" ? "sync" : "regenerate";
}
