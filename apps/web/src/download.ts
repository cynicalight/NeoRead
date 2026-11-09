/** Save a file through the browser download flow (a save dialog in Electron). */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadText(text: string, name: string, mime: string) {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), name);
}
/** Desktop exports await the native save result instead of firing overlapping downloads. */
export async function saveExportBlob(
  blob: Blob,
  name: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const save = window.neoreadDesktop?.saveExportFile;
  if (!save) {
    downloadBlob(blob, name);
    return;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  signal.throwIfAborted();
  if (!(await save(name, bytes)))
    throw new DOMException("已取消导出", "AbortError");
  signal.throwIfAborted();
}

export function exportCancelled(error: unknown, signal: AbortSignal) {
  return (
    signal.aborted ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError")
  );
}

/** A file name from a document title, without characters file systems reject. */
export function fileTitle(title: string) {
  return title.replace(/[/\\:*?"<>|]/g, "-").slice(0, 80);
}
