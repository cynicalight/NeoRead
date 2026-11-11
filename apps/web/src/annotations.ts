import type {
  Annotation,
  DocumentLocation,
  HighlightColor,
  ReaderSelection,
  ReaderTheme,
} from "@neoread/core";

export function annotationRequests(
  kind: Annotation["kind"],
  selection: ReaderSelection | null | undefined,
  target: DocumentLocation,
  note: string,
  color: string,
) {
  const parts =
    (kind === "highlight" || kind === "underline") && selection?.parts?.length
      ? selection.parts
      : [selection];
  return parts.map((part) => ({
    kind,
    location: kind === "bookmark" ? target : (part?.location ?? target),
    quote: kind === "bookmark" ? "" : part?.text || "",
    note,
    color,
  }));
}

export function activeAnnotation(items: Annotation[], ids: string[]) {
  const matches = items.filter((item) => ids.includes(item.id));
  // Prefer an existing note when different kinds mark the same passage.
  return (
    matches.find((item) => item.note.trim()) ??
    matches.find((item) => item.kind === "note") ??
    matches[0]
  );
}

export function applySavedAnnotation(
  items: Annotation[],
  saved: Annotation & { replacedIds?: string[] },
): Annotation[] {
  const { replacedIds = [], ...annotation } = saved;
  const removed = new Set(replacedIds);
  const next = items.filter((item) => !removed.has(item.id));
  const index = next.findIndex((item) => item.id === annotation.id);
  if (index < 0) next.push(annotation);
  else next[index] = annotation;
  return next;
}

/** Reading order comes from the saved location, without loading document text. */
export function documentOrder(a: Annotation, b: Annotation) {
  const x = a.location,
    y = b.location;
  if (x.type === "pdf" && y.type === "pdf")
    return (
      x.page - y.page ||
      (x.rects?.[0]?.y ?? x.y ?? 0) - (y.rects?.[0]?.y ?? y.y ?? 0) ||
      (x.rects?.[0]?.x ?? 0) - (y.rects?.[0]?.x ?? 0)
    );
  if (x.type === "epub" && y.type === "epub") return epubAnnotationOrder(a, b);
  return a.createdAt.localeCompare(b.createdAt);
}

/** Default highlight colors; the first is the color of older marks. */
export const highlightColors: HighlightColor[] = [
  { value: "#e6b94c", label: "黄色" },
  { value: "#6cc58c", label: "绿色" },
  { value: "#5b9fe8", label: "蓝色" },
  { value: "#e8746b", label: "红色" },
];
export const MAX_HIGHLIGHT_COLORS = 8;
/** Colors marks may carry from earlier palettes, so they keep their names. */
const retiredColors: HighlightColor[] = [{ value: "#a985e0", label: "紫色" }];

/** The user's palette, or the defaults when it is unset or empty. */
export const highlightPalette = (
  theme?: Pick<ReaderTheme, "highlightColors">,
) => (theme?.highlightColors?.length ? theme.highlightColors : highlightColors);

export const colorLabel = (
  color: string,
  palette: HighlightColor[] = highlightColors,
) =>
  [...palette, ...highlightColors, ...retiredColors].find(
    (c) => c.value.toLowerCase() === color.toLowerCase(),
  )?.label || "其他颜色";

export const validHighlightColor = (value: string) =>
  /^#[0-9a-f]{6}$/i.test(value);

/** Keep successful writes visible and leave only unsaved parts available to retry. */
export async function saveAnnotationParts<T extends Annotation>(
  selection: ReaderSelection,
  save: (part: {
    text: string;
    location: ReaderSelection["location"];
  }) => Promise<T>,
  saved: (annotation: T) => void,
  pending: (selection: ReaderSelection) => void,
): Promise<T> {
  const parts = selection.parts?.length ? selection.parts : [selection];
  let first: T | undefined;
  for (let i = 0; i < parts.length; i++) {
    pending({ ...selection, ...parts[i], parts: parts.slice(i) });
    const result = await save(parts[i]);
    saved(result);
    first ??= result;
  }
  return first!;
}

/** EPUB block IDs are opaque; persist reading order with each annotation. */
export function epubAnnotationOrder(a: Annotation, b: Annotation) {
  const position = (annotation: Annotation): number[] | undefined => {
    const location = annotation.location;
    if (location.type !== "epub" || location.unresolved) return;
    const translated = location.translation;
    const source = translated?.ranges?.[0]?.location;
    const order = location.order ?? source?.order;
    if (
      !order ||
      !Number.isSafeInteger(order.chapter) ||
      !Number.isSafeInteger(order.block) ||
      order.chapter < 0 ||
      order.block < 0
    )
      return;
    return [
      order.chapter,
      order.block,
      location.start ?? source?.start ?? 0,
      translated ? 1 : 0,
      translated?.ranges?.[0]?.start ?? translated?.start ?? 0,
    ];
  };
  const x = position(a),
    y = position(b);
  if (x && y) {
    for (let i = 0; i < x.length; i++) {
      const difference = x[i] - y[i];
      if (difference) return difference;
    }
  } else if (x || y) return x ? -1 : 1;
  // Historical or unresolved marks stay accessible without a full-book backfill.
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
