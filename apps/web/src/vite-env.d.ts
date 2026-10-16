/// <reference types="vite/client" />

interface Window {
  readerDesktop?: {
    platform: string;
    exportDiagnostics?: () => Promise<boolean>;
    recordDiagnostic?: (
      event: import("../../../packages/reader-core/src/diagnostics").DiagnosticEvent,
    ) => void;
    diagnosticSettings?: (settings: unknown) => void;
    checkForUpdates: () => Promise<void>;
    onUpdateProgress?: (
      callback: (
        progress: import("@reader/core").UpdateProgress | null,
      ) => void,
    ) => () => void;
    proxySettings?: () => Promise<import("@reader/core").ProxySettingsState>;
    saveProxySettings?: (
      settings: import("@reader/core").ProxySettings,
    ) => Promise<import("@reader/core").ProxySettingsState>;
    checkProxy?: (
      settings: import("@reader/core").ProxySettings,
    ) => Promise<import("@reader/core").ProxyCheckResult>;
    restart?: () => Promise<void>;
    commandLine?: () => Promise<import("@reader/core").CommandLineStatus>;
    setCommandLine?: (
      installed: boolean,
    ) => Promise<import("@reader/core").CommandLineStatus>;
    writeClipboardText: (text: string) => Promise<void>;
    setAppearance: (
      appearance: "light" | "sepia" | "dark" | "system",
    ) => Promise<void>;
    /** Resolves with long papers that need the reader's confirmation. */
    findEndNoteLibraries?: (
      id: string,
    ) => Promise<{
      candidates: { path: string; name: string }[];
      timedOut: boolean;
    }>;
    cancelEndNoteSearch?: (id: string) => Promise<void>;
    chooseEndNoteLibrary?: (directory?: boolean) => Promise<string | null>;
    chooseZoteroDirectory?: () => Promise<string | null>;
    importFiles: (
      library: "books" | "papers",
    ) => Promise<Array<{ id: string; name: string; pages: number }>>;
    importLargePapers: (
      ids: string[],
      library: "books" | "papers",
    ) => Promise<void>;
    showDocumentFile: (id: string, type: "pdf" | "epub") => Promise<void>;
    openDocumentFile: (id: string, type: "pdf" | "epub") => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    onOpenLink?: (
      callback: (target: import("@reader/core").ReaderLinkTarget) => void,
    ) => () => void;
    onBeforeClose: (callback: () => Promise<void>) => () => void;
    onLibraryChanged: (callback: () => void) => () => void;
  };
}
