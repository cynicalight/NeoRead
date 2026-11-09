import { createInterface } from "node:readline";
import { runAgent, type AgentRequest, type ToolResult } from "./runtime";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const controller = new AbortController();
const pending = new Map<
  string,
  { resolve: (value: ToolResult) => void; reject: (error: Error) => void }
>();
let started = false,
  runId = "";
const send = (event: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify({ version: 1, runId, ...event }) + "\n");
const close = () => {
  controller.abort();
  for (const entry of pending.values()) entry.reject(new Error("运行已取消"));
  pending.clear();
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
lines.on("close", close);
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message.type === "start" && !started) {
      started = true;
      const input = message.input as AgentRequest;
      runId = input.runId;
      // API keys must never follow redirects or escape the configured origin.
      const upstream = new URL(input.model.baseUrl);
      if (input.endpoint && new URL(input.endpoint).origin !== upstream.origin)
        throw new Error("模型端点不匹配");
      const fetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const target = new URL(url instanceof Request ? url.url : String(url));
        if (target.origin !== upstream.origin)
          throw new Error("模型请求目标不匹配");
        const headers = new Headers(
          init?.headers ?? (url instanceof Request ? url.headers : undefined),
        );
        if (!input.key) {
          headers.delete("authorization");
          headers.delete("x-api-key");
        }
        let body = init?.body;
        if (input.payload && typeof body === "string") {
          const payload = JSON.parse(body);
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
          body = JSON.stringify(payload);
        }
        return fetch(input.endpoint || url, {
          ...init,
          body,
          headers,
          redirect: "error",
        });
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
      )
        .then((result) => {
          send({ type: "complete", ...result });
        })
        .catch((error: unknown) => {
          const text =
            error instanceof Error ? error.message : "Agent 运行失败";
          send({
            type: "error",
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
