// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "@neoread/api";
import { AssistantPanel } from "./AssistantPanel";
import { ChatSession } from "./chat-session";
const rendered = vi.hoisted(() => vi.fn());
vi.mock("./MessageMarkdown", () => ({
  MessageMarkdown: ({ content }: { content: string }) => {
    rendered(content);
    return <div>{content}</div>;
  },
}));
vi.mock("../ProviderIdentity", () => ({ ProviderGlyph: () => null }));

it("updates the streaming answer without rerendering saved answers", async () => {
  const getAnimations = Element.prototype.getAnimations;
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
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    setTimeout(callback, 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let emit!: (event: ChatStreamEvent) => void, finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session = new ChatSession("doc", {
    messages: async () => [
      {
        id: "old",
        documentId: "doc",
        role: "assistant",
        content: "saved answer",
        createdAt: "",
      },
    ],
    stream: async (_doc, _input, _signal, callback) => {
      emit = callback;
      await waiting;
    },
  });
  let running: Promise<void> | undefined;
  try {
    await session.load();
    await act(async () =>
      root.render(
        <AssistantPanel
          session={session}
          empty={null}
          extras={() => null}
          references={() => null}
          onRegenerate={() => {}}
        />,
      ),
    );
    await act(async () => {
      running = session.send({
        provider: "api",
        prompt: "next question",
        references: [],
        attachments: [],
        context: "",
      });
    });
    const before = rendered.mock.calls.filter(
      ([text]) => text === "saved answer",
    ).length;
    for (const text of ["new", " answer", " tail"]) {
      await act(async () => {
        emit({ event: "delta", data: { text } });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(
      rendered.mock.calls.filter(([text]) => text === "saved answer"),
    ).toHaveLength(before);
    expect(host.textContent).toContain("new answer tail");
  } finally {
    await act(async () => {
      finish();
      await running;
      root.unmount();
    });
    session.dispose();
    host.remove();
    vi.unstubAllGlobals();
    Element.prototype.getAnimations = getAnimations;
  }
});
