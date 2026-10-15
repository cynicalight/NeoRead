import { expect, it } from "vitest";
import { chatRows } from "./AssistantPanel";
import type { ChatSnapshot, PendingAnswer } from "./chat-session";
it("keeps local user/answer row identity during persistence replacement and the next request", () => {
  const pending: PendingAnswer = {
    key: "request-1",
    content: "answer",
    phase: "syncing",
    notice: "",
    fallback: "",
    input: {
      provider: "codex",
      prompt: "question",
      context: "",
      readingLocation: { type: "pdf", page: 5 },
      references: [],
      attachments: [],
    },
    controller: new AbortController(),
  };
  const state: ChatSnapshot = {
    messages: [],
    messageKeys: {},
    archived: [],
    busy: false,
    loaded: true,
    pending,
  };
  expect(chatRows(state).map((row) => row.key)).toEqual([
    "request-1-user",
    "request-1",
  ]);
  expect(chatRows(state)[0].message?.readingLocation).toEqual({
    type: "pdf",
    page: 5,
  });
  state.messages = [
    {
      id: "u",
      documentId: "doc",
      role: "user",
      content: "question",
      context: "",
      createdAt: "",
    },
    {
      id: "a",
      documentId: "doc",
      role: "assistant",
      content: "answer",
      context: "",
      createdAt: "",
    },
  ];
  state.messageKeys = { u: "request-1-user", a: "request-1" };
  state.pending = { ...pending, savedId: "a", phase: "saved" };
  expect(chatRows(state).map((row) => row.key)).toEqual([
    "request-1-user",
    "request-1",
  ]);
  state.pending = { ...pending, key: "request-2" };
  expect(chatRows(state).map((row) => row.key)).toEqual([
    "request-1-user",
    "request-1",
    "request-2-user",
    "request-2",
  ]);
});
