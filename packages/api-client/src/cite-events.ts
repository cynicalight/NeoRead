export type CiteEvent =
  | {
      type: "command";
      transaction: string;
      command: string;
      documentId: string;
      client: string;
    }
  | { type: "focus" }
  | { type: "aborted"; transaction: string };

function isCiteEvent(value: unknown): value is CiteEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type === "focus") return true;
  if (v.type === "aborted") return typeof v.transaction === "string";
  return (
    v.type === "command" &&
    typeof v.transaction === "string" &&
    typeof v.command === "string" &&
    typeof v.documentId === "string" &&
    typeof v.client === "string"
  );
}

/** Commands from the Word and WPS plugins, until the stream closes. */
export async function consumeCiteEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: CiteEvent) => void,
) {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("");
        if (!data) continue;
        const value: unknown = JSON.parse(data);
        if (isCiteEvent(value)) onEvent(value);
      }
      if (buffer.length > 1 << 20) throw new Error("引用事件超出大小限制");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
