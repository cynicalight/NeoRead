// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@neoread/core";
import { ChatSession, type ChatTransport } from "./chat-session";
import { QuestionActions } from "./QuestionActions";

let host: HTMLDivElement, root: Root, session: ChatSession;
const getAnimations = Element.prototype.getAnimations;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.getAnimations = () => [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  session?.dispose();
  host.remove();
  Element.prototype.getAnimations = getAnimations;
  vi.unstubAllGlobals();
});
const question: Message = {
  id: "q",
  documentId: "doc",
  role: "user",
  content: "原问题",
  createdAt: "2021-02-03",
  references: [{ text: "引用", location: { type: "pdf", page: 3 } }],
  attachments: [{ id: "image", page: 3, label: "chart" }],
};
const after: Message = {
  id: "answer",
  documentId: "doc",
  role: "assistant",
  content: "回答",
  createdAt: "2021-02-03",
};
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const textButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  )!;

async function render(
  changeMessage: NonNullable<ChatTransport["changeMessage"]>,
  disabled = false,
) {
  session = new ChatSession("doc", {
    messages: async () => [question, after],
    changeMessage,
    stream: vi.fn(),
  });
  await session.load();
  const onRegenerate = vi.fn(),
    onWithdraw = vi.fn();
  await act(async () =>
    root.render(
      <QuestionActions
        session={session}
        message={question}
        following={3}
        disabled={disabled}
        onRegenerate={onRegenerate}
        onWithdraw={onWithdraw}
      />,
    ),
  );
  return { onRegenerate, onWithdraw };
}

it("confirms the affected messages before editing and preserves sources for regeneration", async () => {
  const change = vi.fn<NonNullable<ChatTransport["changeMessage"]>>(
    async (_id, patch) => ({
      message: { ...question, content: patch.content! },
      messages: [{ ...question, content: patch.content! }],
    }),
  );
  const { onRegenerate, onWithdraw } = await render(change);
  await act(async () => button("编辑问题").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "之后的 3 条消息",
  );
  expect(change).not.toHaveBeenCalled();
  const input = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="问题内容"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "编辑后问题 $H'$");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => textButton("保存并重新生成").click());
  expect(change).toHaveBeenCalledWith("q", {
    expectedLastMessageId: "answer",
    expectedContent: "原问题",
    content: "编辑后问题 $H'$",
  });
  expect(onRegenerate).toHaveBeenCalledOnce();
  expect(onWithdraw).not.toHaveBeenCalled();
  expect(session.getSnapshot().pending?.input.references).toEqual(
    question.references,
  );
  expect(session.getSnapshot().pending?.input.attachments).toEqual(
    question.attachments,
  );
});

it("returns a withdrawn question to the composer only after successful persistence", async () => {
  const change = vi
    .fn<NonNullable<ChatTransport["changeMessage"]>>()
    .mockRejectedValueOnce(new Error("保存失败"))
    .mockResolvedValue({ message: question, messages: [] });
  const { onWithdraw, onRegenerate } = await render(change);
  await act(async () => button("撤回问题").click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "之后的 3 条消息",
  );
  expect(change).not.toHaveBeenCalled();
  await act(async () => textButton("确认撤回").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "保存失败",
  );
  expect(onWithdraw).not.toHaveBeenCalled();
  expect(session.getSnapshot().messages).toEqual([question, after]);
  await act(async () => textButton("确认撤回").click());
  expect(onWithdraw).toHaveBeenCalledWith(question);
  expect(onRegenerate).not.toHaveBeenCalled();
  expect(session.getSnapshot().messages).toEqual([]);
});

it("disables editing and withdrawal while generation or another operation is active", async () => {
  const change = vi.fn<NonNullable<ChatTransport["changeMessage"]>>();
  await render(change, true);
  expect(button("编辑问题").disabled).toBe(true);
  expect(button("撤回问题").disabled).toBe(true);
  await act(async () => {
    button("编辑问题").click();
    button("撤回问题").click();
  });
  expect(
    document.querySelector('[role="dialog"], [role="alertdialog"]'),
  ).toBeNull();
  expect(change).not.toHaveBeenCalled();
});
