import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  isRetryableAssistantError,
  isContextOverflow,
  type Api,
  type Model,
  type ImageContent,
  type ProviderStreams,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { Type } from "typebox";

export interface AgentRequest {
  version: 1;
  runId: string;
  prompt: string;
  mode?: "prompt" | "continue";
  durableCheckpoints?: boolean;
  system: string;
  model: Model<Api>;
  key: string;
  payload?: Record<string, unknown>;
  endpoint?: string;
  effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  entries?: FileEntry[];
  images?: ImageContent[];
  tools: {
    name: string;
    description: string;
    schema: Record<string, unknown>;
  }[];
}
export type ToolResult = {
  content: ({ type: "text"; text: string } | ImageContent)[];
  details: undefined;
};
export interface AgentCheckpoint {
  entries: FileEntry[];
  canContinue: boolean;
}
export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly canContinue: boolean,
  ) {
    super(message);
  }
}

// 不把中断在工具执行过程中的状态当作可续接模型请求，避免重跑结果未知的工具。
function canContinueSession(manager: SessionManager): boolean {
  const messages = manager.buildSessionProjection().messages;
  const pending = new Set<string>();
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    )
      for (const part of message.content)
        if (part.type === "toolCall") pending.add(part.id);
    if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  if (pending.size) return false;
  const last = messages.at(-1);
  return (
    !!last &&
    (last.role === "user" ||
      last.role === "custom" ||
      last.role === "toolResult" ||
      (last.role === "assistant" &&
        isRetryableAssistantError(last) &&
        !isContextOverflow(last)))
  );
}

export type AgentEvent = { type: string; [key: string]: unknown };

// Pi 1.3 兼容缺失/进行中的终态；NeoRead 只接受明确 completed，避免保存不完整回答。
function responsesApi(): ProviderStreams {
  const native = openAIResponsesApi();
  const checkedOptions = <T extends StreamOptions>(options?: T) => ({
    ...options,
    maxRetries: 0,
    onProviderStreamEvent: async (event: unknown, model: Model<Api>) => {
      const value = event as { type?: string; response?: { status?: string } };
      if (
        value.type === "response.completed" &&
        value.response?.status !== "completed"
      )
        throw new Error("Responses 未返回有效完成状态");
      if (
        value.type === "response.incomplete" &&
        value.response?.status !== "incomplete"
      )
        throw new Error("Responses 返回无效中止状态");
      await options?.onProviderStreamEvent?.(event, model);
    },
  });
  return {
    stream: (model, context, options) =>
      native.stream(model, context, checkedOptions(options)),
    streamSimple: (model, context, options) =>
      native.streamSimple(model, context, checkedOptions(options)),
  };
}

/** The host owns the accepted entry tree. No user configuration or files are discovered. */
export async function runAgent(
  input: AgentRequest,
  emit: (event: AgentEvent) => void,
  callTool: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
    toolCallID?: string,
  ) => Promise<ToolResult>,
  signal: AbortSignal,
  saveCheckpoint?: (checkpoint: AgentCheckpoint) => Promise<void>,
) {
  if (
    input.version !== 1 ||
    !input.runId ||
    !input.model ||
    (!input.prompt && input.mode !== "continue") ||
    (input.mode !== undefined && !["prompt", "continue"].includes(input.mode))
  )
    throw new Error("不兼容的 Agent 请求");
  const model = input.model;
  if (
    !["openai-completions", "openai-responses", "anthropic-messages"].includes(
      model.api,
    )
  )
    throw new Error("不支持的模型协议");
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
    signal,
  });
  let checkpointBarrier = Promise.resolve();
  let checkpointFailure: Error | undefined;
  const native =
    model.api === "anthropic-messages"
      ? anthropicMessagesApi()
      : model.api === "openai-responses"
        ? responsesApi()
        : openAICompletionsApi();
  // SDK 在自己的重试/压缩循环中发起下一次请求；只在请求边界等待宿主持久化。
  const withCheckpoint = <T extends StreamOptions>(options?: T) => ({
    ...options,
    onPayload: async (payload: unknown, currentModel: Model<Api>) => {
      await checkpointBarrier;
      signal.throwIfAborted();
      return options?.onPayload?.(payload, currentModel);
    },
  });
  const api: ProviderStreams = {
    stream: (model, context, options) =>
      native.stream(model, context, withCheckpoint(options)),
    streamSimple: (model, context, options) =>
      native.streamSimple(model, context, withCheckpoint(options)),
  };
  const provider = createProvider({
    id: model.provider,
    name: "NeoRead",
    baseUrl: model.baseUrl,
    models: [model],
    auth: {
      apiKey: {
        name: "NeoRead API",
        resolve: async () => ({
          auth: { apiKey: input.key || "neoread-keyless" },
        }),
      },
    },
    api,
  });
  modelRuntime.registerNativeProvider(provider);
  await modelRuntime.setRuntimeApiKey(
    model.provider,
    input.key || "neoread-keyless",
  );
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => input.system,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const tools: ToolDefinition[] = input.tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.schema),
    execute: async (id, args, abort) => {
      // 工具执行前先使旧 checkpoint 不可续接，进程中断不能重跑结果未知的工具。
      checkpoint(false);
      await checkpointBarrier;
      signal.throwIfAborted();
      abort?.throwIfAborted();
      return callTool(tool.name, args, abort, id);
    },
  }));
  const manager = SessionManager.inMemory(process.cwd(), {}, input.entries);
  if (input.mode === "continue") {
    if (!input.entries?.length || !canContinueSession(manager))
      throw new AgentRunError("当前记录没有可安全继续的模型请求", false);
    const last = manager.buildSessionProjection().entries.at(-1);
    if (
      last?.sourceEntry.type === "message" &&
      last.sourceEntry.message.role === "assistant" &&
      last.sourceEntry.message.stopReason === "error"
    )
      manager.appendContextEdit(last.sourceEntry.id, null);
  }
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: manager,
    thinkingLevel: input.effort,
    settingsManager: SettingsManager.inMemory({
      retry: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 500,
        maxAgentDelayMs: 2000,
        provider: { maxRetries: 0 },
      },
      cacheWarming: "off",
      compaction: {
        enabled: true,
        // SDK 使用严格 >；预留 20% 向上取整，使整数用量超过 80% 时压缩。
        reserveTokens: Math.ceil(model.contextWindow * 0.2),
        keepRecentTokens: Math.min(12000, Math.floor(model.contextWindow / 3)),
      },
    }),
    tools: tools.map((tool) => tool.name),
    customTools: tools,
    noTools: "builtin",
  });
  const snapshot = (): FileEntry[] => {
    const entries = JSON.parse(
      JSON.stringify([manager.getHeader(), ...manager.getEntries()]),
    ) as FileEntry[];
    // 上游错误可能回显凭据；只清理 SDK 错误文案，不改会话 ID、正文或工具结果。
    if (input.key)
      for (const entry of entries)
        if (
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.errorMessage
        )
          entry.message.errorMessage = entry.message.errorMessage
            .split(input.key)
            .join("[redacted]");
    return entries;
  };
  const checkpoint = (
    canContinue = !signal.aborted && canContinueSession(manager),
  ) => {
    if (!input.durableCheckpoints || !saveCheckpoint || checkpointFailure)
      return;
    const value = { entries: snapshot(), canContinue };
    checkpointBarrier = checkpointBarrier.then(() => saveCheckpoint(value));
    void checkpointBarrier.catch(() => {
      if (!signal.aborted) checkpointFailure = new Error("会话进度保存失败");
      void session.abort();
    });
  };
  const maxToolRounds = 255;
  let rounds = 0;
  const stop = () => {
    void session.abort();
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const unsubscribe = session.subscribe((event) => {
    // message_end 的公开通知先于 SDK append；微任务排在同步持久化之后。
    if (
      event.type === "message_end" &&
      (event.message.role === "user" || event.message.role === "custom")
    )
      queueMicrotask(() => checkpoint());
    if (
      event.type === "turn_end" ||
      (event.type === "compaction_end" && event.result)
    )
      checkpoint();
    if (event.type === "auto_retry_start")
      emit({
        type: "activity",
        message: "模型连接暂时中断，正在继续当前请求",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
      });
    if (event.type === "turn_start") ++rounds;
    if (
      event.type === "turn_end" &&
      rounds === maxToolRounds &&
      event.message.role === "assistant" &&
      event.message.content.some((part) => part.type === "toolCall")
    ) {
      session.agent.steer({
        role: "user",
        content: [
          {
            type: "text",
            text: "本轮工具调用已接近预算，请关注剩余时间和上下文，优先补充必要证据并尽快完成回答。",
          },
        ],
        timestamp: Date.now(),
      });
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      emit({ type: "draft", reset: true, text: "" });
    }
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta.type === "text_delta" || delta.type === "thinking_delta") {
        emit({
          type: delta.type === "text_delta" ? "draft" : "reasoning",
          text: delta.delta,
        });
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const m = event.message;
      emit({
        type: "usage",
        model: m.model,
        usage: m.usage,
        status:
          m.stopReason === "aborted"
            ? "cancelled"
            : m.stopReason === "error" || m.stopReason === "length"
              ? "failed"
              : "complete",
      });
      if (m.content.some((part) => part.type === "toolCall"))
        emit({ type: "draft", reset: true, text: "" });
    }
    if (event.type === "compaction_end" && event.result?.usage) {
      emit({ type: "usage", model: model.id, usage: event.result.usage });
    }
    if (event.type === "compaction_start")
      emit({ type: "activity", message: "正在整理对话上下文" });
  });
  try {
    signal.throwIfAborted();
    if (input.mode === "continue") {
      await session.sendCustomMessage(
        {
          customType: "neoread_resume",
          content: "继续完成上一条尚未完成的请求，沿用已有工具结果。",
          display: false,
        },
        { triggerTurn: true },
      );
    } else {
      await session.prompt(input.prompt, {
        images: input.images,
        expandPromptTemplates: false,
      });
    }
    await session.waitForIdle();
    signal.throwIfAborted();
    const last = session.messages.at(-1);
    if (!last || last.role !== "assistant" || last.stopReason !== "stop")
      throw new Error(
        last?.role === "assistant"
          ? last.errorMessage || `模型未正常完成：${last.stopReason}`
          : "模型未返回完整回答",
      );
    const text = last.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (!text.trim()) throw new Error("模型未返回回答");
    await checkpointBarrier;
    if (checkpointFailure) throw checkpointFailure;
    return { text, entries: snapshot() };
  } catch (error) {
    const canContinue =
      !signal.aborted && !checkpointFailure && canContinueSession(manager);
    if (canContinue) {
      const projected = manager.buildSessionProjection().entries;
      const last = [...projected]
        .reverse()
        .find((entry) => entry.messages.length > 0);
      if (
        last?.sourceEntry.type === "message" &&
        last.sourceEntry.message.role === "assistant" &&
        last.sourceEntry.message.stopReason === "error"
      )
        manager.appendContextEdit(last.sourceEntry.id, null);
    }
    if (!signal.aborted) checkpoint(canContinue);
    try {
      await checkpointBarrier;
    } catch {
      /* 持久化失败不能宣称可续接。 */
    }
    throw new AgentRunError(
      checkpointFailure?.message ??
        (error instanceof Error ? error.message : "Agent 运行失败"),
      canContinue && !checkpointFailure && !signal.aborted,
    );
  } finally {
    signal.removeEventListener("abort", stop);
    unsubscribe();
    session.dispose();
  }
}
