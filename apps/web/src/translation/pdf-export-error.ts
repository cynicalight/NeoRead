/** Stable diagnostic categories. Never derive log values from exception text. */
const reasons = {
  snapshot: "load",
  module_load: "load",
  layout: "layout",
  save: "save",
  download: "download",
  unrecognized: "unknown",
} as const;
export type PDFExportFailure = keyof typeof reasons;

export class PDFExportError extends Error {
  constructor(
    readonly reason: PDFExportFailure,
    cause?: unknown,
  ) {
    super(
      cause instanceof Error ? cause.message : "译文 PDF 导出失败，请重试",
      { cause },
    );
    this.name = "PDFExportError";
  }
}

export function exportFailure(
  error: unknown,
  fallback: PDFExportFailure,
): PDFExportError {
  if (error instanceof PDFExportError) return error;
  return new PDFExportError(fallback, error);
}

export async function exportOperation<T>(
  reason: PDFExportFailure,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw exportFailure(error, reason);
  }
}

export function exportFailureDetail(error: unknown): string {
  // Runtime whitelist also rejects accidentally forged/mutated error reasons.
  const reason =
    error instanceof PDFExportError && Object.hasOwn(reasons, error.reason)
      ? error.reason
      : "unrecognized";
  return `errorCode=${reasons[reason]} reasonCode=${reason}`;
}
