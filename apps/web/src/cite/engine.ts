import CSL from "citeproc";
import type { Citation } from "./codes";
import type { BibliographyFormat, Run } from "./protocol";
import { htmlToRuns } from "./runs";
import { loadLocales, loadStyle } from "./styles";

export type FormattedDocument = {
  /** Runs per citationID. */
  citations: Map<string, Run[]>;
  bibliography: { entries: Run[][]; format: BibliographyFormat } | null;
};

type Item = Record<string, unknown> & { id: string };

const toEngineCitation = (citation: Citation) => ({
  citationID: citation.citationID,
  citationItems: citation.citationItems.map((item) => ({
    id: item.id,
    ...(item.locator ? { locator: item.locator } : {}),
    ...(item.label ? { label: item.label } : {}),
    ...(item.prefix ? { prefix: item.prefix } : {}),
    ...(item.suffix ? { suffix: item.suffix } : {}),
    ...(item["suppress-author"] ? { "suppress-author": true } : {}),
  })),
  properties: {
    noteIndex: citation.properties.noteIndex,
    ...(citation.properties.unsorted ? { unsorted: true } : {}),
  },
});

/**
 * One citeproc-js processor for a document. Every format call rebuilds the
 * state from the citations in document order, so numbering, disambiguation
 * and "ibid." always reflect the whole document.
 */
export async function createEngine(styleId: string, locale: string) {
  const [style, locales] = await Promise.all([
    loadStyle(styleId),
    loadLocales(),
  ]);
  const items = new Map<string, Item>();
  const sys = {
    retrieveLocale: (lang: string) =>
      locales.get(lang) || locales.get(lang.split("-")[0]) || false,
    retrieveItem: (id: string) => items.get(id),
  };
  const lang = locale || style.defaultLocale || "en-US";
  const engine = new CSL.Engine(sys, style.xml, lang, !!locale);

  const register = (citations: Citation[]) => {
    items.clear();
    for (const citation of citations)
      for (const item of citation.citationItems)
        if (!items.has(item.id))
          items.set(item.id, { ...item.itemData, id: item.id });
  };

  return {
    style,
    format(citations: Citation[], uncited: string[] = []): FormattedDocument {
      register(citations);
      const results = engine.rebuildProcessorState(
        citations.map(toEngineCitation),
        "html",
        uncited.filter((id) => items.has(id)),
      ) as [string, number, string][];
      const formatted = new Map(
        results.map(([id, , html]) => [id, htmlToRuns(html)]),
      );
      if (!style.hasBibliography || !items.size)
        return { citations: formatted, bibliography: null };
      const made = engine.makeBibliography();
      if (!made) return { citations: formatted, bibliography: null };
      const [params, entries] = made as [
        {
          hangingindent?: number;
          "second-field-align"?: false | "flush" | "margin";
          maxoffset?: number;
          linespacing?: number;
          entryspacing?: number;
        },
        string[],
      ];
      return {
        citations: formatted,
        bibliography: {
          entries: entries.map(htmlToRuns),
          format: {
            hangingIndent: !!params.hangingindent,
            secondFieldAlign: params["second-field-align"] || false,
            maxOffset: params.maxoffset || 0,
            lineSpacing: params.linespacing || 1,
            entrySpacing: params.entryspacing || 0,
          },
        },
      };
    },
    /**
     * One citation formatted in place, for the dialog preview. Call `format`
     * with the document's citations first; the preview does not change them.
     */
    preview(citation: Citation, before: Citation[], after: Citation[]) {
      for (const item of citation.citationItems)
        items.set(item.id, { ...item.itemData, id: item.id });
      const position = (list: Citation[]) =>
        list.map((c) => [c.citationID, c.properties.noteIndex]);
      const html = engine.previewCitationCluster(
        toEngineCitation(citation),
        position(before),
        position(after),
        "html",
      ) as string;
      return htmlToRuns(html);
    },
  };
}

export type CiteEngine = Awaited<ReturnType<typeof createEngine>>;
