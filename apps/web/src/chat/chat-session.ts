import { api, chat, RequestError, type ChatStreamEvent } from "@neoread/api";
import type {
  ChatRun,
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
  run?: ChatRun;
  resumable?: boolean;
  reconnectable?: boolean;
  runStatusUnconfirmed?: boolean;
  continuationRejected?: boolean;
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
  latestRun?: (signal?: AbortSignal) => Promise<ChatRun | undefined>;
  continueRun?: (
    run: ChatRun,
    signal: AbortSignal,
    emit: (event: ChatStreamEvent) => void,
  ) => Promise<void>;
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
      if (!signal.aborted) void refreshAIConfig().catch(() => {});
    }
  },
};
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
  private continuing?: number;
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
          this.active = {
            key: `question-${last.id}`,
            content: "",
            phase: "incomplete",
            notice: "上一轮回答未完成，可重新生成。",
            fallback: "",
            input: {
              userMessageId: last.id,
              provider: "",
              prompt: last.content,
              context: last.context ?? "",
              references: last.references ?? [],
              attachments: last.attachments ?? [],
              readingLocation: last.readingLocation,
              webSearch: last.webSearch,
            },
            controller: new AbortController(),
          };
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
  private async generate(
    input: ChatInput,
    replacing?: PendingAnswer,
    resumeRun?: ChatRun,
    continuing = false,
  ) {
    const serial = ++this.serial;
    const controller = new AbortController();
    const pending: PendingAnswer = {
      key: replacing?.key ?? `request-${serial}`,
      content: "",
      phase: "generating",
      notice: continuing ? "正在从已保存的进度继续…" : "正在阅读上下文…",
      run: resumeRun,
      tools: continuing
        ? replacing?.tools?.filter((tool) =>
            ["completed", "unavailable", "deferred"].includes(tool.status),
          )
        : undefined,
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
          tools.push(event.data);
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
        pending.notice = this.io.latestRun
          ? "回答中断，正在检查可继续的进度…"
          : `${event.data.error}（回答未完成）`;
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
      if (continuing && resumeRun && this.io.continueRun)
        await this.io.continueRun(resumeRun, controller.signal, emit);
      else if (resumeRun && this.io.resume)
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
        pending.continuationRejected =
          continuing && error instanceof RequestError && error.status === 409;
        if (pending.continuationRejected) pending.resumable = false;
        pending.phase = pending.continuationRejected
          ? "incomplete"
          : "unconfirmed";
        pending.error = (error as Error).message;
        pending.notice = pending.continuationRejected
          ? pending.error
          : `${(error as Error).message}；完成状态未确认`;
      }
    } finally {
      if (this.current(serial)) {
        if (replacing && !received) {
          pending.content = replacing.content;
          pending.draft = replacing.draft;
          pending.reasoning = replacing.reasoning;
        }
        this.flush();
        // Refresh checkpoint availability only after this attempt has ended.
        await this.refreshRun(serial, pending);
        if (!this.current(serial)) return;
        // Keep the single-request lock until reconciliation ends; never re-POST automatically.
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
      pending.notice =
        this.continuing === this.serial - 1
          ? "已取消继续。"
          : "已取消重新生成。";
      this.continuing = undefined;
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
    const serial = this.serial;
    pending.controller.abort();
    if (this.io.cancel) {
      void this.io.cancel().catch((error: Error) => {
        if (!this.current(serial) || this.active !== pending) return;
        pending.tools = pending.tools?.map((t) =>
          t.status === "running" ? { ...t, status: "failed" } : t,
        );
        pending.phase = "unconfirmed";
        pending.notice = `停止状态未确认：${error.message}`;
        this.flush();
      });
    }
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
    await this.refreshRun(serial, pending);
    if (!this.current(serial)) return;
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
  private acceptsRun(
    run: ChatRun | undefined,
    pending: PendingAnswer,
  ): run is ChatRun {
    return (
      !!run &&
      run.documentId === this.documentId &&
      (!this.sessionId || run.sessionId === this.sessionId) &&
      run.userMessageId === pending.input.userMessageId
    );
  }
  private async refreshRun(serial: number, pending: PendingAnswer) {
    if (!this.io.latestRun || !this.current(serial)) return;
    try {
      const run = await this.io.latestRun(this.querySignal());
      if (!this.current(serial) || this.active !== pending) return;
      pending.runStatusUnconfirmed = false;
      if (this.acceptsRun(run, pending)) {
        // Checkpoint presence cannot override a definite rejection for this run.
        // A different run has its own eligibility; an explicit reload rebuilds state too.
        if (pending.run?.id !== run.id) pending.continuationRejected = false;
        pending.run = run;
        pending.resumable =
          !pending.continuationRejected &&
          !!run.resumable &&
          !!this.io.continueRun;
        pending.reconnectable =
          run.status === "running" &&
          !!this.io.resume &&
          !pending.controller.signal.aborted;
      } else {
        pending.resumable = false;
        pending.reconnectable = false;
      }
    } catch {
      if (this.current(serial) && this.active === pending)
        pending.runStatusUnconfirmed = true;
    }
  }
  continueRun = () => this.resumePending(true);
  reconnect = () => this.resumePending(false);
  private async resumePending(continueFromCheckpoint: boolean) {
    const pending = this.active;
    if (
      !this.alive ||
      this.state.busy ||
      !this.state.loaded ||
      !pending ||
      !pending.run ||
      (!continueFromCheckpoint && !this.io.resume) ||
      (continueFromCheckpoint &&
        (!this.io.continueRun || pending.continuationRejected))
    )
      return;
    const originalRun = pending.run;
    const serial = ++this.serial;
    this.regeneration = serial;
    if (continueFromCheckpoint) this.continuing = serial;
    this.publish({ busy: true });
    try {
      if (
        !(await this.reconcile(serial, pending)) ||
        !this.current(serial) ||
        pending.savedId ||
        pending.regenerationBlocked
      )
        return;
      const run = await this.io.latestRun?.(this.querySignal());
      if (!this.current(serial)) return;
      if (!this.acceptsRun(run, pending) || run.id !== originalRun.id)
        throw new Error("运行记录已变化，请重新读取对话。");
      if (run.status === "running" && this.io.resume) {
        this.regeneration = undefined;
        await this.generate(
          { ...pending.input, provider: run.provider },
          pending,
          run,
        );
      } else if (
        continueFromCheckpoint &&
        run.resumable &&
        this.io.continueRun
      ) {
        this.regeneration = undefined;
        await this.generate(
          { ...pending.input, provider: run.provider },
          pending,
          run,
          true,
        );
      } else {
        pending.resumable = false;
        pending.reconnectable = false;
        throw new Error("当前运行没有可继续的进度，请重新读取对话状态。");
      }
    } catch (error) {
      if (this.current(serial)) {
        pending.notice = (error as Error).message;
        this.flush();
      }
    } finally {
      if (this.regeneration === serial) this.regeneration = undefined;
      if (this.continuing === serial) this.continuing = undefined;
      if (this.current(serial)) this.publish({ busy: false });
    }
  }
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
          : pending.continuationRejected
            ? pending.error || "当前运行无法继续，请重新生成。"
            : pending.phase === "syncing"
              ? "回答已保存，暂未读取到对应记录，请重试。"
              : pending.runStatusUnconfirmed
                ? "暂时无法确认运行状态，请恢复连接后继续。"
                : pending.reconnectable
                  ? "连接暂时中断，运行仍在继续，可重新连接。"
                  : pending.resumable
                    ? "回答已暂停，可从已保存的进度继续。"
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
      pending.notice = pending.continuationRejected
        ? pending.error || "当前运行无法继续，请重新生成。"
        : pending.phase === "syncing"
          ? "回答已保存，暂时无法读取，请稍后重试。"
          : "暂时无法读取对话记录，请稍后重试。";
      this.publish({ pending: { ...pending } });
      return false;
    }
  }
}

export function chatRetryAction(
  state: ChatSnapshot,
): "reload" | "sync" | "regenerate" | "continue" | "reconnect" | undefined {
  if (state.loadError) return "reload";
  const pending = state.pending;
  if (
    !pending ||
    pending.regenerationBlocked ||
    ["generating", "saved"].includes(pending.phase)
  )
    return;
  if (pending.continuationRejected) return "regenerate";
  if (pending.runStatusUnconfirmed) return "sync";
  if (pending.reconnectable) return "reconnect";
  if (pending.resumable) return "continue";
  return pending.phase === "syncing" ? "sync" : "regenerate";
}
