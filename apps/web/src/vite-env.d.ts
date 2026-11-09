/// <reference types="vite/client" />

interface Window {
  neoreadDesktop?: {
    saveExportFile?: (name: string, bytes: Uint8Array) => Promise<boolean>;
    markdownPDF?: (id: string, html: string) => Promise<Uint8Array>;
    cancelMarkdownPDF?: (id: string) => Promise<void>;
    platform: string;
    startupAppearance?: Partial<import("@neoread/core").ReaderTheme>;
    exportDiagnostics?: () => Promise<boolean>;
    recordDiagnostic?: (
      event: import("../../../packages/neoread-core/src/diagnostics").DiagnosticEvent,
    ) => void;
    diagnosticSettings?: (settings: unknown) => void;
    checkForUpdates: () => Promise<void>;
    onUpdateProgress?: (
      callback: (
        progress: import("@neoread/core").UpdateProgress | null,
      ) => void,
    ) => () => void;
    proxySettings?: () => Promise<import("@neoread/core").ProxySettingsState>;
    saveProxySettings?: (
      settings: import("@neoread/core").ProxySettings,
    ) => Promise<import("@neoread/core").ProxySettingsState>;
    checkProxy?: (
      settings: import("@neoread/core").ProxySettings,
    ) => Promise<import("@neoread/core").ProxyCheckResult>;
    restart?: () => Promise<void>;
    libraryLocation?: () => Promise<string>;
    libraryWarning?: () => Promise<string>;
    importLibrary?: () => Promise<boolean>;
    moveLibrary?: () => Promise<boolean>;
    commandLine?: () => Promise<import("@neoread/core").CommandLineStatus>;
    setCommandLine?: (
      installed: boolean,
    ) => Promise<import("@neoread/core").CommandLineStatus>;
    writeClipboardText: (text: string) => Promise<void>;
    writeClipboardImage: (data: Uint8Array, text: string) => Promise<void>;
    setAppearance: (
      appearance: "light" | "sepia" | "dark" | "system",
      palettes: {
        pdfDarkContrast?: "high" | "soft";
        systemLightMode?: "light" | "sepia";
        systemDarkContrast?: "high" | "soft";
      },
    ) => Promise<void>;
    /** Resolves with long papers that need the reader's confirmation. */
    findEndNoteLibraries?: (id: string) => Promise<{
      candidates: { path: string; name: string }[];
      timedOut: boolean;
    }>;
    cancelEndNoteSearch?: (id: string) => Promise<void>;
    chooseEndNoteLibrary?: (directory?: boolean) => Promise<string | null>;
    chooseZoteroDirectory?: () => Promise<string | null>;
    importFiles: (
      library: "books" | "papers",
      folder?: string,
    ) => Promise<Array<{ id: string; name: string; pages: number }>>;
    importLargePapers: (
      ids: string[],
      library: "books" | "papers",
      folder?: string,
    ) => Promise<string[]>;
    showDocumentFile: (id: string, type: "pdf" | "epub") => Promise<void>;
    openDocumentFile: (id: string, type: "pdf" | "epub") => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    openCodexThread?: (threadId: string) => Promise<void>;
    focusWindow?: () => Promise<void>;
    setCitationVisible?: (visible: boolean) => Promise<void>;
    setCitationSize?: (width: number, height: number) => Promise<void>;
    onCitationEvent?: (
      callback: (event: import("@neoread/api").CiteEvent) => void,
    ) => () => void;
    completeCitation?: (transaction: string, error: string) => Promise<void>;
    citePlugins?: () => Promise<import("./cite/plugins").CitePluginStatus[]>;
    authorizeWordPluginAccess?: () => Promise<void>;
    installCitePlugin?: (
      kind: "word" | "wps",
    ) => Promise<import("./cite/plugins").CitePluginStatus[]>;
    uninstallCitePlugin?: (
      kind: "word" | "wps",
    ) => Promise<import("./cite/plugins").CitePluginStatus[]>;
    onOpenLink?: (
      callback: (target: import("@neoread/core").NeoReadLinkTarget) => void,
    ) => () => void;
    /** Documents chosen with the system Open With menu, already imported. */
    onOpenFiles?: (
      callback: (opened: {
        documents: string[];
        large: Array<{ id: string; name: string; pages: number }>;
      }) => void,
    ) => () => void;
    onBeforeClose: (
      callback: () => Promise<void | { noteSaveDiscarded: boolean }>,
    ) => () => void;
    setDocumentTabActive?: (active: boolean) => Promise<void>;
    onLibraryChanged: (callback: () => void) => () => void;
  };
}
