import { contextBridge, ipcRenderer } from "electron";
import { startupAppearanceFromArguments } from "../startup-appearance";
import type { CiteEvent } from "../../../packages/api-client/src/cite-events";
import type { ProxySettings } from "../../../packages/neoread-core/src/proxy-settings";
import type { UpdateProgress } from "../../../packages/neoread-core/src/update-progress";
async function proxyRequest(channel: string, ...args: unknown[]) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    // Electron wraps main-process errors with the IPC channel name. Keep
    // validation messages readable in the settings panel.
    throw new Error(
      (error as Error).message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      ),
    );
  }
}
contextBridge.exposeInMainWorld("neoreadDesktop", {
  platform: process.platform,
  saveExportFile: (name: string, bytes: Uint8Array) =>
    ipcRenderer.invoke("neoread:save-export-file", name, bytes),
  markdownPDF: (id: string, html: string) =>
    ipcRenderer.invoke("neoread:markdown-pdf", id, html),
  cancelMarkdownPDF: (id: string) =>
    ipcRenderer.invoke("neoread:cancel-markdown-pdf", id),
  startupAppearance: startupAppearanceFromArguments(process.argv),
  exportDiagnostics: () => ipcRenderer.invoke("neoread:export-diagnostics"),
  recordDiagnostic: (event: unknown) =>
    ipcRenderer.send("neoread:diagnostic-event", event),
  diagnosticSettings: (settings: unknown) =>
    ipcRenderer.send("neoread:diagnostic-settings", settings),
  checkForUpdates: () => ipcRenderer.invoke("neoread:check-updates"),
  onUpdateProgress: (callback: (progress: UpdateProgress | null) => void) => {
    const listener = (_event: unknown, progress: UpdateProgress | null) =>
      callback(progress);
    ipcRenderer.on("neoread:update-progress", listener);
    return () =>
      ipcRenderer.removeListener("neoread:update-progress", listener);
  },
  proxySettings: () => proxyRequest("neoread:proxy-settings"),
  saveProxySettings: (settings: ProxySettings) =>
    proxyRequest("neoread:save-proxy-settings", settings),
  checkProxy: (settings: ProxySettings) =>
    proxyRequest("neoread:check-proxy", settings),
  restart: () => proxyRequest("neoread:restart"),
  libraryLocation: () => proxyRequest("neoread:library-location"),
  libraryWarning: () => proxyRequest("neoread:library-warning"),
  importLibrary: () => proxyRequest("neoread:import-library"),
  moveLibrary: () => proxyRequest("neoread:move-library"),
  commandLine: () => proxyRequest("neoread:command-line"),
  setCommandLine: (installed: boolean) =>
    proxyRequest("neoread:set-command-line", installed),
  writeClipboardText: (text: string) =>
    ipcRenderer.invoke("neoread:clipboard-write", text),
  writeClipboardImage: (data: Uint8Array, text: string) =>
    ipcRenderer.invoke("neoread:clipboard-write-image", data, text),
  onBeforeClose: (
    callback: () => Promise<void | { noteSaveDiscarded: boolean }>,
  ) => {
    const listener = () => {
      void callback().then(
        (result) =>
          ipcRenderer.send(
            "neoread:flushed",
            null,
            result?.noteSaveDiscarded === true,
          ),
        (error) => ipcRenderer.send("neoread:flushed", String(error)),
      );
    };
    ipcRenderer.on("neoread:flush", listener);
    return () => ipcRenderer.removeListener("neoread:flush", listener);
  },
  setAppearance: (
    appearance: "light" | "sepia" | "dark" | "system",
    palettes: {
      pdfDarkContrast?: "high" | "soft";
      systemLightMode?: "light" | "sepia";
      systemDarkContrast?: "high" | "soft";
    },
  ) => ipcRenderer.invoke("neoread:appearance", appearance, palettes),
  setDocumentTabActive: (active: boolean) =>
    ipcRenderer.invoke("neoread:document-tab-active", active),
  findEndNoteLibraries: (id: string) =>
    ipcRenderer.invoke("neoread:find-endnote", id),
  cancelEndNoteSearch: (id: string) =>
    ipcRenderer.invoke("neoread:cancel-endnote-search", id),
  chooseEndNoteLibrary: (directory = false) =>
    ipcRenderer.invoke("neoread:choose-endnote", directory),
  chooseZoteroDirectory: () =>
    ipcRenderer.invoke("neoread:choose-zotero-directory"),
  importFiles: (library: "books" | "papers", folder = "") =>
    ipcRenderer.invoke("neoread:import", library, folder),
  importLargePapers: (
    ids: string[],
    library: "books" | "papers",
    folder = "",
  ) => ipcRenderer.invoke("neoread:import-large", ids, library, folder),
  showDocumentFile: (id: string, type: "pdf" | "epub") =>
    ipcRenderer.invoke("neoread:document-file", id, type, "show"),
  openDocumentFile: (id: string, type: "pdf" | "epub") =>
    ipcRenderer.invoke("neoread:document-file", id, type, "open"),
  focusWindow: () => ipcRenderer.invoke("neoread:focus-window"),
  setCitationVisible: (visible: boolean) =>
    ipcRenderer.invoke("neoread:citation-visible", visible),
  setCitationSize: (width: number, height: number) =>
    ipcRenderer.invoke("neoread:citation-size", width, height),
  onCitationEvent: (callback: (event: CiteEvent) => void) => {
    const listener = (_event: unknown, value: CiteEvent) => callback(value);
    ipcRenderer.on("neoread:citation-event", listener);
    ipcRenderer.send("neoread:citation-ready");
    return () => ipcRenderer.removeListener("neoread:citation-event", listener);
  },
  completeCitation: (transaction: string, error: string) =>
    ipcRenderer.invoke("neoread:citation-complete", transaction, error),
  citePlugins: () => proxyRequest("neoread:cite-plugins"),
  authorizeWordPluginAccess: () =>
    proxyRequest("neoread:cite-plugin-authorize-word"),
  installCitePlugin: (kind: "word" | "wps") =>
    proxyRequest("neoread:cite-plugin-install", kind),
  uninstallCitePlugin: (kind: "word" | "wps") =>
    proxyRequest("neoread:cite-plugin-uninstall", kind),
  openExternal: (url: string) =>
    ipcRenderer.invoke("neoread:open-external", url),
  openCodexThread: (threadId: string) =>
    ipcRenderer.invoke("neoread:open-codex-thread", threadId),
  onOpenLink: (callback: (target: unknown) => void) => {
    const listener = (_event: unknown, target: unknown) => callback(target);
    ipcRenderer.on("neoread:open-link", listener);
    // Links that arrived before this listener are delivered once.
    void ipcRenderer
      .invoke("neoread:take-links")
      .then((targets: unknown[]) => targets.forEach(callback));
    return () => ipcRenderer.removeListener("neoread:open-link", listener);
  },
  onOpenFiles: (callback: (opened: unknown) => void) => {
    const listener = (_event: unknown, opened: unknown) => callback(opened);
    ipcRenderer.on("neoread:open-files", listener);
    // Files opened before this listener are delivered once.
    void ipcRenderer
      .invoke("neoread:take-opened-files")
      .then((batches: unknown[]) => batches.forEach(callback));
    return () => ipcRenderer.removeListener("neoread:open-files", listener);
  },
  onLibraryChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("neoread:library-changed", listener);
    return () =>
      ipcRenderer.removeListener("neoread:library-changed", listener);
  },
});
