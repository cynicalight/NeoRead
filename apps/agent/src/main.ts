import {
  authOrigin,
  connectionModels,
  loginConnection,
  type PiConnection,
} from "./connections";
import { createInterface } from "node:readline";
import {
  runAgent,
  AgentRunError,
  type AgentRequest,
  type ToolResult,
} from "./runtime";

function upstreamError(status: number) {
  switch (status) {
    case 401:
      return "authentication";
    case 402:
      return "billing";
    case 403:
      return "permission";
    case 408:
    case 504:
      return "timeout";
    case 429:
      return "limit";
    default:
      return status >= 400 ? "upstream" : "";
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const controller = new AbortController();
const pending = new Map<
  string,
  { resolve: (value: ToolResult) => void; reject: (error: Error) => void }
>();
const checkpointAcks = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void }
>();
let checkpointCounter = 0;
let loginInput: ((value: string) => void) | undefined;
let started = false,
  runId = "";
const send = (event: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify({ version: 1, runId, ...event }) + "\n");
const close = () => {
  controller.abort();
  for (const entry of pending.values()) entry.reject(new Error("运行已取消"));
  pending.clear();
  for (const ack of checkpointAcks.values())
    ack.reject(new Error("运行已取消"));
  checkpointAcks.clear();
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
lines.on("close", close);
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if ((message.type === "login" || message.type === "catalog") && !started) {
      started = true;
      const input = message.input as {
        runId: string;
        connection: PiConnection;
        deviceId: string;
      };
      runId = input.runId;
      const fetch = globalThis.fetch;
      let errorCode = "";
      globalThis.fetch = async (url, options) => {
        try {
          const response = await fetch(url, options);
          errorCode = upstreamError(response.status);
          return response;
        } catch (error) {
          errorCode = "network";
          throw error;
        }
      };
      const operation =
        message.type === "catalog"
          ? connectionModels(input.connection, controller.signal).then(
              (models) => ({ models }),
            )
          : loginConnection(input.connection, input.deviceId, {
              signal: controller.signal,
              notify: (event) => {
                if (event.type === "auth_url")
                  send({ type: "auth_url", url: event.url });
                if (event.type === "device_code")
                  send({
                    type: "device_code",
                    url: event.verificationUri,
                    code: event.userCode,
                  });
              },
              prompt: (prompt) => {
                if (prompt.type === "select" && prompt.options[0])
                  return Promise.resolve(prompt.options[0].id);
                if (prompt.type !== "manual_code")
                  return Promise.reject(new Error("不支持的授权提示"));
                const signal = prompt.signal ?? controller.signal;
                return new Promise<string>((resolve, reject) => {
                  if (signal.aborted) return reject(signal.reason);
                  const cancel = () => {
                    loginInput = undefined;
                    reject(signal.reason);
                  };
                  loginInput = (value) => {
                    signal.removeEventListener("abort", cancel);
                    loginInput = undefined;
                    resolve(value);
                  };
                  signal.addEventListener("abort", cancel, { once: true });
                  send({ type: "manual_code" });
                });
              },
            }).then(() => ({}));
      void operation
        .then((result) => send({ type: "complete", ...result }))
        .catch(() => {
          send({ type: "error", errorCode });
          process.exitCode = 1;
        })
        .finally(() => {
          lines.close();
          process.stdin.destroy();
        });
    } else if (message.type === "start" && !started) {
      started = true;
      const input = message.input as AgentRequest;
      runId = input.runId;
      // API keys must never follow redirects or escape the configured origin.
      const upstream = new URL(input.model.baseUrl);
      if (input.endpoint && new URL(input.endpoint).origin !== upstream.origin)
        throw new Error("模型端点不匹配");
      const fetch = globalThis.fetch;
      const cwd = `\n<cwd>\n${process.cwd()}\n</cwd>`;
      let errorCode = "";
      globalThis.fetch = async (url, init) => {
        const target = new URL(url instanceof Request ? url.url : String(url));
        if (
          target.origin !== upstream.origin &&
          target.origin !== authOrigin(input.connection)
        )
          throw new Error("模型请求目标不匹配");
        if (target.origin !== upstream.origin)
          return fetch(url, { ...init, redirect: "error" });
        const headers = new Headers(
          init?.headers ?? (url instanceof Request ? url.headers : undefined),
        );
        if (!input.key && !input.connection) {
          headers.delete("authorization");
          headers.delete("x-api-key");
        }
        let body = init?.body;
        if (input.payload && typeof body === "string") {
          const payload = JSON.parse(body);
          if (typeof payload.instructions === "string")
            payload.instructions = payload.instructions
              .replace(cwd, "")
              .trimEnd();
          for (const item of payload.messages ?? payload.input ?? []) {
            if (item.role !== "system" && item.role !== "developer") continue;
            if (typeof item.content === "string")
              item.content = item.content.replace(cwd, "").trimEnd();
            else
              for (const part of item.content ?? []) {
                if (typeof part.text === "string")
                  part.text = part.text.replace(cwd, "").trimEnd();
              }
          }
          for (const part of Array.isArray(payload.system)
            ? payload.system
            : []) {
            if (typeof part.text === "string")
              part.text = part.text.replace(cwd, "").trimEnd();
          }
          for (const field of [
            "reasoning_effort",
            "reasoning",
            "thinking",
            "output_config",
            "reasoning_split",
            "max_tokens",
            "max_completion_tokens",
            "max_output_tokens",
          ])
            delete payload[field];
          Object.assign(payload, input.payload);
          if (
            !input.connection &&
            input.model.api === "openai-completions" &&
            Array.isArray(payload.messages)
          ) {
            for (const message of payload.messages) {
              if (
                message.role !== "user" ||
                !Array.isArray(message.content) ||
                message.content.length !== 1
              )
                continue;
              const [part] = message.content;
              if (part.type === "text" && typeof part.text === "string")
                message.content = part.text;
            }
          }
          if (input.connection?.provider === "openai") {
            payload.store = false;
            payload.stream = true;
            for (const field of [
              "background",
              "conversation",
              "max_output_tokens",
              "max_tool_calls",
              "metadata",
              "moderation",
              "multi_agent",
              "prompt",
              "prompt_cache_retention",
              "safety_identifier",
              "temperature",
              "top_logprobs",
              "top_p",
              "truncation",
              "user",
              "previous_response_id",
            ])
              delete payload[field];
          }
          body = JSON.stringify(payload);
        }
        const response = await fetch(input.endpoint || url, {
          ...init,
          body,
          headers,
          redirect: "error",
        });
        errorCode = upstreamError(response.status);
        return response;
      };
      void runAgent(
        input,
        send,
        async (name, args, signal, toolCallID) => {
          signal?.throwIfAborted();
          if (!toolCallID || pending.has(toolCallID))
            throw new Error("工具调用编号无效");
          const id = toolCallID;
          return new Promise<ToolResult>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            send({ type: "tool", id, name, args });
          });
        },
        controller.signal,
        input.durableCheckpoints
          ? async (checkpoint) => {
              controller.signal.throwIfAborted();
              const id = `checkpoint-${++checkpointCounter}`;
              await new Promise<void>((resolve, reject) => {
                checkpointAcks.set(id, { resolve, reject });
                send({ type: "checkpoint", id, ...checkpoint });
              });
            }
          : undefined,
      )
        .then((result) => {
          send({ type: "complete", ...result });
        })
        .catch((error: unknown) => {
          const text =
            error instanceof Error ? error.message : "Agent 运行失败";
          send({
            type: "error",
            errorCode,
            canContinue: error instanceof AgentRunError && error.canContinue,
            message: input.key
              ? text.split(input.key).join("[redacted]")
              : text,
          });
          process.exitCode = 1;
        })
        .finally(() => {
          lines.close();
          process.stdin.destroy();
        });
    } else if (
      message.type === "authInput" &&
      message.runId === runId &&
      typeof message.value === "string"
    ) {
      loginInput?.(message.value);
    } else if (message.type === "checkpointAck" && message.runId === runId) {
      const ack = checkpointAcks.get(message.id);
      if (!ack) throw new Error("进度确认编号不匹配");
      checkpointAcks.delete(message.id);
      if (message.error) ack.reject(new Error("会话进度保存失败"));
      else ack.resolve();
    } else if (message.type === "toolResult" && message.runId === runId) {
      const entry = pending.get(message.id);
      if (!entry) throw new Error("工具结果编号不匹配");
      pending.delete(message.id);
      entry.resolve({ content: message.content, details: undefined });
    } else if (message.type === "cancel" && message.runId === runId) close();
    else throw new Error("不兼容的 Agent 消息");
  } catch {
    send({ type: "error", message: "Agent 消息格式无效" });
    process.exitCode = 1;
    close();
    lines.close();
    process.stdin.destroy();
  }
});
