import type { NoteType } from "./protocol";

/**
 * Reader's own field codes. The JSON follows the CSL citation schema so every
 * citation carries its full item data and can be formatted without the
 * library; the prefixes deliberately differ from Zotero's.
 */
export const CITATION_PREFIX = "READER_CITATION";
export const BIBLIOGRAPHY_PREFIX = "READER_BIBLIOGRAPHY";
export const TEMP_CODE = "READER_TEMP";
const SCHEMA =
  "https://github.com/citation-style-language/schema/raw/master/csl-citation.json";

export type CitationItem = {
  /** Reader document ID. */
  id: string;
  uris: string[];
  itemData: Record<string, unknown>;
  locator?: string;
  label?: string;
  prefix?: string;
  suffix?: string;
  "suppress-author"?: boolean;
};

export type Citation = {
  citationID: string;
  properties: {
    plainCitation?: string;
    noteIndex: number;
    /** The user kept a manual edit; Reader stops updating this text. */
    dontUpdate?: boolean;
    /** Keep the chosen order even when the style sorts citations. */
    unsorted?: boolean;
  };
  citationItems: CitationItem[];
  schema?: string;
};

export type BibliographyData = {
  uncited: string[];
  omitted: string[];
};

export type DocumentPrefs = {
  styleId: string;
  locale: string;
  noteType: NoteType;
  automaticUpdates: boolean;
};

export type DocumentData = {
  dataVersion: 1;
  sessionID: string;
  prefs: DocumentPrefs;
};

export type ParsedField =
  | { kind: "citation"; citation: Citation }
  | { kind: "bibliography"; bibliography: BibliographyData }
  | { kind: "temp" }
  | { kind: "corrupt"; code: string };

export const paperURI = (id: string) => `reader://paper/${id}`;

function json(code: string, prefix: string) {
  const start = code.indexOf("{", prefix.length);
  const end = code.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("missing JSON");
  return JSON.parse(code.slice(start, end + 1)) as unknown;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function readCitation(value: unknown): Citation {
  if (!record(value) || !Array.isArray(value.citationItems))
    throw new Error("not a citation");
  const properties = record(value.properties) ? value.properties : {};
  const items = value.citationItems.map((item): CitationItem => {
    if (!record(item) || typeof item.id !== "string" || !record(item.itemData))
      throw new Error("invalid citation item");
    const out: CitationItem = {
      id: item.id,
      uris: Array.isArray(item.uris)
        ? item.uris.filter((u): u is string => typeof u === "string")
        : [],
      itemData: item.itemData,
    };
    for (const key of ["locator", "label", "prefix", "suffix"] as const)
      if (typeof item[key] === "string" && item[key]) out[key] = item[key];
    if (item["suppress-author"] === true) out["suppress-author"] = true;
    return out;
  });
  if (!items.length) throw new Error("empty citation");
  return {
    citationID:
      typeof value.citationID === "string" && value.citationID
        ? value.citationID
        : newCitationID(),
    properties: {
      noteIndex: Number(properties.noteIndex) || 0,
      ...(typeof properties.plainCitation === "string"
        ? { plainCitation: properties.plainCitation }
        : {}),
      ...(properties.dontUpdate === true ? { dontUpdate: true } : {}),
      ...(properties.unsorted === true ? { unsorted: true } : {}),
    },
    citationItems: items,
    schema: SCHEMA,
  };
}

const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

export function parseField(code: string): ParsedField {
  const trimmed = code.trim();
  try {
    if (trimmed.startsWith(CITATION_PREFIX))
      return {
        kind: "citation",
        citation: readCitation(json(trimmed, CITATION_PREFIX)),
      };
    if (trimmed.startsWith(BIBLIOGRAPHY_PREFIX)) {
      const value = trimmed.includes("{")
        ? json(trimmed, BIBLIOGRAPHY_PREFIX)
        : {};
      const data = record(value) ? value : {};
      return {
        kind: "bibliography",
        bibliography: {
          uncited: strings(data.uncited),
          omitted: strings(data.omitted),
        },
      };
    }
    if (trimmed.startsWith(TEMP_CODE)) return { kind: "temp" };
  } catch {
    return { kind: "corrupt", code };
  }
  return { kind: "corrupt", code };
}

export function citationCode(citation: Citation) {
  return `${CITATION_PREFIX} ${JSON.stringify({ ...citation, schema: SCHEMA })}`;
}

export function bibliographyCode(data: BibliographyData) {
  return `${BIBLIOGRAPHY_PREFIX} ${JSON.stringify(data)}`;
}

export function newCitationID() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function parseDocumentData(data: string): DocumentData | null {
  if (!data.trim()) return null;
  try {
    const value = JSON.parse(data) as unknown;
    if (!record(value) || value.dataVersion !== 1 || !record(value.prefs))
      return null;
    const prefs = value.prefs;
    if (typeof prefs.styleId !== "string" || !prefs.styleId) return null;
    return {
      dataVersion: 1,
      sessionID:
        typeof value.sessionID === "string" && value.sessionID
          ? value.sessionID
          : newCitationID(),
      prefs: {
        styleId: prefs.styleId,
        locale: typeof prefs.locale === "string" ? prefs.locale : "",
        noteType: ([0, 1, 2] as const).includes(prefs.noteType as NoteType)
          ? (prefs.noteType as NoteType)
          : 0,
        automaticUpdates: prefs.automaticUpdates !== false,
      },
    };
  } catch {
    return null;
  }
}

export const serializeDocumentData = (data: DocumentData) =>
  JSON.stringify(data);
