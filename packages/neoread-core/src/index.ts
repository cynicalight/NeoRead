export { zoomCommand } from "./zoom-shortcut";
export { documentTabCommand } from "./document-tab-shortcut";
export {
  NEOREAD_SCHEME,
  LINK_SCHEMES,
  neoreadLink,
  parseNeoReadLink,
  type NeoReadLinkTarget,
} from "./neoread-link";

/** Sentence pairs captured when marking; both sides share one annotation. */
export type SentenceLink = {
  origin: "source" | "translation";
  parts: {
    blockId: string;
    sourceHash: string;
    sentenceIndex: number;
    source: string;
    target: string;
  }[];
};
export type PDFLocation = {
  /** Independent source marks split from legacy translation-origin records. */
  sourceAnchors?: {
    blockId: string;
    source: string;
    page: number;
    bounds: { x: number; y: number; width: number; height: number };
  }[];
  type: "pdf";
  page: number;
  x?: number;
  y?: number;
  quote?: string;
  /** Search-only paragraph context and UTF-16 offset of the selected match. */
  quoteContext?: { text: string; start: number };
  sentenceLink?: SentenceLink;
  translation?: TranslationLocation;
  rects?: { x: number; y: number; width: number; height: number }[];
};
export type TranslationRecoveryAnchor = {
  /** Source sentence text survives changes to translation sentence boundaries. */
  sourceText?: string;
  /** Entire paragraph target; detects offsets shifted by preceding sentences. */
  targetText?: string;
  recovered?: boolean;
  wholeSentence?: boolean;
  matchedQuote?: string;
};
export type TranslationLocation = TranslationRecoveryAnchor & {
  blockId: string;
  sourceHash: string;
  sentenceIndexes: number[];
  start: number;
  end: number;
  ranges?: (TranslationRecoveryAnchor & {
    blockId: string;
    sourceHash: string;
    sentenceIndexes: number[];
    start: number;
    end: number;
    quote: string;
    location?: EPUBLocation;
  })[];
};
export type EPUBLocation = {
  blockId?: string;
  /** UTF-16 offsets in block text; endBlockId supports multi-paragraph selections. */
  start?: number;
  end?: number;
  endBlockId?: string;
  /** Chapter containing the end of a cross-chapter selection. */
  endHref?: string;
  type: "epub";
  href: string;
  sentenceLink?: SentenceLink;
  translation?: TranslationLocation;
  locator?: string;
  progression?: number;
  quote?: string;
};
export type DocumentLocation = PDFLocation | EPUBLocation;
export type DocumentCategory = "book" | "article" | "paper";
/** Books and papers are separate libraries; large PDFs require confirmation. */
export type LibraryMode = "books" | "papers";
export type PaperItemType =
  | "journal"
  | "conference"
  | "preprint"
  | "thesis"
  | "book"
  | "chapter"
  | "report"
  | "other";
/** CSL-style name: given/family for split names, name for one literal name. */
export interface Creator {
  given?: string;
  family?: string;
  name?: string;
}
export type MetadataSource = "file" | "lookup" | "manual";
export interface PaperMetadata {
  itemType?: PaperItemType;
  suggestedTitle?: string;
  translatedTitle?: string;
  shortTitle?: string;
  creators?: Creator[];
  affiliation?: string;
  /** YYYY, YYYY-MM or YYYY-MM-DD. */
  date?: string;
  venue?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  doi?: string;
  arxiv?: string;
  isbn?: string;
  url?: string;
  abstract?: string;
  language?: string;
  /** The reader's own note on the item; never looked up. */
  remark?: string;
  /** The reader's own 1–5 star rating; absent or 0 when unrated. */
  rating?: number;
  /** Where each field came from; lookups never replace manual values. */
  sources?: Partial<Record<string, MetadataSource>>;
  /** Automatic lookup state for papers imported from files. */
  lookup?: "pending" | "done" | "notFound" | "failed";
  lookedUpAt?: string;
}
export type PaperMetadataField = Exclude<
  keyof PaperMetadata,
  "sources" | "lookup" | "lookedUpAt" | "suggestedTitle"
>;
export type ReadingStatus = "unread" | "reading" | "done";
export type PaperSort =
  | "opened"
  | "added"
  | "year"
  | "published"
  | "progress"
  | "size"
  | "title"
  | "author"
  | "venue"
  | "status"
  | "notes";
/** Metadata columns of the paper table. */
export type PaperColumn =
  | "authors"
  | "year"
  | "published"
  | "tags"
  | "progress"
  | "doi"
  | "arxiv"
  | "size"
  | "venue"
  | "added"
  | "opened"
  | "notes"
  | "status";
export interface JournalRankBadge {
  key: string;
  name: string;
  value: string;
  subject?: string;
  year?: string;
}
export interface JournalRankResult {
  status: "found" | "notFound" | "notApplicable" | "noVenue" | "disabled";
  badges: JournalRankBadge[];
  checkedAt?: string;
}
export interface JournalRankConfig {
  enabled: boolean;
  hasKey: boolean;
  filterMode: "include" | "exclude";
  selected: string[];
  available: { key: string; name: string }[];
}
export interface PaperLibraryPreferences {
  /** Category (folder) order, including categories without papers. */
  categories?: string[];
  /** Categories that collect every paper carrying all of their tags. */
  smartCategories?: SmartCategory[];
  /** Pinned sidebar entries: "view:<id>", "folder:<path>", "smart:<id>" or "doc:<id>". */
  pinned?: string[];
  /** Hidden built-in views ("view:<id>") and categories ("folder:<path>", "smart:<id>"). */
  hidden?: string[];
  /** Categories whose subcategories are folded in the sidebar. */
  collapsed?: string[];
  /** A category also lists papers filed in its subcategories (default on). */
  subcategoryItems?: boolean;
  /** Paper pairs ("<id>:<id>", ids sorted) marked as not duplicates. */
  notDuplicates?: string[];
  /** Colored categories; the n-th one is toggled with the number key n. */
  colorCategories?: { name: string; color: string }[];
  sort?: PaperSort;
  /** Reverse the natural order of `sort`. */
  sortReverse?: boolean;
  layout?: "list" | "table";
  /** Visible table columns in order. */
  columns?: PaperColumn[];
  /** Whether the title column is shown (default on). */
  showTitle?: boolean;
  /** Order of all table columns, including hidden ones. */
  columnOrder?: ("title" | PaperColumn)[];
  /** Widths of resized table columns in CSS pixels. */
  columnWidths?: Partial<Record<"title" | PaperColumn, number>>;
  /** Width of the paper detail panel in CSS pixels. */
  detailWidth?: number;
  /** Look up metadata from the DOI or arXiv ID printed in imported PDFs. */
  autoLookup?: boolean;
  citationStyle?: "gb7714" | "apa" | "bibtex" | "ris" | "csl-json";
  citationOrder?: "author" | "year" | "custom";
}
export interface SmartCategory {
  id: string;
  name: string;
  /** A paper belongs when it has every one of these tags. */
  tags: string[];
}
export interface LibraryPreferences {
  /** Optional contact email sent only to Crossref for its polite pool. */
  crossrefEmail?: string;
  /** Library opened at startup; defaults to papers. */
  primaryMode?: LibraryMode;
  mode?: LibraryMode;
  papers?: PaperLibraryPreferences;
  books?: {
    /** Width of the book detail panel in CSS pixels. */
    detailWidth?: number;
  };
}
/** First-run guide and release notes, stored with the library. */
export interface GuidePreferences {
  /** Bundled paper installed only when this library was first created. */
  exampleDocumentId?: string;
  /** The full onboarding was finished or skipped. */
  onboarded?: boolean;
  /** The app version whose release notes were last handled. */
  seenVersion?: string;
}
export interface TagBoard {
  id: string;
  name: string;
  tags: string[];
  match: "all" | "any";
}
export interface Document {
  category: DocumentCategory;
  categorySource: "default" | "ai" | "manual";
  classificationStatus: "idle" | "pending" | "running" | "failed" | "done";
  classificationError: string;
  tags: string[];
  /** Paper-library categories; "a/b" is nested in "a". */
  folders: string[];
  library: LibraryMode;
  /** Set while the document is in the trash. */
  deletedAt?: string;
  metadata: PaperMetadata;
  readingStatus: ReadingStatus;
  noteCount: number;
  /** Additional files and links, excluding the primary PDF. */
  attachmentCount?: number;
  /** Highlights and underlines. */
  highlightCount: number;
  /** Questions without an answer that are not resolved. */
  openQuestionCount: number;
  /** Documents linked as related, in both directions; may include trashed ones. */
  related: string[];
  id: string;
  type: "epub" | "pdf";
  title: string;
  author: string;
  size: number;
  createdAt: string;
  lastOpenedAt: string;
  favorite: boolean;
  progress?: DocumentLocation;
  percentage: number;
}
export type NavigationKind = "heading" | "bookmark";
export interface NavigationEdit {
  label?: string;
  kind?: NavigationKind;
  /** Missing means automatic placement; null explicitly moves to the root. */
  parentId?: string | null;
  collapsed?: boolean;
  deleted?: boolean;
}
export interface DocumentNavigation {
  revision: number;
  entries: Record<string, NavigationEdit>;
}
export interface TOCItem {
  kind?: NavigationKind;
  originalLabel?: string;
  /** Canonical source reading order, independent of the edited hierarchy. */
  order?: number[];

  id: string;
  label: string;
  location: DocumentLocation;
  children: TOCItem[];
}
export interface Annotation {
  id: string;
  documentId: string;
  kind: "highlight" | "underline" | "note" | "question" | "bookmark";
  location: DocumentLocation;
  quote: string;
  /** The note text, or the question for a question. */
  note: string;
  color: string;
  createdAt: string;
  /** Chat message that answers a question. */
  answerId?: string;
  /** A question closed without an answer. */
  resolved?: boolean;
  /** The reader's labels for filtering annotations. */
  tags?: string[];
}
export interface SearchResult {
  id: string;
  excerpt: string;
  location: DocumentLocation;
  blockId?: string;
  side?: "source" | "translation";
}
export interface SelectionAnchor {
  x: number;
  top: number;
  bottom: number;
}
export interface ReaderSelection {
  /** Nearby source text, captured before the DOM selection is cleared. */
  context?: { before: string; after: string };
  /** Transient renderer viewport position; never persist as a document anchor. */
  anchor?: SelectionAnchor;
  text: string;
  location: DocumentLocation;
}
export interface ReaderAnnotationTarget {
  ids: string[];
  anchor: SelectionAnchor;
}
export type Appearance = "light" | "sepia" | "dark" | "system";
/** Last user-chosen reading layout, shared by PDF and EPUB documents. */
export interface ReaderLayout {
  /** Expanded sidebar widths as percentages of the full reading workspace. */
  navigationWidth: number;
  assistantWidth: number;
  navigationOpen: boolean;
  assistantOpen: boolean;
  /** Source width in parallel mode, independent of its left/right position. */
  sourceWidth: number;
  swapped: boolean;
  /** Parallel mode stacks source and translation top and bottom. */
  stacked: boolean;
}
export interface ReaderTheme {
  /** Ordered open documents and the selected document; null selects the library. */
  readingSession?: { documentIds: string[]; activeId: string | null };
  /** Open documents in tabs; otherwise opening one replaces the current document. */
  documentTabs?: boolean;
  readerLayout?: Partial<ReaderLayout>;
  /** Opt in to copying text selections and selected annotations. */
  autoCopySelection?: boolean;
  autoTranslatePDF?: boolean;
  /** 0 means manual only; otherwise auto translate papers up to this many pages. */
  autoTranslateMaxPages?: number;
  /** How figures and embedded images are displayed when a PDF uses dark mode. */
  pdfDarkImageMode?: "preserve" | "invert" | "adaptive";
  /** Contrast used for PDF text and paper while the dark reading appearance is active. */
  pdfDarkContrast?: "high" | "soft";
  autoGenerateOverview?: boolean;
  /** Estimated total document-agent context; output and history reserve is included. */
  documentContextTokens?: number;
  appearance?: Appearance;
  /** Following the system: the palette used while the system is light. */
  systemLightMode?: "light" | "sepia";
  /** Following the system: graphite ("soft") or pure black ("high") PDFs while dark. */
  systemDarkContrast?: "high" | "soft";
  mode: "light" | "sepia" | "dark";
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  margin: number;
  scroll: boolean;
  zoom: number | "width";
  /** Explicit zoom preferences for individual PDFs; global zoom is the fallback. */
  documentZooms?: Record<string, number | "width">;
  /** Translated text size in rem; smaller than the source by default. */
  translationFontSize?: number;
  /** AI conversation text scale; 1 keeps the existing size. */
  assistantFontScale?: number;
  /** "sans-serif", "serif" or an installed font family name. */
  translationFontFamily?: string;
  linkTranslationAnnotations?: boolean;
  translationFontWeight?: "normal" | "bold";
  /** The highlight palette, in order; the defaults apply when unset. */
  highlightColors?: HighlightColor[];
  /** Reflowable EPUB text scrolls vertically unless pages are chosen. */
  epubFlow?: "scroll" | "paginated";
}
export interface HighlightColor {
  /** #rrggbb */
  value: string;
  label: string;
}
export const defaultTheme: ReaderTheme = {
  documentTabs: false,
  autoCopySelection: false,
  autoTranslatePDF: true,
  pdfDarkImageMode: "adaptive",
  pdfDarkContrast: "soft",
  autoGenerateOverview: false,
  documentContextTokens: 0,
  appearance: "system",
  mode: "light",
  fontSize: 1.15,
  fontFamily: "serif",
  lineHeight: 1.8,
  margin: 40,
  scroll: false,
  zoom: "width",
  translationFontSize: 1,
  assistantFontScale: 1,
  translationFontFamily: "serif",
  translationFontWeight: "bold",
  linkTranslationAnnotations: true,
  epubFlow: "scroll",
};
export type PDFBlockAction =
  "attach" | "preview" | "copy" | "explain" | "translate";
export interface PDFReadingAnchor {
  blockId: string;
  fraction: number;
}
export interface PDFPassage {
  blockId: string;
  sources: string[];
  /** Offset in source text after removing whitespace and soft hyphens. */
  sourceOffset?: number;
}
export interface PDFSentenceLink {
  blockId: string;
  sentenceIndexes: number[];
}
/** The target region of a hovered internal PDF link, rendered as an image. */
export interface LinkPreview {
  /** The link's rectangle in viewport coordinates. */
  anchor: { left: number; top: number; width: number; height: number };
  page: number;
  image: string;
  /** Image width divided by height. */
  ratio: number;
  /** Exact target for the preview's explicit navigation control. */
  location?: PDFLocation;
  /** Re-render the crop from the PDF at the requested physical pixel width. */
  renderImage?: (width: number, signal: AbortSignal) => Promise<string>;
}
export interface ReaderEvents {
  /** Show (or hide with null) a preview of an internal link's target. */
  linkPreview?: (preview: LinkPreview | null) => void;
  /** An internal link is about to move away from this location. */
  internalLink?: (origin: DocumentLocation) => void;
  epubInteraction?: () => void;
  epubReadingAnchor?: (blockId: string) => void;
  /** Only paragraphs retained by the EPUB reader window. */
  epubBlocksChanged?: (blocks: EPUBReadingBlock[]) => void;
  /** Pointer over an EPUB paragraph, or null when it leaves. */
  epubBlockHover?: (blockId: string | null) => void;
  /** A click on an EPUB paragraph; the default centers it in the source. */
  epubBlockFocus?: (blockId: string) => void;
  /** The copy, ask-AI or preview button on a hovered EPUB paragraph. */
  epubBlockAction?: (block: EPUBReadingBlock, action: PDFBlockAction) => void;
  blockHover?: (block: PDFBlock | null) => void;
  annotation?: (target: ReaderAnnotationTarget | null) => void;
  /** Hover preview only; never select or copy annotation text. */
  annotationHover?: (target: ReaderAnnotationTarget | null) => void;
  zoom?: (
    zoom: ReaderTheme["zoom"],
    origin?: "focus" | "layout",
    widthRatio?: number,
  ) => void;
  readingAnchor?: (anchor: PDFReadingAnchor) => void;
  blockFocus?: (block: PDFBlock) => void;
  blockAction?: (block: PDFBlock, action: PDFBlockAction) => void;
  location: (location: DocumentLocation, percentage: number) => void;
  selection: (selection: ReaderSelection | null) => void;
}
export interface ReaderAdapter {
  open(document: Document): Promise<void>;
  getTOC(): Promise<TOCItem[]>;
  getPageCount?(): number;
  getLocation(): DocumentLocation;
  goTo(location: DocumentLocation): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  search(query: string): Promise<SearchResult[]>;
  getSelection(): ReaderSelection | null;
  clearSelection(): void;
  highlight(annotations: Annotation[]): Promise<void>;
  setTheme(theme: ReaderTheme): Promise<void>;
  /** Layout choices that must apply before the first page is shown. */
  preferTheme?(theme: ReaderTheme): void;
  getContext(): Promise<string>;
  /** Whether most of a remembered viewport position is on screen again. */
  isNear?(location: DocumentLocation): boolean;
  setBlocks?(blocks: PDFBlock[]): void;
  setSearchBlocks?(blockIds: string[]): void;
  setEPUBBlocks?(blocks: EPUBReadingBlock[]): void;
  getEPUBChapters?(): EPUBChapter[];
  focusEPUBLocations?(locations: EPUBLocation[]): Promise<void>;
  hoverBlock?(blockId: string | null): void;
  /** Re-renders a PDF block from vectors; `width` targets device pixels. */
  renderBlockImage?(
    blockId: string,
    signal: AbortSignal,
    width?: number,
  ): Promise<Blob>;
  followBlock?(anchor: PDFReadingAnchor): Promise<void>;
  previewCitation?(
    location: PDFLocation,
    anchor: HTMLAnchorElement,
  ): Promise<void>;
  hideCitationPreview?(): void;
  resolveCitation?(
    blockId: string,
    label: string,
  ): Promise<PDFLocation | undefined>;
  focusSentences?(
    blockId: string,
    sources: string[],
    scroll?: boolean,
  ): Promise<void>;
  sentenceRanges?(passages: PDFPassage[]): Range[];
  prepareAnnotation?(selection: ReaderSelection): Promise<ReaderSelection>;
  focusPassages?(passages: PDFPassage[], scroll?: boolean): Promise<void>;
  matchSentences?(
    location: PDFLocation,
    translations: TranslationBlock[],
  ): Promise<PDFSentenceLink[]>;
  focusBlock?(blockId: string, layout: "source" | "parallel"): Promise<void>;
  /** Center the paragraph containing a saved location, like clicking it. */
  focusLocation?(location: DocumentLocation): Promise<void>;
  /** Center the source block for a chat reference when one can be located. */
  focusReference?(location: DocumentLocation, text: string): Promise<boolean>;
  /** Briefly mark the source block after following a chat reference. */
  flashReference?(location: DocumentLocation, text: string): void;
  /** Save single-pane PDF zoom before a synchronized mode transition. */
  captureSourceZoom?(): void;
  /** Restore zoom and center after single-pane layout commits; return true if positioned.
   * After manual navigation, preserve the current reading center instead of the saved one. */
  restoreSourceZoom?(preserveCurrentCenter?: boolean): boolean;
  cancelBlockFocus?(): void;
  destroy(): Promise<void>;
}
export function locationLabel(location?: DocumentLocation): string {
  if (!location) return "尚未开始";
  return location.type === "pdf"
    ? `第 ${location.page} 页`
    : `章节进度 ${Math.round((location.progression ?? 0) * 100)}%`;
}
export interface Provider {
  id: "codex" | "claude" | "kimi" | "api";
  installed: boolean;
  authenticated: boolean;
  status: string;
}
export interface SourceReference {
  /** Rendered page evidence, separate from extracted text. */
  pageImage?: {
    page: number;
    width: number;
    height: number;
    bytes: number;
    sourceId: string;
    corpusRevision: string;
    contentHash: string;
  };
  /** Server-issued evidence from a completed document reading attempt. */
  sourceId?: string;
  corpusRevision?: string;
  contentHash?: string;
  precision?: "page" | "block" | "paragraph";
  text: string;
  location: DocumentLocation;
  kind?: "selection" | "section";
}
export interface ImageAttachment {
  id: string;
  page: number;
  label: string;
  caption?: string;
}
export interface ToolActivity {
  id: string;
  kind: "search" | "web" | "tool";
  tool: string;
  title: string;
  target?: string;
  url?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  detail?: string;
  startedAt: string;
  finishedAt?: string;
}
export interface WebSource {
  id: string;
  url: string;
  title: string;
  text?: string;
  kind: "search" | "page";
  retrievedAt: string;
  publishedAt?: string;
  truncated?: boolean;
}
export interface Message {
  webSearch?: boolean;
  tools?: ToolActivity[];
  webSources?: WebSource[];
  sessionId?: string;
  /** Provider-returned thinking, displayed separately and never added to answer context. */
  reasoning?: string;
  /** Navigation snapshot at send time; not an original-text citation. */
  readingLocation?: DocumentLocation;
  attachments?: ImageAttachment[];
  context?: string;
  references?: SourceReference[];
  id: string;
  documentId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ProcessingStage {
  status: "queued" | "running" | "waiting" | "failed" | "complete";
  detail: string;
  warning?: string;
}
export interface Processing {
  retranslating?: boolean;
  layoutRevision?: string;
  autoTranslateMaxPages?: number;
  manualTranslation?: boolean;
  enabled?: boolean;
  translating?: ProcessingStage;
  usageTracked?: boolean;
  startedAt?: string;
  completedAt?: string;
  incomplete?: boolean;
  documentId: string;
  phase: "learning" | "translating" | "ready";
  status: "queued" | "running" | "waiting" | "failed" | "complete" | "paused";
  pagesDone: number;
  pagesTotal: number;
  translationsDone: number;
  translationsTotal: number;
  detail: string;
  warning?: string;
  updatedAt: string;
  /** Background layout parsing of a book PDF; stays `complete` when done. */
  bookLayout?: {
    status: "queued" | "running" | "failed" | "complete";
    pagesDone: number;
    pagesTotal: number;
  };
}
export interface PDFBlock {
  id: string;
  page: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  text: string;
  image?: string;
  caption?: string;
}
export interface EPUBReadingBlock {
  image?: string;
  id: string;
  label: string;
  text: string;
  location: EPUBLocation;
}
export interface TranslationSentence {
  /** The model's sentence; it may repair PDF extraction errors. */
  source: string;
  target: string;
  /** Extracted text the sentence covers, when it differs from `source`. */
  anchor?: string;
}
/** Text used to find a sentence in the PDF text layer. */
export function sentenceAnchor(sentence: TranslationSentence): string {
  return sentence.anchor || sentence.source;
}
export interface TranslationBlock {
  blockId: string;
  sourceHash: string;
  /** idle: a book paragraph nobody has requested yet. */
  status: "idle" | "pending" | "running" | "complete" | "failed";
  sentences: TranslationSentence[];
  formulaMarkdown?: string;
  error?: string;
}
export interface AICapability {
  /** Observed time to first reasoning or text output, excluding catalog lookup. */
  textFirstOutputMs?: number;
  visionFirstOutputMs?: number;
  tools?: "passed" | "unsupported" | "failed";
  toolSchemaVersion?: string;
  toolError?: string;
  pendingVision?: boolean;
  text: boolean;
  vision: boolean;
  checkedAt: string;
  error?: string;
}
export interface APIConnection {
  /** Auto detects official endpoints; other addresses use OpenAI Chat Completions. */
  protocol?: "auto" | "openai" | "anthropic";
  url: string;
  model: string;
  key?: string;
  hasKey: boolean;
}
export type ReasoningEffort = "low" | "medium" | "high" | "max";

export interface WebSearchConfig {
  cliEnabled: boolean;
  provider: "" | "deepseek";
  url: string;
  key?: string;
  hasKey: boolean;
}

export interface AIConfig {
  /** Persistent search permissions and a search connection independent of the model. */
  webSearch?: WebSearchConfig;
  primary: string;
  models: Record<string, string>;
  efforts?: Record<string, Record<string, ReasoningEffort>>;
  translationModels?: Record<string, string>;
  translationEfforts?: Record<string, Record<string, ReasoningEffort>>;
  /** Translation style and terminology preferences. Empty uses the default. */
  translationPrompt?: string;
  /** Image-input model of the "api" agent; other agents use their chat model. */
  visionModels?: Record<string, string>;
  visionEfforts?: Record<string, Record<string, ReasoningEffort>>;
  /** Model IDs the user added beside the API endpoint's /models list. */
  apiModels?: string[];
  /** Endpoint of the "api" agent; its models are chosen per task above. */
  api: APIConnection;
  textAPI: APIConnection;
  imageAPI: APIConnection;
  capabilities: Record<string, AICapability>;
}
export interface AgentModel {
  contextWindow?: number;
  maxOutputTokens?: number;
  effortInfo?: {
    mode: "levels" | "budget" | "fixed" | "unknown";
    note: string;
    mappings?: Partial<Record<ReasoningEffort, string>>;
  };
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  aliases?: string[];
  recommendedFor?: ModelTask[];
  /** API agent: a model ID the user added. */
  custom?: boolean;
  /** API agent: this model's own check result. */
  capability?: AICapability;
}
/** "vision" is the API agent's image-input model. */
export type ModelTask = "chat" | "translation" | "vision";

export { isPDFPageDecoration } from "./pdf-content";

export { pdfFontAscent } from "./pdf-text";

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  reasoningOutputTokens: number | null;
}
export interface ModelTokens {
  model: string;
  tokens: TokenCounts | null;
}
export interface UsageCall {
  id: string;
  stage: string;
  target: string;
  provider: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  models: ModelTokens[];
}
export interface UsageGroup {
  stage: string;
  provider: string;
  model: string;
  calls: number;
  unknownCalls: number;
  tokens: TokenCounts;
}
export interface ProcessingUsage {
  historyComplete: boolean;
  total: TokenCounts;
  calls: UsageCall[];
  groups: UsageGroup[];
  stages: { stage: string; durationMs: number }[];
  unknownCalls: number;
  failedCalls: number;
  partialCalls: number;
  elapsedMs: number;
}

export interface EPUBChapter {
  href: string;
  title: string;
  index: number;
  characters: number;
  blocks: EPUBReadingBlock[];
}
export interface EPUBChapterLink {
  href: string;
  title: string;
  children?: EPUBChapterLink[];
}
export interface EPUBChapters {
  chapters: EPUBChapter[];
  toc: EPUBChapterLink[] | null;
}

export interface OverviewContent {
  summary: string;
  findings: { text: string; blockIds: string[] }[];
  limitations: { text: string; blockIds: string[] }[];
  terms: string[];
}
export interface OverviewSection {
  key: string;
  title: string;
  firstBlockId: string;
  lastBlockId: string;
  location: DocumentLocation;
  passageCount: number;
  content: OverviewContent;
}
export type OverviewStatus =
  | "missing"
  | "queued"
  | "running"
  | "waiting"
  | "complete"
  | "partial"
  | "failed"
  | "canceled"
  | "stale";
export interface OverviewJob {
  documentId: string;
  status: OverviewStatus;
  error?: string;
  compiledPassages: number;
  totalPassages: number;
}
export interface DocumentOverview extends OverviewJob {
  stale: boolean;
  sources?: { blockId: string; label: string; location: DocumentLocation }[];
  corpusRevision: string;
  compilerVersion: string;
  content?: OverviewContent;
  sections: OverviewSection[];
  coverage: {
    status: string;
    totalUnits: number;
    searchableUnits: number;
    missingRanges: string[];
    warnings: string[];
  };
  updatedAt: string;
}
export type {
  ProxySettings,
  ProxySettingsState,
  ProxyCheckResult,
} from "./proxy-settings";
export type { UpdateProgress } from "./update-progress";
export type { CommandLineStatus } from "./command-line";

export interface ChatRun {
  id: string;
  sessionId: string;
  documentId: string;
  userMessageId: string;
  provider: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  error?: string;
  startedAt: string;
  finishedAt?: string;
}
export interface DocumentChatSession {
  id: string;
  documentId: string;
  title: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  latestRun?: ChatRun;
}
