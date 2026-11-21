import { createCanvas } from "@napi-rs/canvas";
import type { PDFPageProxy } from "pdfjs-dist";

/** Shared by layout analysis and visual reading; no layout model is required. */
export async function renderPage(page: PDFPageProxy, minLongEdge = 0) {
  const original = page.getViewport({ scale: 1 });
  const scale = Math.min(
    Math.max(2, minLongEdge / Math.max(original.width, original.height)),
    Math.sqrt(4_000_000 / (original.width * original.height)),
    16384 / Math.max(original.width, original.height),
  );
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: canvas.getContext(
      "2d",
    ) as unknown as CanvasRenderingContext2D,
    viewport,
    background: "white",
  }).promise;
  return { canvas, scale };
}
