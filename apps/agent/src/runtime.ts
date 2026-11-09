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
) {
  if (input.version !== 1 || !input.runId || !input.model || !input.prompt)
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
    api:
      model.api === "anthropic-messages"
        ? anthropicMessagesApi()
        : model.api === "openai-responses"
          ? responsesApi()
          : openAICompletionsApi(),
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
    execute: async (id, args, abort) => callTool(tool.name, args, abort, id),
  }));
  const manager = SessionManager.inMemory(process.cwd(), {}, input.entries);
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: manager,
    thinkingLevel: input.effort,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false, provider: { maxRetries: 0 } },
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
  const maxToolRounds = 255;
  let rounds = 0;
  const stop = () => {
    void session.abort();
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const unsubscribe = session.subscribe((event) => {
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
    await session.prompt(input.prompt, {
      images: input.images,
      expandPromptTemplates: false,
    });
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
    const entries = JSON.parse(
      JSON.stringify([manager.getHeader(), ...manager.getEntries()]),
    ) as FileEntry[];
    return { text, entries };
  } finally {
    signal.removeEventListener("abort", stop);
    unsubscribe();
    session.dispose();
  }
}
