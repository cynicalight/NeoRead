import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { setTimeout as delay } from "node:timers/promises";
import {
  consumeCiteEvents,
  type CiteEvent,
} from "../../../packages/api-client/src/cite-events";
import { createCitationWindow } from "./citation-window";

type Command = Extract<CiteEvent, { type: "command" }>;
type Session = {
  command: Command;
  window?: BrowserWindow;
  ready: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

/** The main process owns the subscription; a renderer exists only for a command. */
export function startCitationService(options: {
  url: string;
  token: string;
  preload: string;
  record: (event: string) => void;
}) {
  const controller = new AbortController();
  let current: Session | undefined;
  const headers = { Authorization: `Bearer ${options.token}` };
  const destroy = (session: Session) => {
    clearTimeout(session.timer);
    if (current === session) current = undefined;
    if (session.window && !session.window.isDestroyed())
      session.window.destroy();
  };
  const complete = async (session: Session, error: string) => {
    // Detach before awaiting: a new command may arrive during completion.
    destroy(session);
    try {
      const response = await fetch(
        `${options.url}/api/cite/transactions/${encodeURIComponent(session.command.transaction)}/complete`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ activate: true, error }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok && response.status !== 410)
        throw new Error("completion failed");
      options.record("citation.completed");
    } catch {
      options.record("citation.complete_failed");
      // Losing the sole event subscriber also aborts the server transaction.
      if (!current) stream?.abort();
    }
  };
  const fail = (session: Session, reason: string) => {
    if (current !== session) return;
    options.record(reason);
    void complete(session, "NeoRead 引用窗口已关闭或无法加载，请重试");
  };
  const own = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    const session = current;
    if (
      !session?.window ||
      event.sender !== session.window.webContents ||
      event.senderFrame !== session.window.webContents.mainFrame
    )
      throw new Error("Invalid sender");
    return session;
  };
  const ready = (event: IpcMainEvent) => {
    let session: Session;
    try {
      session = own(event);
    } catch {
      return;
    }
    if (session.ready) return;
    session.ready = true;
    clearTimeout(session.timer);
    session.window!.webContents.send("neoread:citation-event", session.command);
  };
  ipcMain.on("neoread:citation-ready", ready);
  ipcMain.handle(
    "neoread:citation-complete",
    (event, transaction: unknown, error: unknown) => {
      const session = own(event);
      if (
        transaction !== session.command.transaction ||
        typeof error !== "string"
      )
        throw new Error("Invalid completion");
      // Let invoke reply before destroying the sender. The transaction is still
      // completed by the main process even when its renderer is already gone.
      setImmediate(() => {
        if (current === session) void complete(session, error);
      });
    },
  );
  const onEvent = (event: CiteEvent) => {
    if (controller.signal.aborted) return;
    if (event.type === "focus") {
      if (current?.ready)
        current.window?.webContents.send("neoread:citation-event", event);
      return;
    }
    if (event.type === "aborted") {
      if (current?.command.transaction === event.transaction) destroy(current);
      return;
    }
    if (current?.command.transaction === event.transaction) return;
    if (current) destroy(current);
    const session: Session = { command: event, ready: false };
    current = session;
    session.timer = setTimeout(
      () => fail(session, "citation.window_timeout"),
      15000,
    );
    try {
      session.window = createCitationWindow({
        ...options,
        onFailure: () => fail(session, "citation.window_failed"),
      });
      session.window.once("closed", () =>
        fail(session, "citation.window_closed"),
      );
      session.window.webContents.once("render-process-gone", () =>
        fail(session, "citation.renderer_exited"),
      );
      options.record("citation.window_created");
    } catch {
      fail(session, "citation.window_failed");
    }
  };
  let stream: AbortController | undefined;
  let disconnected = false;
  void (async () => {
    while (!controller.signal.aborted) {
      stream = new AbortController();
      try {
        const signal = AbortSignal.any([controller.signal, stream.signal]);
        const response = await fetch(`${options.url}/api/cite/events`, {
          headers,
          signal,
        });
        if (!response.ok || !response.body)
          throw new Error("citation stream unavailable");
        if (disconnected) options.record("citation.stream_reconnected");
        disconnected = false;
        await consumeCiteEvents(response.body, signal, onEvent);
      } catch {
        // The same cleanup applies to EOF, failed requests and cancellation.
      }
      if (!controller.signal.aborted && !disconnected) {
        options.record("citation.stream_disconnected");
        disconnected = true;
      }
      // The server aborts transactions when the subscription disconnects.
      if (current) destroy(current);
      if (controller.signal.aborted) break;
      await delay(1000, undefined, { signal: controller.signal }).catch(
        () => {},
      );
    }
  })();
  return {
    stop() {
      controller.abort();
      if (current) destroy(current);
      ipcMain.removeListener("neoread:citation-ready", ready);
      ipcMain.removeHandler("neoread:citation-complete");
    },
  };
}
