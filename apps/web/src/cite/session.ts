import {
  bibliographyCode,
  citationCode,
  newCitationID,
  parseDocumentData,
  parseField,
  serializeDocumentData,
  type BibliographyData,
  type Citation,
  type CitationItem,
  type DocumentData,
  type DocumentPrefs,
} from "./codes";
import { createEngine, type CiteEngine } from "./engine";
import type {
  CiteCommand,
  DocumentField,
  DocumentPort,
  FieldUpdate,
  NoteType,
} from "./protocol";
import { plainText, sameText } from "./runs";

export interface CiteUI {
  /** Edit an existing citation or build a new one; null when cancelled. */
  editCitation(request: {
    initial: Citation | null;
    engine: CiteEngine;
    before: Citation[];
    after: Citation[];
  }): Promise<Citation | null>;
  documentPrefs(current: DocumentPrefs | null): Promise<DocumentPrefs | null>;
  confirm(message: string, action: string): Promise<boolean>;
  alert(message: string): Promise<void>;
}

export interface ItemSource {
  /** Current library data for a cited paper; undefined keeps the embedded copy. */
  itemData(item: CitationItem): Record<string, unknown> | undefined;
}

type Field = DocumentField & {
  index: number;
  parsed: ReturnType<typeof parseField>;
};

type Loaded = {
  fields: Field[];
  cursor: number | null;
  fieldsBefore: number;
  canInsert: boolean;
  data: DocumentData | null;
};

const citationOf = (field: Field) =>
  field.parsed.kind === "citation" ? field.parsed.citation : null;

async function load(
  port: DocumentPort,
  keepTemporary = false,
): Promise<Loaded> {
  let state = await port.call({ op: "Document.getState" });
  const parse = () =>
    state.fields.map((field, index) => ({
      ...field,
      index,
      parsed: parseField(field.code),
    }));
  let fields = parse();
  // A placeholder left by an interrupted insert is removed first.
  const temporary = fields.filter((f) => f.parsed.kind === "temp");
  if (temporary.length && !keepTemporary) {
    await port.call({
      op: "Document.removeFields",
      indexes: temporary.map((f) => f.index),
      keepText: false,
    });
    state = await port.call({ op: "Document.getState" });
    fields = parse();
  }
  return {
    fields,
    cursor: state.cursor,
    fieldsBefore: state.fieldsBefore,
    canInsert: state.canInsert,
    data: parseDocumentData(state.data),
  };
}

export class CiteSession {
  constructor(
    private port: DocumentPort,
    private ui: CiteUI,
    private items: ItemSource,
  ) {}

  /** Runs one command; the caller completes the transaction afterwards. */
  async run(command: CiteCommand) {
    switch (command) {
      case "addEditCitation":
        return this.addEditCitation();
      case "addEditBibliography":
        return this.addEditBibliography();
      case "setDocPrefs":
        return this.setDocPrefs();
      case "refresh":
        return this.refresh();
      case "removeCodes":
        return this.removeCodes();
    }
  }

  private async prefs(doc: Loaded, ask: boolean) {
    if (doc.data && !ask) return doc.data;
    const prefs = await this.ui.documentPrefs(doc.data?.prefs ?? null);
    if (!prefs) return null;
    const data: DocumentData = {
      dataVersion: 1,
      sessionID: doc.data?.sessionID || newCitationID(),
      prefs,
    };
    await this.port.call({
      op: "Document.setData",
      data: serializeDocumentData(data),
    });
    doc.data = data;
    return data;
  }

  /** Citations in document order with their current note numbers and data. */
  private citations(doc: Loaded) {
    return doc.fields.flatMap((field) => {
      const citation = citationOf(field);
      if (!citation) return [];
      citation.properties.noteIndex = field.noteIndex;
      for (const item of citation.citationItems) {
        const current = this.items.itemData(item);
        if (current) item.itemData = current;
      }
      return [citation];
    });
  }

  private async update(
    doc: Loaded,
    engine: CiteEngine,
    options: { force?: boolean; only?: Set<number> } = {},
  ) {
    const citations = this.citations(doc);
    const bibliography = doc.fields.find(
      (f) => f.parsed.kind === "bibliography",
    );
    const bibliographyData: BibliographyData =
      bibliography?.parsed.kind === "bibliography"
        ? bibliography.parsed.bibliography
        : { uncited: [], omitted: [] };
    const formatted = engine.format(citations, bibliographyData.uncited);
    const updates: FieldUpdate[] = [];
    for (const field of doc.fields) {
      if (options.only && !options.only.has(field.index)) continue;
      const citation = citationOf(field);
      if (citation) {
        const runs = formatted.citations.get(citation.citationID) || [];
        const text = plainText(runs);
        const update: FieldUpdate = { index: field.index };
        const stored = citation.properties.plainCitation;
        const edited =
          stored !== undefined &&
          !citation.properties.dontUpdate &&
          !sameText(field.text, stored);
        if (
          edited &&
          (await this.ui.confirm(
            `引注“${field.text.trim()}”已被手动修改。保留修改后，Reader 不再更新这条引注。`,
            "保留修改",
          ))
        )
          citation.properties.dontUpdate = true;
        if (!citation.properties.dontUpdate) {
          citation.properties.plainCitation = text;
          if (options.force || edited || !sameText(field.text, text))
            update.text = runs;
        }
        const code = citationCode(citation);
        if (code !== field.code.trim()) update.code = code;
        if (update.code || update.text) updates.push(update);
      } else if (field.parsed.kind === "bibliography") {
        // Word mishandles an empty field result, so an empty list keeps a placeholder.
        const result = formatted.bibliography || {
          entries: [[{ text: "{Bibliography}" }]],
          format: {
            hangingIndent: false,
            secondFieldAlign: false as const,
            maxOffset: 0,
            lineSpacing: 1,
            entrySpacing: 0,
          },
        };
        const text = result.entries.map(plainText).join("\n");
        const code = bibliographyCode(field.parsed.bibliography);
        const update: FieldUpdate = { index: field.index };
        if (options.force || !sameText(field.text, text))
          update.bibliography = result;
        if (code !== field.code.trim()) update.code = code;
        if (update.code || update.bibliography) updates.push(update);
      }
    }
    if (updates.length)
      await this.port.call({ op: "Document.updateFields", updates });
  }

  private noteType(engine: CiteEngine, prefs: DocumentPrefs): NoteType {
    if (!engine.style.noteStyle) return 0;
    return prefs.noteType || 1;
  }

  private async addEditCitation() {
    let doc = await load(this.port);
    const data = await this.prefs(doc, false);
    if (!data) return;
    const engine = await createEngine(data.prefs.styleId, data.prefs.locale);
    const cursor = doc.cursor === null ? null : doc.fields[doc.cursor];
    if (cursor?.parsed.kind === "bibliography") {
      await this.ui.alert(
        "光标位于参考文献表中。请把光标移到正文后再插入引注。",
      );
      return;
    }
    const existing = cursor ? citationOf(cursor) : null;
    if (!existing && !doc.canInsert) {
      await this.ui.alert("当前位置不能插入引注。");
      return;
    }
    const citations = this.citations(doc);
    engine.format(citations);
    const split = existing
      ? citations.indexOf(existing)
      : Math.min(
          doc.fields
            .slice(0, doc.fieldsBefore)
            .filter((f) => f.parsed.kind === "citation").length,
          citations.length,
        );
    const edited = await this.ui.editCitation({
      initial: existing,
      engine,
      before: citations.slice(0, split),
      after: citations.slice(existing ? split + 1 : split),
    });
    if (!edited) return;
    let index: number;
    if (existing && cursor) {
      index = cursor.index;
      cursor.parsed = {
        kind: "citation",
        citation: {
          ...edited,
          citationID: existing.citationID,
          properties: {
            ...edited.properties,
            plainCitation: undefined,
            dontUpdate: undefined,
          },
        },
      };
    } else {
      ({ index } = await this.port.call({
        op: "Document.insertField",
        kind: "citation",
        noteType: this.noteType(engine, data.prefs),
      }));
      doc = await this.reload(doc);
      const field = doc.fields[index];
      if (!field) throw new Error("插入的引注没有出现在文档中");
      field.parsed = {
        kind: "citation",
        citation: { ...edited, citationID: newCitationID() },
      };
    }
    await this.update(doc, engine, {
      only: data.prefs.automaticUpdates ? undefined : new Set([index]),
    });
  }

  /** Reads the fields again after an insert shifted their indexes. */
  private async reload(previous: Loaded) {
    const doc = await load(this.port, true);
    doc.data = previous.data;
    return doc;
  }

  private async addEditBibliography() {
    let doc = await load(this.port);
    const data = await this.prefs(doc, false);
    if (!data) return;
    const engine = await createEngine(data.prefs.styleId, data.prefs.locale);
    if (!engine.style.hasBibliography) {
      await this.ui.alert("当前引用样式没有参考文献表。");
      return;
    }
    if (!doc.fields.some((f) => f.parsed.kind === "bibliography")) {
      if (!doc.canInsert) {
        await this.ui.alert("当前位置不能插入参考文献表。");
        return;
      }
      const { index } = await this.port.call({
        op: "Document.insertField",
        kind: "bibliography",
        noteType: 0,
      });
      doc = await this.reload(doc);
      const field = doc.fields[index];
      if (!field) throw new Error("插入的参考文献表没有出现在文档中");
      field.parsed = {
        kind: "bibliography",
        bibliography: { uncited: [], omitted: [] },
      };
    }
    await this.update(doc, engine);
  }

  private async setDocPrefs() {
    const doc = await load(this.port);
    const before = doc.data?.prefs;
    const data = await this.prefs(doc, true);
    if (!data) return;
    const engine = await createEngine(data.prefs.styleId, data.prefs.locale);
    if (
      before &&
      doc.fields.some((f) => f.parsed.kind === "citation") &&
      (await createEngine(before.styleId, before.locale)).style.noteStyle !==
        engine.style.noteStyle
    )
      await this.ui.alert(
        "已有引注会保留在原来的位置，不会在正文和脚注之间移动。",
      );
    await this.update(doc, engine, { force: true });
  }

  private async refresh() {
    const doc = await load(this.port);
    if (!doc.data && !doc.fields.length) {
      await this.ui.alert("文档中还没有 Reader 引注。");
      return;
    }
    const data = await this.prefs(doc, false);
    if (!data) return;
    const engine = await createEngine(data.prefs.styleId, data.prefs.locale);
    await this.update(doc, engine, { force: true });
  }

  private async removeCodes() {
    const doc = await load(this.port);
    if (!doc.fields.length) {
      await this.ui.alert("文档中没有 Reader 引注。");
      return;
    }
    const confirmed = await this.ui.confirm(
      "取消链接后，引注和参考文献表会变成普通文字，Reader 不能再更新它们。此操作不能撤销，建议先保存一份副本。",
      "取消链接",
    );
    if (!confirmed) return;
    await this.port.call({
      op: "Document.removeFields",
      indexes: doc.fields.map((f) => f.index),
      keepText: true,
    });
    await this.port.call({ op: "Document.setData", data: "" });
  }
}
