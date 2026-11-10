import type { ToolActivity } from "@neoread/core";
/** Decoded frozen wire contract. No provider-native events enter the renderer. */
export type ChatStreamEvent =
  | { event: "tool"; data: ToolActivity }
  | {
      event: "activity";
      data: {
        phase: "indexing" | "reading" | "writing";
        message: string;
        tool?: string;
      };
    }
  | { event: "status"; data: { status: "reading" | "reading-image" } }
  | { event: "delta"; data: { text: string } }
  | { event: "reasoning"; data: { text: string } }
  | { event: "draft"; data: { text: string; reset: boolean } }
  | { event: "fallback"; data: { message: string } }
  | { event: "error"; data: { error: string } }
  | { event: "done"; data: { ok: true } };
export class ChatStreamError extends Error {
  constructor(
    message: string,
    public readonly kind: "protocol" | "unconfirmed" | "provider",
  ) {
    super(message);
  }
}
const known = new Set([
  "status",
  "activity",
  "tool",
  "delta",
  "reasoning",
  "draft",
  "fallback",
  "error",
  "done",
]);
export function decodeFrame(frame: string): ChatStreamEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (!known.has(event)) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    throw new ChatStreamError("AI 事件格式无效，完成状态未确认", "protocol");
  }
  if (!parsed || typeof parsed !== "object")
    throw new ChatStreamError("AI 事件数据无效", "protocol");
  const valid =
    event === "tool"
      ? typeof parsed.id === "string" &&
        parsed.id.length <= 160 &&
        ["search", "web", "tool"].includes(String(parsed.kind)) &&
        typeof parsed.tool === "string" &&
        typeof parsed.title === "string" &&
        [
          "running",
          "completed",
          "failed",
          "cancelled",
          "unavailable",
          "deferred",
        ].includes(String(parsed.status)) &&
        typeof parsed.startedAt === "string" &&
        ["target", "url", "detail", "finishedAt"].every(
          (k) => parsed[k] === undefined || typeof parsed[k] === "string",
        )
      : event === "activity"
        ? ["indexing", "reading", "writing"].includes(String(parsed.phase)) &&
          typeof parsed.message === "string" &&
          (parsed.tool === undefined || typeof parsed.tool === "string")
        : event === "draft"
          ? typeof parsed.text === "string" && typeof parsed.reset === "boolean"
          : event === "delta" || event === "reasoning"
            ? typeof parsed.text === "string"
            : event === "fallback"
              ? typeof parsed.message === "string"
              : event === "error"
                ? typeof parsed.error === "string"
                : event === "done"
                  ? parsed.ok === true
                  : parsed.status === "reading" ||
                    parsed.status === "reading-image";
  if (!valid)
    throw new ChatStreamError("AI 事件字段无效，完成状态未确认", "protocol");
  return { event, data: parsed } as ChatStreamEvent;
}
export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: ChatStreamEvent) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "",
    frame = "",
    cr = false,
    terminal = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const dispatchLine = () => {
    if (line) {
      frame += line + "\n";
      line = "";
      return;
    }
    const event = decodeFrame(frame);
    frame = "";
    if (!event) return;
    terminal = event.event === "done" || event.event === "error";
    onEvent(event);
    if (event.event === "error")
      throw new ChatStreamError(event.data.error, "provider");
  };
  const feed = (text: string) => {
    for (const char of text) {
      if (terminal) break;
      if (cr && char === "\n") {
        cr = false;
        continue;
      }
      cr = false;
      if (char === "\r" || char === "\n") {
        dispatchLine();
        cr = char === "\r";
      } else line += char;
    }
  };
  try {
    signal.throwIfAborted();
    while (!terminal) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        feed(decoder.decode());
        break;
      }
      feed(decoder.decode(chunk.value, { stream: true }));
    }
    if (!terminal)
      throw new ChatStreamError("AI 连接中断，完成状态未确认", "unconfirmed");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
