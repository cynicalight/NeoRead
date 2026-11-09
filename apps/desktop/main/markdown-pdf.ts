import { BrowserWindow } from "electron";

// Isolated, transient documents never receive the app preload or library access.
const pending = new Map<string, BrowserWindow>();
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
        !details.url.startsWith("data:text/html;") &&
        !/^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,/.test(
          details.url,
        ),
    });
  });
  const timer = setTimeout(() => cancelMarkdownPDF(id), 60_000);
  try {
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    return await window.webContents.printToPDF({
      pageSize: "A4",
      preferCSSPageSize: true,
      printBackground: true,
    });
  } finally {
    clearTimeout(timer);
    pending.delete(id);
    if (!window.isDestroyed()) window.destroy();
  }
}
