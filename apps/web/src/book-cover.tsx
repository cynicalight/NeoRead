import { useState } from "react";
import { create } from "zustand";
import type { Document } from "@neoread/core";
import { api, coverURL, publicationURL } from "@neoread/api";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { diagnosticError } from "../../../packages/neoread-core/src/diagnostics";
import { reportDiagnostic } from "./diagnostics";

/** Width of a rendered PDF cover: twice the grid card for sharp screens. */
const coverWidth = 420;

const useCovers = create<{
  /** Changes whenever the cover must be fetched again. */
  revisions: Record<string, number>;
  /** Documents without a cover; they keep the drawn placeholder. */
  missing: Record<string, true>;
}>(() => ({ revisions: {}, missing: {} }));

const attempted = new Set<string>();
const rendering = new Map<string, Promise<void>>();
let running = 0;
const waiting: (() => void)[] = [];

/** Renders at most two PDFs at once so a large library stays responsive. */
async function limited<T>(task: () => Promise<T>) {
  if (running >= 2) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Draws the first page of a PDF as a JPEG. */
export async function renderPDFCover(
  doc: Pick<Document, "id">,
  revision?: number,
) {
  // Loaded on demand so the library does not carry the PDF engine.
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc ||= workerURL;
  const task = pdfjs.getDocument({
    url: publicationURL(
      doc.id,
      `original.pdf${revision ? `?v=${revision}` : ""}`,
    ),
    // Fetch only the ranges the first page needs.
    disableStream: true,
    disableAutoFetch: true,
    cMapUrl: "/pdf-assets/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdf-assets/standard_fonts/",
    wasmUrl: "/pdf-assets/wasm/",
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: Math.min(coverWidth / base.width, 3000 / base.height),
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({
      canvas,
      canvasContext: canvas.getContext("2d")!,
      viewport,
      annotationMode: pdfjs.AnnotationMode.DISABLE,
      // JPEG has no alpha; transparent pages would turn black.
      background: "white",
    }).promise;
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("封面渲染失败"))),
        "image/jpeg",
        0.85,
      ),
    );
  } finally {
    void task.destroy();
  }
}

function coverFailed(doc: Document) {
  const missing = () =>
    useCovers.setState((s) => ({ missing: { ...s.missing, [doc.id]: true } }));
  // Another view of the same PDF is already rendering its cover.
  if (rendering.has(doc.id)) return;
  if (doc.type !== "pdf" || attempted.has(doc.id)) return missing();
  // A PDF has no stored cover until its first page is rendered once.
  attempted.add(doc.id);
  const task = limited(async () =>
    api.saveCover(doc.id, await renderPDFCover(doc)),
  )
    .then(() =>
      useCovers.setState((s) => ({
        revisions: { ...s.revisions, [doc.id]: Date.now() },
      })),
    )
    .catch((error) => {
      // The upload is logged by the API client; rendering is not.
      reportDiagnostic({
        level: "warn",
        event: "cover.render_failed",
        ...diagnosticError(error),
      });
      missing();
    })
    .finally(() => rendering.delete(doc.id));
  rendering.set(doc.id, task);
}

/** Reparse already rebuilds EPUB resources; PDF covers are drawn here. */
export async function refreshDocumentCover(doc: Document) {
  // An earlier lazy render must finish before it can overwrite the new cover.
  await rendering.get(doc.id);
  const revision = Math.max(
    Date.now(),
    (useCovers.getState().revisions[doc.id] ?? 0) + 1,
  );
  if (doc.type === "pdf") {
    const task = limited(async () =>
      api.saveCover(doc.id, await renderPDFCover(doc, revision)),
    ).finally(() => rendering.delete(doc.id));
    rendering.set(doc.id, task);
    try {
      await task;
    } catch (error) {
      reportDiagnostic({
        level: "warn",
        event: "cover.render_failed",
        ...diagnosticError(error),
      });
      throw error;
    }
  }
  attempted.delete(doc.id);
  useCovers.setState((s) => {
    const missing = { ...s.missing };
    delete missing[doc.id];
    return { missing, revisions: { ...s.revisions, [doc.id]: revision } };
  });
}

/** The document's cover image; renders nothing when it has none. */
export function BookCoverImage({ doc }: { doc: Document }) {
  const revision = useCovers((s) => s.revisions[doc.id]);
  const missing = useCovers((s) => s.missing[doc.id]);
  const [loaded, setLoaded] = useState<string>();
  const src = coverURL(doc.id, revision);
  if (missing) return null;
  return (
    <img
      key={src}
      className="book-cover-image"
      src={src}
      alt=""
      draggable={false}
      data-loaded={loaded === src}
      onLoad={() => setLoaded(src)}
      onError={() => coverFailed(doc)}
    />
  );
}
