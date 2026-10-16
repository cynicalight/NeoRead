import { diagnosticFetch, reportDiagnostic } from "./diagnostics";
import {
  diagnosticError,
  diagnosticRoute,
} from "../../reader-core/src/diagnostics";
export { setDiagnosticReporter, reportDiagnostic } from "./diagnostics";
import {
  consumeTranslationStream,
  type TranslationEvent,
} from "./translation-stream";
import { consumeChatStream, type ChatStreamEvent } from "./chat-stream";
export { ChatStreamError, type ChatStreamEvent } from "./chat-stream";
import createClient from "openapi-fetch";
import type { components, paths } from "./schema";
import type {
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
} from "@reader/core";
let sessionToken = "";
export function configureAPI(token: string) {
  sessionToken = token;
}
export function publicationURL(documentId: string, resource: string) {
  return `/pub/${encodeURIComponent(sessionToken)}/${encodeURIComponent(documentId)}/${resource}`;
}
export function blockImageURL(documentId: string, blockId: string) {
  return publicationURL(
    documentId,
    `assets/${encodeURIComponent(blockId)}.png`,
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
      requestId: response.headers.get("X-Reader-Request-ID") || undefined,
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
      headers: { ...init.headers, "X-Reader-Undo-Session": annotationSession },
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
export const api = {
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
    request<import("@reader/core").EPUBChapters>(
      `/api/documents/${encodeURIComponent(id)}/epub-chapters`,
      { signal },
    ),
  epubChapter: (id: string, href: string, signal?: AbortSignal) =>
    request<{ html: string }>(
      `/api/documents/${encodeURIComponent(id)}/epub-chapter?href=${encodeURIComponent(href)}`,
      { signal },
    ),
  epubBlocks: (id: string) =>
    request<import("@reader/core").EPUBReadingBlock[]>(
      `/api/documents/${id}/epub-blocks`,
    ),
  translations: (id: string) =>
    request<import("@reader/core").TranslationBlock[]>(
      `/api/documents/${id}/translations`,
    ),
  translate: (id: string, blockId = "") =>
    request<{ queued: boolean }>(`/api/documents/${id}/translations`, {
      method: "POST",
      body: JSON.stringify({ blockId }),
    }),
  /** Queues a page range, capped by the server; nextPage is where it stopped. */
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
    location: import("@reader/core").EPUBLocation,
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
  setAssistance: (id: string, action: "start" | "pause" | "resume") =>
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
  ) => {
    const query = new URLSearchParams();
    if (capability) query.set("capability", capability);
    if (model) query.set("model", model);
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
  import: (file: File, library: LibraryMode = "books", allowLarge = false) => {
    const form = new FormData();
    form.append("library", library);
    if (allowLarge) form.append("allowLarge", "1");
    form.append("file", file);
    return request<Document>("/api/documents", { method: "POST", body: form });
  },
  /** Import a paper from an arXiv ID, DOI, paper link, PDF link or title. */
  resolveDocument: (
    ref: string,
    options?: { library: LibraryMode; allowLarge: boolean },
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
      requestId: response.headers.get("X-Reader-Request-ID") || undefined,
    });
  } catch (error) {
    reportDiagnostic({
      level: signal.aborted ? "info" : "error",
      event: signal.aborted ? "chat.stream_cancelled" : "chat.stream_failed",
      requestId: response.headers.get("X-Reader-Request-ID") || undefined,
      ...diagnosticError(error),
    });
    throw error;
  }
}
