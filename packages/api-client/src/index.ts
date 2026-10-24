import { diagnosticFetch, reportDiagnostic } from "./diagnostics";
import {
  uploadAttachment,
  type AttachmentUploadOptions,
} from "./attachment-upload";
import {
  diagnosticError,
  diagnosticRoute,
} from "../../neoread-core/src/diagnostics";
export { setDiagnosticReporter, reportDiagnostic } from "./diagnostics";
import {
  consumeTranslationStream,
  type TranslationEvent,
} from "./translation-stream";
import { consumeChatStream, type ChatStreamEvent } from "./chat-stream";
export { ChatStreamError, type ChatStreamEvent } from "./chat-stream";
import { consumeCiteEvents, type CiteEvent } from "./cite-events";
export type { CiteEvent } from "./cite-events";
import createClient from "openapi-fetch";
import type { components, paths } from "./schema";
import type {
  ChatRun,
  DocumentChatSession,
  Document,
  DocumentOverview,
  OverviewJob,
  TagBoard,
  DocumentLocation,
  Annotation,
  SearchResult,
  Provider,
  Message,
  ReaderTheme,
  SourceReference,
  Processing,
  ProcessingUsage,
  PDFBlock,
  AIConfig,
  AICapability,
  AgentModel,
  LibraryMode,
  LibraryPreferences,
  GuidePreferences,
  PaperMetadata,
  PaperMetadataField,
  ReadingStatus,
  JournalRankConfig,
  JournalRankResult,
} from "@neoread/core";
let sessionToken = "";
export function configureAPI(token: string) {
  sessionToken = token;
}
/** PDF.js reuses these credentials for both the initial request and byte ranges. */
export function paperAttachmentSource(
  documentId: string,
  attachmentId: string,
) {
  return {
    url: `/api/documents/${encodeURIComponent(documentId)}/attachments/${encodeURIComponent(attachmentId)}/file`,
    httpHeaders: { Authorization: `Bearer ${sessionToken}` },
  };
}
export function publicationURL(documentId: string, resource: string) {
  return `/pub/${encodeURIComponent(sessionToken)}/${encodeURIComponent(documentId)}/${resource}`;
}
export function blockImageURL(
  documentId: string,
  blockId: string,
  revision?: string,
) {
  return publicationURL(
    documentId,
    `assets/${encodeURIComponent(blockId)}.png${revision ? `?v=${encodeURIComponent(revision)}` : ""}`,
  );
}
export const client = createClient<paths>();
client.use({
  onRequest({ request }) {
    request.headers.set("Authorization", `Bearer ${sessionToken}`);
    reportDiagnostic({
      level: "info",
      event: "api.start",
      route: diagnosticRoute(new URL(request.url).pathname),
      method: request.method,
    });
    return request;
  },
  onResponse({ request, response }) {
    reportDiagnostic({
      level: response.ok ? "info" : "error",
      event: "api.finish",
      route: diagnosticRoute(new URL(request.url).pathname),
      method: request.method,
      status: response.status,
      requestId: response.headers.get("X-NeoRead-Request-ID") || undefined,
    });
    return response;
  },
  onError({ request, error }) {
    reportDiagnostic({
      level: "error",
      event: "api.failed",
      route: diagnosticRoute(new URL(request.url).pathname),
      method: request.method,
    });
    return;
  },
});
/** A failed request; `code` and `pages` identify a long paper to confirm. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly pages?: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await diagnosticFetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new RequestError(
      data.error || `请求失败 (${response.status})`,
      data.code,
      data.pages,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
// Keep annotation writes and undo in the same client order, including failures.
let annotationQueue = Promise.resolve();
let annotationSession = "";
function annotationRequest<T>(path: string, init: RequestInit): Promise<T> {
  annotationSession ||= crypto.randomUUID();
  const operation = annotationQueue.then(() =>
    request<T>(path, {
      ...init,
      headers: { ...init.headers, "X-NeoRead-Undo-Session": annotationSession },
    }),
  );
  annotationQueue = operation.then(
    () => {},
    () => {},
  );
  return operation;
}
export type ZoteroScan = components["schemas"]["ZoteroScan"];
export type ZoteroImportResult = components["schemas"]["ZoteroImportResult"];
export type PaperAttachment = components["schemas"]["PaperAttachment"];
export const api = {
  paperAttachments: (id: string) =>
    request<PaperAttachment[]>(
      `/api/documents/${encodeURIComponent(id)}/attachments`,
    ),
  addPaperAttachment: (
    id: string,
    file: File,
    options?: AttachmentUploadOptions,
  ) =>
    uploadAttachment<PaperAttachment>(
      `/api/documents/${encodeURIComponent(id)}/attachments`,
      sessionToken,
      file,
      options,
    ),
  addPaperLink: (id: string, title: string, url: string) =>
    request<PaperAttachment>(
      `/api/documents/${encodeURIComponent(id)}/attachments`,
      {
        method: "POST",
        body: JSON.stringify({ title, url }),
      },
    ),
  renamePaperAttachment: (id: string, attachment: string, title: string) =>
    request<PaperAttachment>(
      `/api/documents/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachment)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title }),
      },
    ),
  removePaperAttachment: (id: string, attachment: string) =>
    request<void>(
      `/api/documents/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachment)}`,
      { method: "DELETE" },
    ),
  downloadPaperAttachment: async (
    id: string,
    attachment: string,
    signal?: AbortSignal,
  ): Promise<Blob> => {
    const source = paperAttachmentSource(id, attachment);
    const response = await diagnosticFetch(source.url, {
      headers: source.httpHeaders,
      signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new RequestError(data.error || `附件下载失败 (${response.status})`);
    }
    return response.blob();
  },
  navigation: (id: string) =>
    request<import("@neoread/core").DocumentNavigation>(
      `/api/documents/${encodeURIComponent(id)}/navigation`,
    ),
  saveNavigation: (
    id: string,
    navigation: import("@neoread/core").DocumentNavigation,
  ) =>
    request<import("@neoread/core").DocumentNavigation>(
      `/api/documents/${encodeURIComponent(id)}/navigation`,
      {
        method: "PUT",
        body: JSON.stringify(navigation),
      },
    ),
  journalRankConfig: () =>
    request<JournalRankConfig>("/api/journal-ranks/config"),
  saveJournalRankConfig: (config: {
    enabled: boolean;
    filterMode: JournalRankConfig["filterMode"];
    selected: string[];
    key?: string;
  }) =>
    request<JournalRankConfig>("/api/journal-ranks/config", {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  documentJournalRank: (id: string, refresh = false) =>
    request<JournalRankResult>(
      `/api/documents/${encodeURIComponent(id)}/journal-rank${refresh ? "?refresh=1" : ""}`,
    ),
  connectorStatus: () =>
    request<
      paths["/api/connector/status"]["get"]["responses"][200]["content"]["application/json"]
    >("/api/connector/status"),
  connectorRevision: () =>
    request<{ revision: number }>("/api/connector/revision"),
  snapshotStatus: (id: string) =>
    request<{ available: boolean; sourceUrl?: string }>(
      `/api/documents/${encodeURIComponent(id)}/snapshot`,
    ),
  scanEndNote: (directory: string) =>
    request<ZoteroScan>("/api/import/endnote/scan", {
      method: "POST",
      body: JSON.stringify({ directory }),
    }),
  importEndNote: (
    scanId: string,
    entryId: string,
    options?: { library: LibraryMode; allowLarge: boolean },
  ) =>
    request<ZoteroImportResult>("/api/import/endnote", {
      method: "POST",
      body: JSON.stringify({ scanId, entryId, ...options }),
    }),
  zoteroDefaults: () => request<{ directory: string }>("/api/import/zotero"),
  scanZotero: (directory: string, linkedBase = "") =>
    request<ZoteroScan>("/api/import/zotero/scan", {
      method: "POST",
      body: JSON.stringify({ directory, linkedBase }),
    }),
  importZotero: (
    scanId: string,
    entryId: string,
    options?: { library: LibraryMode; allowLarge: boolean },
  ) =>
    request<ZoteroImportResult>("/api/import/zotero", {
      method: "POST",
      body: JSON.stringify({ scanId, entryId, ...options }),
    }),
  chatUsage: (id: string) =>
    request<ProcessingUsage>(
      `/api/documents/${encodeURIComponent(id)}/chat-usage`,
    ),
  processingUsage: (id: string) =>
    request<ProcessingUsage>(
      `/api/documents/${encodeURIComponent(id)}/processing-usage`,
    ),
  tagBoards: () => request<TagBoard[]>("/api/tag-boards"),
  createTagBoard: (board: Omit<TagBoard, "id">) =>
    request<TagBoard>("/api/tag-boards", {
      method: "POST",
      body: JSON.stringify(board),
    }),
  updateTagBoard: (id: string, board: Omit<TagBoard, "id">) =>
    request<TagBoard>(`/api/tag-boards/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(board),
    }),
  removeTagBoard: (id: string) =>
    request<void>(`/api/tag-boards/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  translateSelection: (
    selection: { text: string; context?: { before: string; after: string } },
    signal: AbortSignal,
  ) =>
    request<{ text: string }>("/api/translate-selection", {
      method: "POST",
      body: JSON.stringify({ text: selection.text, ...selection.context }),
      signal,
    }),
  translationStream: async (
    id: string,
    signal: AbortSignal,
    onEvent: (event: TranslationEvent) => void,
  ) => {
    const response = await diagnosticFetch(
      `/api/documents/${encodeURIComponent(id)}/translations/stream`,
      {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          Accept: "text/event-stream",
        },
        signal,
      },
    );
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.startsWith("text/event-stream")
    ) {
      throw new Error(`无法订阅译文 (${response.status})`);
    }
    return consumeTranslationStream(response.body, signal, onEvent);
  },
  epubChapters: (id: string, signal?: AbortSignal) =>
    request<import("@neoread/core").EPUBChapters>(
      `/api/documents/${encodeURIComponent(id)}/epub-chapters`,
      { signal },
    ),
  epubChapter: (id: string, href: string, signal?: AbortSignal) =>
    request<{ html: string }>(
      `/api/documents/${encodeURIComponent(id)}/epub-chapter?href=${encodeURIComponent(href)}`,
      { signal },
    ),
  epubBlocks: (id: string) =>
    request<import("@neoread/core").EPUBReadingBlock[]>(
      `/api/documents/${id}/epub-blocks`,
    ),
  translations: (id: string) =>
    request<import("@neoread/core").TranslationBlock[]>(
      `/api/documents/${id}/translations`,
    ),
  exportTranslation: async (
    id: string,
    format: "markdown" | "zip",
    signal?: AbortSignal,
    notesMarkdown = "",
  ): Promise<Blob> => {
    const response = await diagnosticFetch(
      `/api/documents/${encodeURIComponent(id)}/translations/export?format=${format}`,
      {
        method: notesMarkdown ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          ...(notesMarkdown && { "Content-Type": "application/json" }),
        },
        ...(notesMarkdown && { body: JSON.stringify({ notesMarkdown }) }),
        signal,
      },
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new RequestError(data.error || `导出失败 (${response.status})`);
    }
    return response.blob();
  },
  translate: (id: string, blockId = "") =>
    request<{ queued: boolean }>(`/api/documents/${id}/translations`, {
      method: "POST",
      body: JSON.stringify({ blockId }),
    }),
  /** Queues the entire page range through the shared translation workers. */
  translateRange: (id: string, fromPage: number, toPage: number) =>
    request<{
      queued: number;
      characters: number;
      nextPage: number;
      /** The chapter's pages are parsed first, then translated. */
      parsing: boolean;
    }>(`/api/documents/${id}/translations/range`, {
      method: "POST",
      body: JSON.stringify({ fromPage, toPage }),
    }),
  translateEPUBChapter: (
    id: string,
    location: import("@neoread/core").EPUBLocation,
  ) =>
    request<{ queued: number; characters: number; hasMore: boolean }>(
      `/api/documents/${id}/translations/chapter`,
      {
        method: "POST",
        body: JSON.stringify({
          location: {
            type: "epub",
            href: location.href,
            blockId: location.blockId,
            locator: location.locator,
            start: location.start,
            end: location.end,
          },
        }),
      },
    ),
  assistance: (id: string) =>
    request<Processing>(`/api/documents/${id}/assistance`),
  setAssistance: (
    id: string,
    action: "start" | "pause" | "resume" | "retranslate",
  ) =>
    request<Processing>(`/api/documents/${id}/assistance`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
  overviewJobs: () => request<OverviewJob[]>("/api/overviews"),
  documentOverview: (id: string) =>
    request<DocumentOverview>(
      `/api/documents/${encodeURIComponent(id)}/overview`,
    ),
  generateOverview: (id: string, regenerate = false) =>
    request<DocumentOverview>(
      `/api/documents/${encodeURIComponent(id)}/overview`,
      { method: "POST", body: JSON.stringify({ regenerate }) },
    ),
  cancelOverview: (id: string) =>
    request<void>(`/api/documents/${encodeURIComponent(id)}/overview/job`, {
      method: "DELETE",
    }),
  processing: () => request<Processing[]>("/api/processing"),
  process: (id: string) =>
    request<Processing>(`/api/documents/${id}/processing`, { method: "POST" }),
  blocks: (id: string) => request<PDFBlock[]>(`/api/documents/${id}/blocks`),
  aiConfig: () => request<AIConfig>("/api/ai/config"),
  agentModels: (provider: string, signal?: AbortSignal) =>
    request<AgentModel[]>(
      `/api/ai/models?provider=${encodeURIComponent(provider)}`,
      { signal },
    ),
  saveAIConfig: (config: AIConfig) =>
    request<AIConfig>("/api/ai/config", {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  testAI: (
    provider: string,
    capability?: "text" | "vision" | "tools",
    model?: string,
    timeoutSeconds?: number,
  ) => {
    const query = new URLSearchParams();
    if (capability) query.set("capability", capability);
    if (model) query.set("model", model);
    if (timeoutSeconds !== undefined)
      query.set("timeoutSeconds", String(timeoutSeconds));
    return request<AICapability>(
      `/api/ai/test/${provider}${query.size ? `?${query}` : ""}`,
      { method: "POST" },
    );
  },
  documents: async (): Promise<Document[]> => {
    const { data, error } = await client.GET("/api/documents");
    if (error) throw new Error(error.error);
    return data;
  },
  /** Papers over 100 pages or 100 MB fail with code "large-paper" unless allowLarge. */
  import: (
    file: File,
    library: LibraryMode = "books",
    allowLarge = false,
    folder = "",
  ) => {
    const form = new FormData();
    form.append("library", library);
    if (allowLarge) form.append("allowLarge", "1");
    if (folder.startsWith("smart:"))
      form.append("smartCategory", folder.slice(6));
    else if (folder)
      form.append(
        "folder",
        folder.startsWith("folder:") ? folder.slice(7) : folder,
      );
    form.append("file", file);
    return request<Document>("/api/documents", { method: "POST", body: form });
  },
  /** Import a paper from an arXiv ID, DOI, paper link, PDF link or title. */
  resolveDocument: (
    ref: string,
    options?: {
      library: LibraryMode;
      allowLarge: boolean;
      folder?: string;
      smartCategory?: string;
    },
  ) =>
    request<Document>("/api/documents/resolve", {
      method: "POST",
      body: JSON.stringify({ ref, ...options }),
    }),
  lookupMetadata: (id: string) =>
    request<Document>(
      `/api/documents/${encodeURIComponent(id)}/metadata/lookup`,
      { method: "POST" },
    ),
  removeDocument: (id: string) =>
    request<void>(`/api/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  trashDocument: (id: string) =>
    request<Document>(`/api/documents/${encodeURIComponent(id)}/trash`, {
      method: "POST",
    }),
  relateDocuments: (id: string, other: string) =>
    request<Document>(
      `/api/documents/${encodeURIComponent(id)}/related/${encodeURIComponent(other)}`,
      { method: "PUT" },
    ),
  unrelateDocuments: (id: string, other: string) =>
    request<Document>(
      `/api/documents/${encodeURIComponent(id)}/related/${encodeURIComponent(other)}`,
      { method: "DELETE" },
    ),
  mergeDocuments: (id: string, from: string[]) =>
    request<{ document: Document; trashed: string[] }>(
      `/api/documents/${encodeURIComponent(id)}/merge`,
      { method: "POST", body: JSON.stringify({ from }) },
    ),
  restoreDocument: (id: string) =>
    request<Document>(`/api/documents/${encodeURIComponent(id)}/restore`, {
      method: "POST",
    }),
  trash: (library: LibraryMode) =>
    request<Document[]>(`/api/trash?library=${library}`),
  emptyTrash: (library: LibraryMode) =>
    request<{ removed: number }>(`/api/trash?library=${library}`, {
      method: "DELETE",
    }),
  classify: (id: string) =>
    request<Document>(`/api/documents/${id}/classification`, {
      method: "POST",
    }),
  update: (
    id: string,
    patch: {
      title?: string;
      author?: string;
      category?: Document["category"];
      tags?: string[];
      folders?: string[];
      favorite?: boolean;
      progress?: DocumentLocation;
      percentage?: number;
      library?: LibraryMode;
      metadata?: Partial<Pick<PaperMetadata, PaperMetadataField>>;
      readingStatus?: ReadingStatus;
    },
  ) =>
    request<Document>(`/api/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  recoverAnnotations: (id: string, force = false) =>
    request<{ checked: boolean }>(`/api/documents/${id}/annotations/recover`, {
      method: "POST",
      body: JSON.stringify({ force }),
    }),
  annotations: (id: string) =>
    request<Annotation[]>(`/api/documents/${id}/annotations`),
  annotate: (
    id: string,
    annotation: Pick<
      Annotation,
      "kind" | "location" | "quote" | "note" | "color"
    >,
  ) =>
    annotationRequest<components["schemas"]["SavedAnnotation"]>(
      `/api/documents/${id}/annotations`,
      {
        method: "POST",
        body: JSON.stringify(annotation),
      },
    ),
  updateAnnotationNote: (id: string, annotation: string, note: string) =>
    annotationRequest<Annotation>(
      `/api/documents/${id}/annotations/${annotation}`,
      {
        method: "PATCH",
        body: JSON.stringify({ note }),
      },
    ),
  updateAnnotation: (
    id: string,
    annotation: string,
    patch: {
      note?: string;
      answerId?: string;
      resolved?: boolean;
      color?: string;
      tags?: string[];
    },
  ) =>
    annotationRequest<Annotation>(
      `/api/documents/${id}/annotations/${annotation}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    ),
  documentNote: (id: string) =>
    request<{ body: string; updatedAt?: string }>(
      `/api/documents/${encodeURIComponent(id)}/note`,
    ),
  saveDocumentNote: (id: string, body: string) =>
    request<{ body: string; updatedAt?: string }>(
      `/api/documents/${encodeURIComponent(id)}/note`,
      { method: "PUT", body: JSON.stringify({ body }) },
    ),
  undoAnnotation: (id: string) =>
    annotationRequest<{ undone: boolean; annotations: Annotation[] }>(
      `/api/documents/${encodeURIComponent(id)}/annotations/undo`,
      { method: "POST" },
    ),
  removeAnnotation: (id: string, annotation: string) =>
    annotationRequest<void>(`/api/documents/${id}/annotations/${annotation}`, {
      method: "DELETE",
    }),
  search: (id: string, query: string) =>
    request<SearchResult[]>(
      `/api/documents/${id}/search?q=${encodeURIComponent(query)}`,
    ),
  messages: (id: string, signal?: AbortSignal) =>
    request<Message[]>(`/api/documents/${id}/messages`, { signal }),
  chatSessions: (id: string, signal?: AbortSignal) =>
    request<DocumentChatSession[]>(`/api/documents/${id}/chat-sessions`, {
      signal,
    }),
  createChatSession: (id: string, provider: string) =>
    request<DocumentChatSession>(`/api/documents/${id}/chat-sessions`, {
      method: "POST",
      body: JSON.stringify({ provider }),
    }),
  updateChatSession: (
    id: string,
    sessionId: string,
    patch: { title?: string; provider?: string },
  ) =>
    request<DocumentChatSession>(
      `/api/documents/${id}/chat-sessions/${sessionId}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),
  sessionMessages: (id: string, sessionId: string, signal?: AbortSignal) =>
    request<Message[]>(
      `/api/documents/${id}/chat-sessions/${sessionId}/messages`,
      { signal },
    ),
  startChatRun: (
    id: string,
    sessionId: string,
    input: {
      provider: string;
      prompt: string;
      context: string;
      userMessageId?: string;
      webSearch?: boolean;
      references: SourceReference[];
      attachments: string[];
      readingLocation?: DocumentLocation;
    },
  ) =>
    request<ChatRun>(`/api/documents/${id}/chat-sessions/${sessionId}/chat`, {
      method: "POST",
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    }),
  cancelChatRun: (id: string, sessionId: string, runId: string) =>
    request<{ ok: boolean }>(
      `/api/documents/${id}/chat-sessions/${sessionId}/runs/${runId}/cancel`,
      { method: "POST", signal: AbortSignal.timeout(30_000) },
    ),
  codexHandoff: (id: string, sessionId?: string) =>
    request<components["schemas"]["CodexHandoff"]>(
      `/api/documents/${encodeURIComponent(id)}/codex-handoff${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
      { method: "POST" },
    ),
  validateEvidence: (id: string, message: string, source: string) =>
    request<{ valid: boolean }>(
      `/api/documents/${encodeURIComponent(id)}/messages/${encodeURIComponent(message)}/sources/${encodeURIComponent(source)}`,
    ),
  providers: (checkAuth = true) =>
    request<Provider[]>(`/api/providers${checkAuth ? "" : "?auth=skip"}`),
  /** Rename a category across a library, or remove it when `to` is omitted. */
  changeLibraryFolder: (library: LibraryMode, from: string, to?: string) =>
    request<{ changed: number }>(`/api/libraries/${library}/folders`, {
      method: "POST",
      body: JSON.stringify(to === undefined ? { from } : { from, to }),
    }),
  changeLibraryTag: (library: LibraryMode, from: string, to?: string) =>
    request<{ changed: number }>(`/api/libraries/${library}/tags`, {
      method: "POST",
      body: JSON.stringify(to === undefined ? { from } : { from, to }),
    }),
  libraryPreferences: () =>
    request<LibraryPreferences>("/api/preferences/library"),
  saveLibraryPreferences: (preferences: LibraryPreferences) =>
    request<LibraryPreferences>("/api/preferences/library", {
      method: "PUT",
      body: JSON.stringify(preferences),
    }),
  shortcutPreferences: () =>
    request<Record<string, { key: string; shift: boolean }>>(
      "/api/preferences/shortcuts",
    ),
  saveShortcutPreferences: (
    preferences: Record<string, { key: string; shift: boolean }>,
  ) =>
    request<Record<string, { key: string; shift: boolean }>>(
      "/api/preferences/shortcuts",
      { method: "PUT", body: JSON.stringify(preferences) },
    ),
  guidePreferences: () => request<GuidePreferences>("/api/preferences/guide"),
  saveGuidePreferences: (preferences: GuidePreferences) =>
    request<GuidePreferences>("/api/preferences/guide", {
      method: "PUT",
      body: JSON.stringify(preferences),
    }),
  citeEvents: async (
    signal: AbortSignal,
    onEvent: (event: CiteEvent) => void,
  ) => {
    const response = await diagnosticFetch("/api/cite/events", {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        Accept: "text/event-stream",
      },
      signal,
    });
    if (!response.ok || !response.body)
      throw new Error(`无法连接引用插件 (${response.status})`);
    return consumeCiteEvents(response.body, signal, onEvent);
  },
  /** One document operation in the Word or WPS plugin; resolves with its result. */
  citeCall: (transaction: string, operation: object) =>
    request<unknown>(
      `/api/cite/transactions/${encodeURIComponent(transaction)}/call`,
      {
        method: "POST",
        body: JSON.stringify({ ...operation, transaction }),
      },
    ),
  citeComplete: (
    transaction: string,
    result: { activate: boolean; error?: string },
  ) =>
    request<void>(
      `/api/cite/transactions/${encodeURIComponent(transaction)}/complete`,
      { method: "POST", body: JSON.stringify(result) },
    ),
  settings: () => request<Partial<ReaderTheme>>("/api/settings"),
  saveSettings: (theme: ReaderTheme) =>
    request<ReaderTheme>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(theme),
    }),
};
export async function chat(
  id: string,
  provider: string,
  prompt: string,
  context: string,
  signal: AbortSignal,
  onDelta: (text: string) => void,
  references: SourceReference[] = [],
  attachments: string[] = [],
  onFallback?: (message: string) => void,
  onEvent?: (event: ChatStreamEvent) => void,
  readingLocation?: DocumentLocation,
  userMessageId?: string,
  webSearch?: boolean,
) {
  const response = await diagnosticFetch(`/api/documents/${id}/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider,
      prompt,
      context,
      references,
      readingLocation,
      attachments,
      userMessageId,
      webSearch,
    }),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `AI 请求失败 (${response.status})`);
  }
  if (!response.body) throw new Error("没有收到 AI 输出");
  try {
    await consumeChatStream(response.body, signal, (event) => {
      onEvent?.(event);
      if (event.event === "delta") onDelta(event.data.text);
      if (event.event === "fallback") onFallback?.(event.data.message);
    });
    reportDiagnostic({
      level: "info",
      event: "chat.stream_finish",
      requestId: response.headers.get("X-NeoRead-Request-ID") || undefined,
    });
  } catch (error) {
    reportDiagnostic({
      level: signal.aborted ? "info" : "error",
      event: signal.aborted ? "chat.stream_cancelled" : "chat.stream_failed",
      requestId: response.headers.get("X-NeoRead-Request-ID") || undefined,
      ...diagnosticError(error),
    });
    throw error;
  }
}

/** Attach/replay a run without starting another model request. */
export async function watchChatRun(
  id: string,
  sessionId: string,
  runId: string,
  signal: AbortSignal,
  emit: (event: ChatStreamEvent) => void,
) {
  const response = await diagnosticFetch(
    `/api/documents/${id}/chat-sessions/${sessionId}/runs/${runId}/events`,
    { headers: { Authorization: `Bearer ${sessionToken}` }, signal },
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `读取运行失败 (${response.status})`);
  }
  if (!response.body) throw new Error("没有收到运行事件");
  await consumeChatStream(response.body, signal, emit);
}
