import type { ChatRun } from "@neoread/core";
import { ChatStreamError, type ChatStreamEvent } from "@neoread/api";

type RunWatcher = (
  run: ChatRun,
  signal: AbortSignal,
  emit: (event: ChatStreamEvent) => void,
) => Promise<void>;

function waitForReconnect(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Reattach only; never starts generation. The server replays this attempt from event zero. */
export async function watchRunWithReconnect(
  run: ChatRun,
  signal: AbortSignal,
  emit: (event: ChatStreamEvent) => void,
  watch: RunWatcher,
  latest: () => Promise<ChatRun | undefined>,
) {
  const accepted: string[] = [];
  let reconnects = 0;
  for (;;) {
    signal.throwIfAborted();
    let position = 0;
    let terminal = false;
    try {
      await watch(run, signal, (event) => {
        if (signal.aborted || terminal) return;
        const signature = JSON.stringify(event);
        if (position < accepted.length) {
          if (accepted[position++] !== signature)
            throw new ChatStreamError(
              "运行记录已变化，请重新读取对话。",
              "protocol",
            );
          return;
        }
        position++;
        accepted.push(signature);
        terminal = event.event === "done" || event.event === "error";
        emit(event);
      });
      if (terminal) return;
      throw new ChatStreamError("运行连接中断", "unconfirmed");
    } catch (error) {
      signal.throwIfAborted();
      if (
        terminal ||
        (error instanceof ChatStreamError && error.kind !== "unconfirmed")
      )
        throw error;
      let attached = false;
      while (reconnects < 3) {
        emit({
          event: "activity",
          data: { phase: "reading", message: "连接中断，正在重新连接…" },
        });
        await waitForReconnect(1000 * 2 ** reconnects++, signal);
        let current: ChatRun | undefined;
        try {
          current = await latest();
        } catch {
          signal.throwIfAborted();
          continue;
        }
        signal.throwIfAborted();
        if (
          !current ||
          current.id !== run.id ||
          current.documentId !== run.documentId ||
          current.sessionId !== run.sessionId ||
          current.userMessageId !== run.userMessageId
        )
          throw new ChatStreamError(
            "运行记录已变化，请重新读取对话。",
            "protocol",
          );
        run = current;
        attached = true;
        break;
      }
      if (!attached) throw error;
    }
  }
}
