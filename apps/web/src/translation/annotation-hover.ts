import type { Annotation } from "@neoread/core";

export type AnnotationRange = { annotation: Annotation; range: Range };
// Text boxes are taller than the line pitch, so neighbouring lines touch by a
// few pixels. Count only boxes on the same line that genuinely share text.
const overlaps = (a: DOMRect, b: DOMRect) => {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0)
    return false;
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return (
    height >= Math.min(a.height, b.height) / 2 &&
    width > Math.min(2, Math.min(a.width, b.width) / 2)
  );
};

/** Resolve saved marks across both rendered text and PDF page-relative rectangles. */
export function annotationsInRects(
  host: HTMLElement,
  annotations: Annotation[],
  marks: AnnotationRange[],
  rects: DOMRect[],
): Annotation[] {
  const ids = new Set(
    marks
      .filter(({ range }) =>
        Array.from(range.getClientRects()).some((box) =>
          rects.some((r) => overlaps(box, r)),
        ),
      )
      .map(({ annotation }) => annotation.id),
  );
  const pages = new Map<number, DOMRect | undefined>();
  return annotations.filter((annotation) => {
    if (annotation.kind === "bookmark") return false;
    if (ids.has(annotation.id)) return true;
    const location = annotation.location;
    if (location.type !== "pdf" || location.translation) return false;
    if (!pages.has(location.page))
      pages.set(
        location.page,
        host
          .querySelector<HTMLElement>(
            `.page[data-page-number="${location.page}"]`,
          )
          ?.getBoundingClientRect(),
      );
    const page = pages.get(location.page);
    return (
      !!page &&
      !!location.rects?.some((r) =>
        rects.some((box) =>
          overlaps(
            box,
            new DOMRect(
              page.left + r.x * page.width,
              page.top + r.y * page.height,
              r.width * page.width,
              r.height * page.height,
            ),
          ),
        ),
      )
    );
  });
}

const inside = (r: DOMRect, x: number, y: number) =>
  r.width > 0 &&
  r.height > 0 &&
  x >= r.left &&
  x <= r.right &&
  y >= r.top &&
  y <= r.bottom;

/** Marks directly under the pointer, with the mark boxes that contain it. */
export function annotationsAtPoint(
  host: HTMLElement,
  annotations: Annotation[],
  marks: AnnotationRange[],
  x: number,
  y: number,
  rectsOf: (range: Range) => DOMRect[] = (range) =>
    Array.from(range.getClientRects()),
): { annotations: Annotation[]; rects: DOMRect[] } {
  const hits = new Map<string, DOMRect[]>();
  const hit = (id: string, rect: DOMRect) =>
    hits.set(id, [...(hits.get(id) ?? []), rect]);
  const wanted = new Set(annotations.map((a) => a.id));
  for (const { annotation, range } of marks) {
    if (!wanted.has(annotation.id)) continue;
    for (const rect of rectsOf(range))
      if (inside(rect, x, y)) hit(annotation.id, rect);
  }
  const pages = new Map<number, DOMRect | undefined>();
  for (const annotation of annotations) {
    const location = annotation.location;
    if (location.type !== "pdf" || location.translation) continue;
    if (!pages.has(location.page))
      pages.set(
        location.page,
        host
          .querySelector<HTMLElement>(
            `.page[data-page-number="${location.page}"]`,
          )
          ?.getBoundingClientRect(),
      );
    const page = pages.get(location.page);
    if (!page) continue;
    for (const r of location.rects ?? []) {
      const rect = new DOMRect(
        page.left + r.x * page.width,
        page.top + r.y * page.height,
        r.width * page.width,
        r.height * page.height,
      );
      if (inside(rect, x, y)) hit(annotation.id, rect);
    }
  }
  const found = annotations.filter(
    (a) => a.kind !== "bookmark" && hits.has(a.id),
  );
  return { annotations: found, rects: found.flatMap((a) => hits.get(a.id)!) };
}
