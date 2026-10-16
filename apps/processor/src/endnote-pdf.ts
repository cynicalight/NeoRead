import type {
  PDFDocumentLoadingTask,
  DocumentInitParameters,
  PDFPageProxy,
} from "pdfjs-dist/types/src/display/api";

type Rect = { x: number; y: number; width: number; height: number };
export interface ImportedPDFMark {
  key: string;
  kind: "highlight" | "underline" | "note";
  location: { type: "pdf"; page: number; rects: Rect[] };
  quote: string;
  note: string;
  color: string;
}
export async function migratePDFMarks(
  getDocument: (params: DocumentInitParameters) => PDFDocumentLoadingTask,
  bytes: Uint8Array,
) {
  const task = getDocument({ data: bytes, verbosity: 0 });
  const marks: ImportedPDFMark[] = [];
  const warnings: string[] = [];
  const removed = new Set<string>();
  const retained = new Map<number, string[]>();
  try {
    const pdf = await task.promise;
    if (pdf.isPureXfa) throw new Error("暂不支持 XFA PDF");
    const pageAnnotations = new Map<
      number,
      Awaited<ReturnType<PDFPageProxy["getAnnotations"]>>
    >();
    const parentsWithReplies = new Set<string>();
    for (let n = 1; n <= pdf.numPages; n++) {
      const annotations = await (await pdf.getPage(n)).getAnnotations();
      pageAnnotations.set(n, annotations);
      for (const a of annotations)
        if (a.inReplyTo) parentsWithReplies.add(a.inReplyTo);
    }
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const annotations = pageAnnotations.get(n)!;
      const text = await page.getTextContent();
      retained.set(
        n,
        annotations.map((a) => a.id),
      );
      for (const a of annotations) {
        if (["Link", "Popup"].includes(a.subtype)) continue;
        const kind = (
          {
            Highlight: "highlight",
            Underline: "underline",
            Text: "note",
          } as const
        )[a.subtype as "Highlight" | "Underline" | "Text"];
        const skip = () => {
          warnings.push(
            `第 ${n} 页 ${a.subtype || "未知"} 标记未转换，保留在 PDF 中`,
          );
        };
        if (
          !kind ||
          !/^\d+R(?:\d+)?$/.test(a.id) ||
          a.inReplyTo ||
          parentsWithReplies.has(a.id)
        ) {
          skip();
          continue;
        }
        const points: number[][] = [];
        if (kind === "note") points.push(a.rect);
        else {
          const q = a.quadPoints as ArrayLike<number> | undefined;
          if (!q?.length || q.length % 8) {
            skip();
            continue;
          }
          for (let i = 0; i < q.length; i += 8) {
            const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
            const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
            // Reader can faithfully represent axis-aligned quadrilaterals only.
            if (
              new Set(xs.map((x) => x.toFixed(2))).size > 2 ||
              new Set(ys.map((y) => y.toFixed(2))).size > 2
            ) {
              points.length = 0;
              break;
            }
            points.push([
              Math.min(...xs),
              Math.min(...ys),
              Math.max(...xs),
              Math.max(...ys),
            ]);
          }
        }
        const rects: Rect[] = [];
        for (const point of points) {
          if (point?.length !== 4 || !point.every(Number.isFinite)) break;
          const [x1, y1] = viewport.convertToViewportPoint(point[0], point[1]);
          const [x2, y2] = viewport.convertToViewportPoint(point[2], point[3]);
          const r = {
            x: Math.min(x1, x2) / viewport.width,
            y: Math.min(y1, y2) / viewport.height,
            width: Math.abs(x2 - x1) / viewport.width,
            height: Math.abs(y2 - y1) / viewport.height,
          };
          if (
            r.width <= 0 ||
            r.height <= 0 ||
            r.x < 0 ||
            r.y < 0 ||
            r.x + r.width > 1.00001 ||
            r.y + r.height > 1.00001
          )
            break;
          rects.push(r);
        }
        if (!rects.length || rects.length !== points.length) {
          skip();
          continue;
        }
        const quote =
          kind === "note"
            ? ""
            : text.items
                .flatMap((item) => {
                  if (!("str" in item)) return [];
                  const [x, y] = viewport.convertToViewportPoint(
                    item.transform[4] + item.width / 2,
                    item.transform[5] + item.height / 2,
                  );
                  return rects.some(
                    (r) =>
                      x / viewport.width >= r.x &&
                      x / viewport.width <= r.x + r.width &&
                      y / viewport.height >= r.y &&
                      y / viewport.height <= r.y + r.height,
                  )
                    ? [item.str]
                    : [];
                })
                .join(" ");
        const note = a.contentsObj?.str || "";
        if (quote.length > 100000 || note.length > 100000) {
          skip();
          continue;
        }
        const color =
          a.color?.length === 3
            ? "#" +
              Array.from(a.color as Uint8ClampedArray)
                .map((x) => x.toString(16).padStart(2, "0"))
                .join("")
            : "#ffd400";
        marks.push({
          key: `${n}:${a.id}`,
          kind,
          location: { type: "pdf", page: n, rects },
          quote,
          note,
          color,
        });
        removed.add(`${n}:${a.id}`);
        if (a.popupRef) removed.add(`${n}:${a.popupRef}`);
        pdf.annotationStorage.setValue(
          `pdfjs_internal_editor_endnote_${n}_${a.id}`,
          {
            id: a.id,
            pageIndex: n - 1,
            deleted: true,
            popupRef: a.popupRef,
          },
        );
      }
    }
    const output = marks.length
      ? await pdf.saveDocument()
      : await pdf.getData();
    // A save warning must never silently leave duplicate visual marks behind.
    const check = getDocument({ data: output.slice(), verbosity: 0 });
    try {
      const saved = await check.promise;
      if (saved.numPages !== pdf.numPages) throw new Error("PDF 页数发生变化");
      for (let n = 1; n <= saved.numPages; n++) {
        const annotations = await (await saved.getPage(n)).getAnnotations();
        if (
          annotations.some((a) => removed.has(`${n}:${a.id}`)) ||
          retained
            .get(n)!
            .some(
              (id) =>
                !removed.has(`${n}:${id}`) &&
                !annotations.some((a) => a.id === id),
            )
        )
          throw new Error("PDF 标记清理校验失败");
      }
    } finally {
      await check.destroy();
    }
    return { bytes: output, marks, warnings };
  } finally {
    await task.destroy();
  }
}
