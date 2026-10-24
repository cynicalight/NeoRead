import type { Document } from "@neoread/core";
import { toCSL } from "../papers/citation";
import { paperURI, type CitationItem } from "./codes";
import type { ItemSource } from "./session";

/** CSL data embedded in the document; the abstract only adds weight. */
function itemData(doc: Document) {
  const { abstract: _abstract, ...data } = toCSL(doc);
  return data;
}

export function citationItemFor(doc: Document): CitationItem {
  return { id: doc.id, uris: [paperURI(doc.id)], itemData: itemData(doc) };
}

const normalizedDOI = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * Resolves cited papers against the library: by Reader ID, then by DOI for a
 * paper that was re-imported. Papers not found keep their embedded data.
 */
export function librarySource(documents: Document[]): ItemSource {
  const papers = documents.filter((doc) => doc.library === "papers");
  const byID = new Map(papers.map((doc) => [doc.id, doc]));
  const byDOI = new Map(
    papers
      .filter((doc) => doc.metadata.doi)
      .map((doc) => [normalizedDOI(doc.metadata.doi), doc]),
  );
  return {
    itemData(item) {
      const doc =
        byID.get(item.id) || byDOI.get(normalizedDOI(item.itemData.DOI));
      // The engine looks items up by the ID stored in the field.
      return doc ? { ...itemData(doc), id: item.id } : undefined;
    },
  };
}
