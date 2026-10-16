import { contextBridge, ipcRenderer } from "electron";
import type { ProxySettings } from "../../../packages/reader-core/src/proxy-settings";
import type { UpdateProgress } from "../../../packages/reader-core/src/update-progress";
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
contextBridge.exposeInMainWorld("readerDesktop", {
  platform: process.platform,
  exportDiagnostics: () => ipcRenderer.invoke("reader:export-diagnostics"),
  recordDiagnostic: (event: unknown) =>
    ipcRenderer.send("reader:diagnostic-event", event),
  diagnosticSettings: (settings: unknown) =>
    ipcRenderer.send("reader:diagnostic-settings", settings),
  checkForUpdates: () => ipcRenderer.invoke("reader:check-updates"),
  onUpdateProgress: (callback: (progress: UpdateProgress | null) => void) => {
    const listener = (_event: unknown, progress: UpdateProgress | null) =>
      callback(progress);
    ipcRenderer.on("reader:update-progress", listener);
    return () => ipcRenderer.removeListener("reader:update-progress", listener);
  },
  proxySettings: () => proxyRequest("reader:proxy-settings"),
  saveProxySettings: (settings: ProxySettings) =>
    proxyRequest("reader:save-proxy-settings", settings),
  checkProxy: (settings: ProxySettings) =>
    proxyRequest("reader:check-proxy", settings),
  restart: () => proxyRequest("reader:restart"),
  commandLine: () => proxyRequest("reader:command-line"),
  setCommandLine: (installed: boolean) =>
    proxyRequest("reader:set-command-line", installed),
  writeClipboardText: (text: string) =>
    ipcRenderer.invoke("reader:clipboard-write", text),
  onBeforeClose: (callback: () => Promise<void>) => {
    const listener = () => {
      void callback().then(
        () => ipcRenderer.send("reader:flushed", null),
        (error) => ipcRenderer.send("reader:flushed", String(error)),
      );
    };
    ipcRenderer.on("reader:flush", listener);
    return () => ipcRenderer.removeListener("reader:flush", listener);
  },
  setAppearance: (appearance: "light" | "sepia" | "dark" | "system") =>
    ipcRenderer.invoke("reader:appearance", appearance),
  findEndNoteLibraries: (id: string) =>
    ipcRenderer.invoke("reader:find-endnote", id),
  cancelEndNoteSearch: (id: string) =>
    ipcRenderer.invoke("reader:cancel-endnote-search", id),
  chooseEndNoteLibrary: (directory = false) =>
    ipcRenderer.invoke("reader:choose-endnote", directory),
  chooseZoteroDirectory: () =>
    ipcRenderer.invoke("reader:choose-zotero-directory"),
  importFiles: (library: "books" | "papers") =>
    ipcRenderer.invoke("reader:import", library),
  importLargePapers: (ids: string[], library: "books" | "papers") =>
    ipcRenderer.invoke("reader:import-large", ids, library),
  showDocumentFile: (id: string, type: "pdf" | "epub") =>
    ipcRenderer.invoke("reader:document-file", id, type, "show"),
  openDocumentFile: (id: string, type: "pdf" | "epub") =>
    ipcRenderer.invoke("reader:document-file", id, type, "open"),
  openExternal: (url: string) =>
    ipcRenderer.invoke("reader:open-external", url),
  onOpenLink: (callback: (target: unknown) => void) => {
    const listener = (_event: unknown, target: unknown) => callback(target);
    ipcRenderer.on("reader:open-link", listener);
    // Links that arrived before this listener are delivered once.
    void ipcRenderer
      .invoke("reader:take-links")
      .then((targets: unknown[]) => targets.forEach(callback));
    return () => ipcRenderer.removeListener("reader:open-link", listener);
  },
  onLibraryChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("reader:library-changed", listener);
    return () => ipcRenderer.removeListener("reader:library-changed", listener);
  },
});
