// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message, ReaderAdapter, SourceReference } from "@neoread/core";
import { api, type ChatStreamEvent } from "@neoread/api";
import { useReaderStore } from "../store";
import { LiveSourceReferences, SourceReferences } from "../SourceReferences";
import { AssistantPanel } from "./AssistantPanel";
import { ChatSession, type ChatInput } from "./chat-session";
import { ChatCitationNavigation } from "./citations";
import { MessageMarkdown } from "./MessageMarkdown";

vi.mock("@neoread/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@neoread/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      liveReadSource: vi.fn(),
      validateEvidence: vi.fn(),
    },
  };
});
vi.mock("../ProviderIdentity", () => ({ ProviderGlyph: () => null }));

let root: Root, host: HTMLDivElement, session: ChatSession | undefined;
let emit: (event: ChatStreamEvent) => void;
let finish: () => void;
let history: Message[];
let asked: ChatInput;
const originalGetAnimations = Element.prototype.getAnimations;
const location = { type: "epub" as const, href: "c.xhtml", progression: 0.4 };
const reference: SourceReference = {
  sourceId: "S1",
  text: "read excerpt",
  location,
  kind: "section",
};
const navigate = vi.fn(async () => {});
const adapter = { flashReference: vi.fn() } as unknown as ReaderAdapter;

beforeEach(() => {
  Element.prototype.getAnimations = () => [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
    setTimeout(() => fn(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  useReaderStore.getState().setTheme({ reducedMotion: true });
  vi.mocked(api.liveReadSource).mockReset();
  vi.mocked(api.validateEvidence).mockReset();
  navigate.mockClear();
  vi.mocked(adapter.flashReference!).mockClear();
  history = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  session?.dispose();
  session = undefined;
  host.remove();
  useReaderStore.getState().setTheme({ reducedMotion: false });
  vi.unstubAllGlobals();
  Element.prototype.getAnimations = originalGetAnimations;
});

const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const send = (event: ChatStreamEvent) =>
  act(async () => {
    emit(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const readSources = (attemptId: string, keys: string[], runId = "run") =>
  send({ event: "read_sources", data: { runId, attemptId, keys } });
const jump = (key: string) =>
  host.querySelector<HTMLButtonElement>(
    `button[aria-label="跳转到原文段落 ${key}"]`,
  );
const answerText = () =>
  host.querySelector(".chat-message.assistant .message-markdown")
    ?.textContent ?? "";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function start() {
  session = new ChatSession(
    "doc",
    {
      messages: async () => history,
      stream: async (_id, input, _signal, onEvent) => {
        asked = input;
        emit = onEvent;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    },
    "session",
  );
  await session.load();
  const chat = session;
  await act(async () =>
    root.render(
      <AssistantPanel
        session={chat}
        empty={null}
        extras={() => null}
        references={() => null}
        onRegenerate={() => {}}
        renderAnswer={(message, content) => (
          <SourceReferences
            key={message.id}
            message={message}
            toc={[]}
            adapter={adapter}
            onNavigate={navigate}
          >
            {content}
          </SourceReferences>
        )}
        renderPendingAnswer={(answer, content) => (
          <LiveSourceReferences
            documentId="doc"
            sessionId={chat.sessionId}
            sources={answer.readSources}
            adapter={adapter}
            onNavigate={navigate}
          >
            {content}
          </LiveSourceReferences>
        )}
      />,
    ),
  );
  void chat.send({
    provider: "codex",
    prompt: "question",
    context: "",
    references: [],
    attachments: [],
  });
  await tick();
  await tick();
}

it("links a closed streamed citation only after this attempt has read it", async () => {
  await start();
  await readSources("a1", []);
  await send({ event: "delta", data: { text: "依据 [S" } });
  expect(answerText()).toContain("依据");
  await readSources("a1", ["S1", "c41151675761-7"]);
  // An unclosed citation stays ordinary text, even when remend completes it
  // into a placeholder link for a key this attempt has read.
  await send({ event: "delta", data: { text: "1" } });
  expect(answerText()).toContain("S1");
  expect(jump("S1")).toBeNull();
  await send({ event: "delta", data: { text: "] 与 [S2] (see [x" } });
  expect(jump("S1")).not.toBeNull();
  // A key this attempt never read, and unfinished prose, stay readable.
  expect(jump("S2")).toBeNull();
  expect(answerText()).toContain("[S2] (see");
  expect(answerText()).toContain("x");

  vi.mocked(api.liveReadSource).mockResolvedValueOnce(reference);
  await act(async () => jump("S1")!.click());
  expect(api.liveReadSource).toHaveBeenCalledExactlyOnceWith(
    "doc",
    "session",
    "run",
    "a1",
    "S1",
    expect.any(AbortSignal),
  );
  expect(navigate).toHaveBeenCalledExactlyOnceWith(location, "read excerpt");
  expect(adapter.flashReference).toHaveBeenCalledExactlyOnceWith(
    location,
    "read excerpt",
  );
});

it("reports a failed check without navigating", async () => {
  await start();
  await readSources("a1", ["S1"]);
  await send({ event: "delta", data: { text: "依据 [S1]。" } });
  vi.mocked(api.liveReadSource).mockRejectedValueOnce(
    new Error("原文版本已更新"),
  );
  await act(async () => jump("S1")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "原文版本已更新",
  );
  expect(navigate).not.toHaveBeenCalled();
});

it("revokes live links when the answer fails", async () => {
  await start();
  await readSources("a1", ["S1"]);
  await send({ event: "delta", data: { text: "依据 [S1]。" } });
  expect(jump("S1")).not.toBeNull();
  await send({ event: "error", data: { error: "模型中断" } });
  expect(jump("S1")).toBeNull();
  expect(answerText()).toContain("[S1]");
});

it("revokes live links when generation is cancelled", async () => {
  await start();
  await readSources("a1", ["S1"]);
  await send({ event: "delta", data: { text: "依据 [S1]。" } });
  await act(async () => session!.cancel());
  expect(session!.getSnapshot().pending?.phase).toBe("cancelled");
  expect(jump("S1")).toBeNull();
});

it("drops a late result after a new attempt or a fallback", async () => {
  await start();
  await readSources("a1", ["S1"]);
  await send({ event: "delta", data: { text: "依据 [S1]。" } });
  const late = deferred<SourceReference>();
  vi.mocked(api.liveReadSource).mockReturnValueOnce(late.promise);
  await act(async () => jump("S1")!.click());
  const signal = vi.mocked(api.liveReadSource).mock.calls[0][5]!;
  await readSources("a2", []);
  expect(signal.aborted).toBe(true);
  expect(jump("S1")).toBeNull();
  await act(async () => late.resolve(reference));
  expect(navigate).not.toHaveBeenCalled();

  await readSources("a2", ["S1"]);
  expect(jump("S1")).not.toBeNull();
  await send({ event: "fallback", data: { message: "切换模型" } });
  expect(jump("S1")).toBeNull();
});

it("keeps the read-source set stable for repeats and replaces it per attempt", async () => {
  await start();
  await readSources("a1", ["S1"]);
  const first = session!.getSnapshot().pending!.readSources!;
  await readSources("a1", ["S1"]);
  await send({ event: "delta", data: { text: "x" } });
  expect(session!.getSnapshot().pending!.readSources).toBe(first);
  await readSources("a1", ["S2", "S1"]);
  expect(session!.getSnapshot().pending!.readSources!.keys).toEqual([
    "S1",
    "S2",
  ]);
  await readSources("a2", []);
  expect(session!.getSnapshot().pending!.readSources).toEqual({
    runId: "run",
    attemptId: "a2",
    keys: [],
  });
});

it("switches to saved evidence once the answer is saved, dropping a live click", async () => {
  await start();
  await readSources("a1", ["S1"]);
  await send({ event: "delta", data: { text: "依据 [S1]。" } });
  const late = deferred<SourceReference>();
  vi.mocked(api.liveReadSource).mockReturnValueOnce(late.promise);
  await act(async () => jump("S1")!.click());
  history = [
    {
      id: asked.userMessageId!,
      documentId: "doc",
      sessionId: "session",
      role: "user",
      content: "question",
      createdAt: "2026-11-21",
    },
    {
      id: "answer",
      documentId: "doc",
      sessionId: "session",
      role: "assistant",
      content: "依据 [S1]。",
      references: [reference],
      createdAt: "2026-11-21",
    },
  ];
  await send({ event: "done", data: { ok: true } });
  await act(async () => finish());
  await tick();
  expect(session!.getSnapshot().pending?.phase).toBe("saved");
  await act(async () => late.resolve(reference));
  expect(navigate).not.toHaveBeenCalled();

  vi.mocked(api.validateEvidence).mockResolvedValueOnce({ valid: true });
  await act(async () => jump("S1")!.click());
  expect(api.validateEvidence).toHaveBeenCalledExactlyOnceWith(
    "doc",
    "answer",
    "S1",
  );
  expect(api.liveReadSource).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledExactlyOnceWith(location, "read excerpt");
});

it("refreshes Streamdown's cached blocks without linking unclosed citations", async () => {
  useReaderStore.getState().setTheme({ reducedMotion: false });
  const render = (content: string, sourceIds: string[]) =>
    act(async () =>
      root.render(
        <ChatCitationNavigation.Provider
          value={{ sourceIds, navigate: () => {} }}
        >
          <MessageMarkdown content={content} generating />
        </ChatCitationNavigation.Provider>,
      ),
    );
  await render("第一段 [S1]。\n\n第二段 [S1", []);
  await vi.waitFor(() => expect(host.textContent).toContain("第二段"));
  expect(host.querySelector('[data-animated="true"]')).not.toBeNull();
  expect(jump("S1")).toBeNull();
  await render("第一段 [S1]。\n\n第二段 [S1", ["S1"]);
  await vi.waitFor(() => expect(jump("S1")).not.toBeNull());
  // Only the closed citation in the cached first block becomes an arrow.
  expect(host.querySelectorAll("button.chat-source-jump")).toHaveLength(1);
});
