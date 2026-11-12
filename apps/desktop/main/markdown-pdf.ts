import { BrowserWindow } from "electron";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Isolated, transient documents never receive the app preload or library access.
const pending = new Map<string, BrowserWindow>();
const documents = new Map<string, BrowserWindow>();
export function cancelMarkdownPDF(id: string) {
  const window = pending.get(id);
  if (window && !window.isDestroyed()) window.destroy();
}
export async function renderMarkdownPDF(
  id: unknown,
  html: unknown,
): Promise<Uint8Array> {
  if (
    typeof id !== "string" ||
    id.length > 100 ||
    typeof html !== "string" ||
    html.length > 20_000_000
  )
    throw new Error("Invalid print document");
  if (pending.has(id)) throw new Error("Duplicate print request");
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      partition: "markdown-print",
    },
  });
  pending.set(id, window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({
      cancel:
        !(
          details.resourceType === "mainFrame" &&
          documents.has(details.url) &&
          documents.get(details.url)?.webContents.id === details.webContentsId
        ) &&
        !/^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,/.test(
          details.url,
        ),
    });
  });
  const timer = setTimeout(() => cancelMarkdownPDF(id), 60_000);
  let directory: string | undefined;
  let documentURL: string | undefined;
  try {
    // Keep large documents out of Chromium's size-limited navigation URL.
    directory = await mkdtemp(join(tmpdir(), "neoread-markdown-pdf-"));
    const file = join(directory, "document.html");
    await writeFile(file, html, { encoding: "utf8", mode: 0o600 });
    documentURL = pathToFileURL(file).href;
    documents.set(documentURL, window);
    if (window.isDestroyed()) throw new Error("Print request cancelled");
    await window.loadFile(file);
    return await window.webContents.printToPDF({
      pageSize: "A4",
      preferCSSPageSize: true,
      printBackground: true,
    });
  } finally {
    clearTimeout(timer);
    pending.delete(id);
    if (documentURL) documents.delete(documentURL);
    if (!window.isDestroyed()) window.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
