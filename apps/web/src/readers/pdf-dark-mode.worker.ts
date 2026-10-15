import {
  processPDFPagePixels,
  type PDFDarkImageMode,
  type PDFDarkContrast,
  type PDFDarkRegion,
} from "./pdf-dark-mode";

const workerScope = self as typeof self & {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

workerScope.onmessage = (
  event: MessageEvent<{
    id: number;
    pixels: ArrayBuffer;
    width: number;
    height: number;
    bitmapRegions: PDFDarkRegion[];
    figureRegions: PDFDarkRegion[];
    mode: PDFDarkImageMode;
    contrast: PDFDarkContrast;
  }>,
) => {
  const {
    id,
    pixels,
    width,
    height,
    bitmapRegions,
    figureRegions,
    mode,
    contrast,
  } = event.data;
  const output = processPDFPagePixels(
    new Uint8ClampedArray(pixels),
    width,
    height,
    bitmapRegions,
    figureRegions,
    mode,
    contrast,
  );
  workerScope.postMessage(
    { id, pixels: output.buffer },
    { transfer: [output.buffer] },
  );
};
