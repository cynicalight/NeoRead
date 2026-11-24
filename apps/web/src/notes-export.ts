import {
  locationLabel,
  type Annotation,
  type Document,
  type DocumentChatSession,
  type Message,
} from "@neoread/core";
import { documentOrder } from "./annotations";
import { paperByline, paperLink } from "./papers/format";

type ExportPart =
  | "info"
  | "paperNote"
  | "notes"
  | "highlights"
  | "questions"
  | "bookmarks";

const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

const includes = (a: Annotation, parts: Set<ExportPart>) =>
  (a.kind === "note" && parts.has("notes")) ||
  ((a.kind === "highlight" || a.kind === "underline") &&
    parts.has("highlights")) ||
  (a.kind === "question" && parts.has("questions"));

/** Markdown for Obsidian/Notion: chosen parts, annotations in reading order. */
export function notesMarkdown(
  doc: Document,
  data: {
    annotations: Annotation[];
    messages: Message[];
    paperNote: string;
    chat?: ChatExportSession[];
  },
  chosen: ExportPart[],
  link?: (annotation: Annotation) => string,
  options: { includeTitle?: boolean } = {},
) {
  const parts = new Set(chosen);
  const out = options.includeTitle === false ? [] : [`# ${doc.title}`];
  if (parts.has("info")) {
    const info = [
      doc.metadata.translatedTitle,
      paperByline(doc),
      doc.metadata.doi && `DOI: ${doc.metadata.doi}`,
      paperLink(doc.metadata),
    ].filter(Boolean);
    if (info.length) out.push(info.map((line) => `> ${line}`).join("\n"));
  }
  if (parts.has("paperNote") && data.paperNote.trim())
    out.push("## 论文笔记", data.paperNote.trim());
  const messages = new Map(data.messages.map((m) => [m.id, m]));
  const marks = data.annotations
    .filter((a) => includes(a, parts))
    .sort(documentOrder);
  if (marks.length) {
    out.push("## 批注");
    for (const a of marks) {
      const label = {
        highlight: "高亮",
        underline: "划线",
        note: "批注",
        question: "问题",
        bookmark: "书签",
      }[a.kind];
      const heading = `### ${locationLabel(a.location)} · ${label}`;
      const target = link?.(a);
      const block = [target ? `${heading} [↗](${target})` : heading];
      if (a.quote) block.push(quote(a.quote));
      if (a.kind === "question") {
        block.push(`**问：** ${a.note.trim()}`);
        const answer = a.answerId ? messages.get(a.answerId) : undefined;
        if (answer) block.push(`**AI 答：**\n\n${answer.content.trim()}`);
        else if (a.resolved) block.push("（已解决）");
      } else if (a.note.trim()) block.push(a.note.trim());
      if (a.tags?.length) block.push(a.tags.map((tag) => `#${tag}`).join(" "));
      out.push(block.join("\n\n"));
    }
  }
  const bookmarks = parts.has("bookmarks")
    ? data.annotations.filter((a) => a.kind === "bookmark").sort(documentOrder)
    : [];
  if (bookmarks.length)
    out.push(
      "## 书签",
      bookmarks
        .map((a) => {
          const target = link?.(a);
          const label = locationLabel(a.location);
          return `- ${target ? `[${label}](${target})` : label}`;
        })
        .join("\n"),
    );
  if (data.chat?.length) {
    out.push("## Agent 对话");
    for (const session of data.chat) {
      const title = session.title.replace(/\s+/g, " ").trim();
      const date = session.createdAt.slice(0, 10);
      out.push(`### ${title}${date ? ` · ${date}` : ""}`);
      out.push(session.messages.map(chatMessageMarkdown).join("\n\n---\n\n"));
    }
  }
  return out.join("\n\n") + "\n";
}

export type ChatExportSession = Pick<
  DocumentChatSession,
  "title" | "createdAt"
> & {
  messages: Message[];
};

function chatMessageMarkdown(message: Message) {
  const content = message.content.trim();
  const out = [`**${message.role === "user" ? "我" : "Agent"}：**`, content];
  if (message.role === "assistant") {
    // The server saves validated document references used in the answer.
    for (const ref of message.references ?? []) {
      const id = ref.sourceId ?? ref.blockId;
      if (id && ref.text.trim())
        out.push(`[${id}] ${locationLabel(ref.location)}\n\n${quote(ref.text)}`);
    }
  }
  return out.join("\n\n");
}

/**
 * Annotations not yet quoted in `note`, as a Markdown list in reading order.
 * Each item links back to its place, which also marks it as quoted.
 */
export function annotationDigest(
  annotations: Annotation[],
  note: string,
  link: (annotation: Annotation) => string,
  date = new Date(),
) {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  const marks = annotations
    .filter(
      (a) =>
        a.kind !== "bookmark" &&
        (a.quote.trim() || a.note.trim()) &&
        !note.includes(link(a)),
    )
    .sort(documentOrder);
  if (!marks.length) return "";
  const lines = marks.map((a) => {
    const where = `[${locationLabel(a.location)}](${link(a)})`;
    const quoted = a.quote.trim() ? `“${flat(a.quote)}”` : "";
    if (a.kind === "question")
      return `- ${where} 问题：${flat(a.note)}${quoted ? `（关于${quoted}）` : ""}`;
    const body = a.note.trim()
      ? `\n  ${a.note.trim().replace(/\n/g, "\n  ")}`
      : "";
    return `- ${where}${quoted ? `：${quoted}` : ""}${body}`;
  });
  return [`### 批注摘录 · ${date.toLocaleDateString("zh-CN")}`, ...lines].join(
    "\n",
  );
}
