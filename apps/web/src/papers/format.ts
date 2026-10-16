import type {
  Creator,
  Document,
  PaperItemType,
  PaperMetadata,
} from "@reader/core";

export const itemTypeLabels: Record<PaperItemType, string> = {
  journal: "期刊论文",
  conference: "会议论文",
  preprint: "预印本",
  thesis: "学位论文",
  book: "图书",
  chapter: "图书章节",
  report: "报告",
  other: "其他",
};

const han = /\p{Script=Han}/u;

export const creatorName = (c: Creator) =>
  c.name || [c.given, c.family].filter(Boolean).join(" ");

/** Metadata creators, or the display author split on commas as a fallback. */
export function paperCreators(doc: Pick<Document, "author" | "metadata">) {
  if (doc.metadata.creators?.length) return doc.metadata.creators;
  return doc.author
    .split(/\s*[,;，；]\s*|\s+and\s+/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name): Creator => ({ name }));
}

/** "A, B, C 等" or "A, B, C et al." depending on the first author's script. */
export function authorsShort(
  doc: Pick<Document, "author" | "metadata">,
  limit = 3,
) {
  const names = paperCreators(doc).map(creatorName);
  if (names.length <= limit) return names.join(", ");
  return (
    names.slice(0, limit).join(", ") + (han.test(names[0]) ? " 等" : " et al.")
  );
}

export const paperYear = (metadata: PaperMetadata) =>
  /^\d{4}/.exec(metadata.date || "")?.[0] || "";

/** The paper's landing page: an explicit URL, else derived from arXiv or DOI. */
export function paperLink(metadata: PaperMetadata) {
  if (metadata.url) return metadata.url;
  if (metadata.arxiv)
    return `https://arxiv.org/abs/${metadata.arxiv.replace(/v\d+$/, "")}`;
  if (metadata.doi) return `https://doi.org/${metadata.doi}`;
  return "";
}

/** Sidebar title: the stored short title, else the part before a colon. */
export function shortTitle(doc: Pick<Document, "title" | "metadata">) {
  if (doc.metadata.shortTitle) return doc.metadata.shortTitle;
  const head = doc.title.split(/[:：]\s/)[0].trim();
  return head.length >= 4 ? head : doc.title;
}

export function venueLabel(metadata: PaperMetadata) {
  if (metadata.venue) return metadata.venue;
  return metadata.arxiv ? `arXiv:${metadata.arxiv}` : "";
}

/** Author · year · venue for list rows. */
export function paperByline(doc: Pick<Document, "author" | "metadata">) {
  return [authorsShort(doc), paperYear(doc.metadata), venueLabel(doc.metadata)]
    .filter(Boolean)
    .join(" · ");
}

/** One author per line: "Family, Given", "Given Family" or a single name. */
export function parseCreators(text: string): Creator[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const comma = /^([^,，]+)[,，]\s*(.+)$/.exec(line);
      if (comma) return { family: comma[1].trim(), given: comma[2].trim() };
      if (han.test(line) || !/\s/.test(line)) return { name: line };
      const parts = line.split(/\s+/);
      const family = parts.pop()!;
      return { given: parts.join(" "), family };
    });
}

export const formatCreators = (creators: Creator[]) =>
  creators
    .map((c) =>
      c.name ? c.name : c.given ? `${c.family}, ${c.given}` : c.family || "",
    )
    .join("\n");

/** Legacy imports stored an import timestamp here; progress is additional evidence of opening. */
export const wasOpened = (
  doc: Pick<Document, "createdAt" | "lastOpenedAt" | "progress">,
) =>
  !!doc.lastOpenedAt &&
  (!!doc.progress ||
    Date.parse(doc.lastOpenedAt) - Date.parse(doc.createdAt) > 1000);

export function relativeTime(value: string, now = Date.now()) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "";
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(time).toLocaleDateString("zh-CN");
}

/** Preserve date precision; do not invent a month/day or parse in local time. */
export function publicationDate(value = "") {
  const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]),
    month = Number(match[2] || 1),
    day = Number(match[3] || 1);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1])
    return undefined;
  return {
    label: [
      match[1],
      ...(match[2] ? [String(month).padStart(2, "0")] : []),
      ...(match[3] ? [String(day).padStart(2, "0")] : []),
    ].join("-"),
    key: year * 10000 + (match[2] ? month * 100 : 0) + (match[3] ? day : 0),
    year,
  };
}

export const paperProgress = (percentage: number) =>
  Math.round(
    Math.min(1, Math.max(0, Number.isFinite(percentage) ? percentage : 0)) *
      100,
  );

export function fileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
