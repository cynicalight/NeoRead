/** Mirrors CitePluginStatus in apps/desktop/main/cite-plugins.ts. */
export type CitePluginStatus = {
  kind: "word" | "wps";
  supported: boolean;
  detected: boolean;
  available: boolean;
  installed: boolean;
};
