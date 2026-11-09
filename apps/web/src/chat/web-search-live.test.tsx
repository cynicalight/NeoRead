// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@neoread/core";
import type { ChatSession } from "./chat-session";

type LiveCase = {
  provider: string;
  scenario: string;
  status: string;
  messages: Message[];
  events: { event: string; data: unknown }[];
};
const reportPath = process.env.NEOREAD_TEST_WEB_REPORT;
const cases: LiveCase[] = reportPath
  ? JSON.parse(readFileSync(reportPath, "utf8"))
  : [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) =>
    clearTimeout(id),
  );
});
afterEach(() => vi.unstubAllGlobals());
for (const provider of ["codex", "api"])
  for (const scenario of ["search-and-read", "cancel"]) {
    it.skipIf(!reportPath)(
      `renders actual ${provider} ${scenario} records from a live Reader run`,
      async () => {
        const [
          { act },
          { createRoot },
          { ChatSession },
          { ToolActivities },
          { decodeFrame },
        ] = await Promise.all([
          import("react"),
          import("react-dom/client"),
          import("./chat-session"),
          import("./ToolActivities"),
          import("../../../../packages/api-client/src/chat-stream"),
        ]);
        const recorded = cases.find(
          (c) => c.provider === provider && c.scenario === scenario,
        );
        expect(recorded).toBeDefined();
        const source = recorded!;
        const user = source.messages.find((m) => m.role === "user")!;
        let history: Message[] = [];
        let session: ChatSession;
        let cancelled = false;
        const observed: string[] = [];
        session = new ChatSession(
          user.documentId,
          {
            messages: async () => history,
            cancel: async () => {},
            stream: async (_id, input, _signal, emit) => {
              // Re-map only the replay's generated question identity. Execution events,
              // states, links and saved answer fields all come from the live run.
              for (const frame of source.events) {
                const event = decodeFrame(
                  `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}`,
                );
                if (!event) continue;
                emit(event);
                if (event.event === "tool") {
                  observed.push(event.data.status);
                  if (
                    scenario === "cancel" &&
                    event.data.status === "running" &&
                    !cancelled
                  ) {
                    cancelled = true;
                    session.cancel();
                  }
                }
              }
              history = source.messages.map((m) =>
                m.role === "user" ? { ...m, id: input.userMessageId! } : m,
              );
            },
          },
          user.sessionId,
        );
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        try {
          await session.load();
          await session.send({
            provider,
            prompt: user.content,
            context: user.context ?? "",
            references: user.references ?? [],
            attachments: user.attachments ?? [],
            webSearch: true,
          });
          const state = session.getSnapshot();
          const answer = state.messages.find((m) => m.role === "assistant");
          expect(observed).toContain("running");
          await act(async () =>
            root.render(
              <ToolActivities
                tools={state.pending?.tools}
                sources={answer?.webSources}
              />,
            ),
          );
          const toggle = host.querySelector("button")!;
          expect(toggle).not.toBeNull();
          await act(async () => toggle.click());
          expect(host.textContent).toContain("搜索网页");
          if (scenario === "search-and-read") {
            expect(source.status).toBe("completed");
            expect(state.pending?.phase).toBe("saved");
            expect(observed).toContain("completed");
            expect(host.textContent).toContain("读取网页");
            expect(host.textContent).not.toContain("已完成");
            expect(
              host.querySelector(
                'a[href="https://api-docs.deepseek.com/zh-cn/guides/search/"]',
              ),
            ).not.toBeNull();
            expect(state.pending?.tools).toEqual(answer?.tools);
          } else {
            expect(source.status).toBe("cancelled");
            expect(cancelled).toBe(true);
            expect(observed).toContain("cancelled");
            expect(host.textContent).toContain("已取消");
            expect(answer).toBeUndefined();
            expect(state.pending?.phase).not.toBe("saved");
          }
        } finally {
          session.dispose();
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );
  }
