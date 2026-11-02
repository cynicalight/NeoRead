import { expect, it } from "vitest";
import type { Message } from "@neoread/core";
import { restoreWithdrawnQuestion } from "./composer-draft";

it("restores withdrawn text, references and images without overwriting an unsent draft", () => {
  const reference = {
    text: "输出隐藏状态 $H'$",
    location: { type: "pdf" as const, page: 2 },
  };
  const image = { id: "figure", page: 2, label: "chart" };
  const question: Message = {
    id: "q",
    documentId: "doc",
    role: "user",
    content: "解释公式",
    createdAt: "2021-02-03",
    references: [reference],
    attachments: [image],
  };
  const restored = restoreWithdrawnQuestion(
    {
      prompt: "未发送草稿",
      quotes: [reference],
      images: [{ id: "existing", page: 1, label: "image" }, image],
    },
    question,
  );
  expect(restored).toEqual({
    prompt: "未发送草稿\n\n解释公式",
    quotes: [reference],
    images: [{ id: "existing", page: 1, label: "image" }, image],
  });
  expect(
    restoreWithdrawnQuestion({ prompt: "", quotes: [], images: [] }, question),
  ).toEqual({ prompt: question.content, quotes: [reference], images: [image] });
});
