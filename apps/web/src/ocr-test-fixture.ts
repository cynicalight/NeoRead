import type { OCRStatus } from "@neoread/api";

export async function readEmptyOCRStatus(): Promise<OCRStatus> {
  return {
    systemAvailable: false,
    engine: "none",
    modelState: "missing",
    downloadedBytes: 0,
    totalBytes: 89_477_890,
    notices: [],
  };
}
