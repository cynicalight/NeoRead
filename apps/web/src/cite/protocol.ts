/**
 * Operations the Reader window sends to the Word and WPS plugins. The plugins
 * implement exactly these; everything else (formatting, dialogs, ordering)
 * stays in Reader. Field indexes refer to the order in `Document.getState`.
 */

/** A piece of field text with one formatting state. "\t" may appear in text. */
export type Run = {
  text: string;
  i?: true;
  b?: true;
  u?: true;
  sup?: true;
  sub?: true;
  sc?: true;
};

export type BibliographyFormat = {
  /** Hanging indent for every entry. */
  hangingIndent: boolean;
  /** Numbers or labels before a tab ("flush"/"margin"), or none. */
  secondFieldAlign: false | "flush" | "margin";
  /** Widest label, in characters, for the tab stop. */
  maxOffset: number;
  /** Line spacing multiple and blank lines between entries. */
  lineSpacing: number;
  entrySpacing: number;
};

export type DocumentField = {
  /** Field code without "ADDIN", e.g. `READER_CITATION {...}`. */
  code: string;
  /** Visible result text as plain text. */
  text: string;
  /** 0 in the main text; the note number inside a footnote or endnote. */
  noteIndex: number;
};

export type DocumentState = {
  fields: DocumentField[];
  /** Index of the Reader field at the selection, or null. */
  cursor: number | null;
  /** Reader fields that start before the selection. */
  fieldsBefore: number;
  /** Stored document preferences, "" when the document has none. */
  data: string;
  /** False when the selection cannot hold a new field (e.g. read-only). */
  canInsert: boolean;
};

export type NoteType = 0 | 1 | 2;

export type FieldUpdate = {
  index: number;
  code?: string;
  text?: Run[];
  bibliography?: { entries: Run[][]; format: BibliographyFormat };
};

export type Operation =
  | { op: "Document.getState" }
  | {
      op: "Document.insertField";
      kind: "citation" | "bibliography";
      /** 1 inserts into a new footnote, 2 into a new endnote. */
      noteType: NoteType;
    }
  | { op: "Document.updateFields"; updates: FieldUpdate[] }
  | { op: "Document.removeFields"; indexes: number[]; keepText: boolean }
  | { op: "Document.setData"; data: string };

export type OperationResult<O extends Operation> = O extends {
  op: "Document.getState";
}
  ? DocumentState
  : O extends { op: "Document.insertField" }
    ? { index: number }
    : Record<string, never>;

export type CiteCommand =
  | "addEditCitation"
  | "addEditBibliography"
  | "setDocPrefs"
  | "refresh"
  | "removeCodes";

export type CiteClient = "word-windows" | "word-mac" | "wps";

/** One open transaction, as seen by the citation session. */
export interface DocumentPort {
  call<O extends Operation>(operation: O): Promise<OperationResult<O>>;
}
