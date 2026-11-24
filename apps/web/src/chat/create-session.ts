import { api } from "@neoread/api";
import type { DocumentChatSession } from "@neoread/core";
import type { ChatSnapshot } from "./chat-session";

export async function createDocumentChatSession(
  documentId: string,
  provider: string,
  refresh: () => Promise<void>,
  select: (id: string) => void,
  reuse?: { current: DocumentChatSession | undefined; chat: ChatSnapshot },
) {
  if (
    reuse?.current?.title === "新会话" &&
    !reuse.current.latestRun &&
    !reuse.chat.pending &&
    !reuse.chat.busy
  ) {
    const messages = reuse.chat.loaded
      ? reuse.chat.messages
      : await api.sessionMessages(documentId, reuse.current.id);
    if (!messages.length) return;
  }

  const session = await api.createChatSession(documentId, provider || "api");
  await refresh();
  select(session.id);
}
