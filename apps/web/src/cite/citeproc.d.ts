declare module "citeproc" {
  type Sys = {
    retrieveLocale(lang: string): string | false;
    retrieveItem(id: string): unknown;
  };
  class Engine {
    constructor(sys: Sys, style: string, lang?: string, forceLang?: boolean);
    rebuildProcessorState(
      citations: unknown[],
      mode?: "html" | "text" | "rtf",
      uncitedItemIDs?: string[],
    ): unknown;
    previewCitationCluster(
      citation: unknown,
      citationsPre: unknown[],
      citationsPost: unknown[],
      mode?: "html" | "text" | "rtf",
    ): unknown;
    makeBibliography(): unknown;
  }
  const CSL: { Engine: typeof Engine };
  export default CSL;
}
