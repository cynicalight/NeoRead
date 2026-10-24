// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { paper } from "../papers/fixtures";
import {
  citationCode,
  parseDocumentData,
  parseField,
  TEMP_CODE,
  type Citation,
  type DocumentPrefs,
} from "./codes";
import { createEngine } from "./engine";
import { citationItemFor, librarySource } from "./items";
import type {
  DocumentField,
  DocumentPort,
  FieldUpdate,
  Operation,
} from "./protocol";
import { htmlToRuns, plainText } from "./runs";
import { CiteSession, type CiteUI } from "./session";

const attention = paper({
  id: "attention",
  title: "Attention is all you need",
  metadata: {
    itemType: "conference",
    creators: [
      { given: "Ashish", family: "Vaswani" },
      { given: "Noam", family: "Shazeer" },
      { given: "Niki", family: "Parmar" },
      { given: "Jakob", family: "Uszkoreit" },
    ],
    date: "2017",
    venue: "Advances in Neural Information Processing Systems",
    volume: "30",
    pages: "6000-6010",
  },
});
const bert = paper({
  id: "bert",
  title: "BERT: Pre-training of deep bidirectional transformers",
  metadata: {
    itemType: "conference",
    creators: [
      { given: "Jacob", family: "Devlin" },
      { given: "Ming-Wei", family: "Chang" },
    ],
    date: "2019",
    venue: "NAACL",
    doi: "10.18653/v1/N19-1423",
  },
});
const chinese = paper({
  id: "chinese",
  title: "大语言模型综述",
  metadata: {
    itemType: "journal",
    creators: [
      { family: "张", given: "三" },
      { family: "李", given: "四" },
      { family: "王", given: "五" },
      { family: "赵", given: "六" },
    ],
    date: "2024",
    venue: "计算机学报",
    volume: "47",
    issue: "1",
    pages: "1-20",
  },
});

/** An in-memory word processor that follows the plugin protocol. */
class FakeDocument implements DocumentPort {
  fields: (DocumentField & { formatted?: FieldUpdate })[] = [];
  /** Fields before the selection; the selection is never inside a field unless `cursor` is set. */
  position = 0;
  cursor: number | null = null;
  data = "";
  calls: Operation[] = [];

  async call(operation: Operation): Promise<never> {
    this.calls.push(operation);
    const op = operation;
    switch (op.op) {
      case "Document.getState":
        return {
          fields: this.fields.map(({ code, text, noteIndex }) => ({
            code,
            text,
            noteIndex,
          })),
          cursor: this.cursor,
          fieldsBefore: this.position,
          data: this.data,
          canInsert: true,
        } as never;
      case "Document.insertField": {
        const noteIndex = op.noteType
          ? this.fields.slice(0, this.position).filter((f) => f.noteIndex)
              .length + 1
          : 0;
        this.fields.splice(this.position, 0, {
          code: TEMP_CODE,
          text: "{Citation}",
          noteIndex,
        });
        const index = this.position;
        this.position += 1;
        return { index } as never;
      }
      case "Document.updateFields":
        for (const update of op.updates) {
          const field = this.fields[update.index];
          if (update.code) field.code = update.code;
          if (update.text) field.text = plainText(update.text);
          if (update.bibliography)
            field.text = update.bibliography.entries.map(plainText).join("\n");
          field.formatted = update;
        }
        return {} as never;
      case "Document.removeFields":
        for (const index of [...op.indexes].sort((a, b) => b - a)) {
          if (op.keepText) this.fields[index].code = "(plain text)";
          else {
            this.fields.splice(index, 1);
            if (index < this.position) this.position -= 1;
          }
        }
        if (op.keepText) this.fields = [];
        return {} as never;
      case "Document.setData":
        this.data = op.data;
        return {} as never;
    }
  }
  texts() {
    return this.fields.map((f) => f.text);
  }
}

const gb: DocumentPrefs = {
  styleId: "gb-t-7714-2015-numeric-bilingual",
  locale: "",
  noteType: 0,
  automaticUpdates: true,
};

function citation(...docs: (typeof attention)[]): Citation {
  return {
    citationID: "",
    properties: { noteIndex: 0 },
    citationItems: docs.map(citationItemFor),
  };
}

function ui(patch: Partial<CiteUI> = {}): CiteUI {
  return {
    editCitation: vi.fn(async () => citation(attention)),
    documentPrefs: vi.fn(async () => gb),
    confirm: vi.fn(async () => true),
    alert: vi.fn(async () => {}),
    ...patch,
  };
}

const library = librarySource([attention, bert, chinese]);

describe("citation session", () => {
  it("asks for preferences, then inserts a numbered citation", async () => {
    const doc = new FakeDocument();
    const dialogs = ui({
      editCitation: vi.fn(async () => citation(attention, bert)),
    });
    await new CiteSession(doc, dialogs, library).run("addEditCitation");
    expect(dialogs.documentPrefs).toHaveBeenCalledWith(null);
    expect(parseDocumentData(doc.data)?.prefs.styleId).toBe(gb.styleId);
    expect(doc.texts()).toEqual(["[1,2]"]);
    const parsed = parseField(doc.fields[0].code);
    expect(parsed.kind).toBe("citation");
    if (parsed.kind !== "citation") return;
    expect(parsed.citation.citationItems.map((i) => i.uris[0])).toEqual([
      "reader://paper/attention",
      "reader://paper/bert",
    ]);
    expect(parsed.citation.citationItems[0].itemData.title).toBe(
      attention.title,
    );
    expect(parsed.citation.citationItems[0].itemData.abstract).toBeUndefined();
    expect(parsed.citation.properties.plainCitation).toBe("[1,2]");
    expect(doc.fields[0].formatted?.text).toEqual([
      { text: "[1,2]", sup: true },
    ]);
  });

  it("renumbers earlier citations when one is inserted before them", async () => {
    const doc = new FakeDocument();
    await new CiteSession(
      doc,
      ui({ editCitation: async () => citation(attention) }),
      library,
    ).run("addEditCitation");
    doc.position = 0;
    const second = ui({ editCitation: async () => citation(bert) });
    await new CiteSession(doc, second, library).run("addEditCitation");
    expect(second.documentPrefs).not.toHaveBeenCalled();
    expect(doc.texts()).toEqual(["[1]", "[2]"]);
    // Only the fields whose text changed were rewritten, in one operation.
    const updates = doc.calls.filter((c) => c.op === "Document.updateFields");
    expect(updates.at(-1)).toMatchObject({
      updates: [{ index: 0 }, { index: 1 }],
    });
  });

  it("builds the bibliography in citation order with Chinese et al.", async () => {
    const doc = new FakeDocument();
    await new CiteSession(
      doc,
      ui({ editCitation: async () => citation(chinese, attention) }),
      library,
    ).run("addEditCitation");
    await new CiteSession(doc, ui(), library).run("addEditBibliography");
    const [first, second] = doc.fields[1].text.split("\n");
    expect(first).toMatch(/^\[1\]\t张三，李四，王五，等\. 大语言模型综述\[J\]/);
    // The style writes "et al." for English entries; its punctuation is
    // deliberately full-width apart from periods and brackets.
    expect(second).toMatch(/^\[2\]\tVASWANI A，SHAZEER N，PARMAR N，et al\./);
    expect(doc.fields[1].formatted?.bibliography?.format).toMatchObject({
      secondFieldAlign: "flush",
    });
  });

  it("keeps a manual edit only after confirmation", async () => {
    const doc = new FakeDocument();
    await new CiteSession(doc, ui(), library).run("addEditCitation");
    doc.fields[0].text = "[1, p. 3]";
    const keep = ui({ confirm: vi.fn(async () => true) });
    await new CiteSession(doc, keep, library).run("refresh");
    expect(keep.confirm).toHaveBeenCalledOnce();
    expect(doc.texts()).toEqual(["[1, p. 3]"]);
    const kept = parseField(doc.fields[0].code);
    expect(
      kept.kind === "citation" && kept.citation.properties.dontUpdate,
    ).toBe(true);
    // A kept edit is not asked about again.
    const again = ui();
    await new CiteSession(doc, again, library).run("refresh");
    expect(again.confirm).not.toHaveBeenCalled();

    const other = new FakeDocument();
    await new CiteSession(other, ui(), library).run("addEditCitation");
    other.fields[0].text = "edited";
    await new CiteSession(
      other,
      ui({ confirm: async () => false }),
      library,
    ).run("refresh");
    expect(other.texts()).toEqual(["[1]"]);
  });

  it("edits the citation at the cursor and keeps its identity", async () => {
    const doc = new FakeDocument();
    await new CiteSession(doc, ui(), library).run("addEditCitation");
    const before = parseField(doc.fields[0].code);
    doc.cursor = 0;
    const editor = ui({
      editCitation: vi.fn(async ({ initial }) => {
        expect(initial?.citationItems[0].id).toBe("attention");
        return citation(attention, bert);
      }),
    });
    await new CiteSession(doc, editor, library).run("addEditCitation");
    expect(doc.fields).toHaveLength(1);
    expect(doc.texts()).toEqual(["[1,2]"]);
    const after = parseField(doc.fields[0].code);
    expect(after.kind === "citation" && after.citation.citationID).toBe(
      before.kind === "citation" && before.citation.citationID,
    );
  });

  it("formats papers missing from the library from embedded data", async () => {
    const doc = new FakeDocument();
    await new CiteSession(doc, ui(), library).run("addEditCitation");
    await new CiteSession(doc, ui(), librarySource([])).run("refresh");
    expect(doc.texts()).toEqual(["[1]"]);
  });

  it("re-formats everything when the style changes", async () => {
    const doc = new FakeDocument();
    await new CiteSession(
      doc,
      ui({ editCitation: async () => citation(attention) }),
      library,
    ).run("addEditCitation");
    await new CiteSession(doc, ui(), library).run("addEditBibliography");
    await new CiteSession(
      doc,
      ui({ documentPrefs: async () => ({ ...gb, styleId: "apa" }) }),
      library,
    ).run("setDocPrefs");
    expect(doc.fields[0].text).toBe("(Vaswani et al., 2017)");
    expect(doc.fields[1].text).toMatch(/^Vaswani, A\., Shazeer, N\./);
    expect(doc.fields[1].formatted?.bibliography?.format.hangingIndent).toBe(
      true,
    );
  });

  it("inserts note-style citations into footnotes", async () => {
    const doc = new FakeDocument();
    await new CiteSession(
      doc,
      ui({
        documentPrefs: async () => ({
          ...gb,
          styleId: "chicago-shortened-notes-bibliography",
          locale: "en-US",
        }),
      }),
      library,
    ).run("addEditCitation");
    const insert = doc.calls.find((c) => c.op === "Document.insertField");
    expect(insert).toMatchObject({ noteType: 1 });
    expect(doc.fields[0].noteIndex).toBe(1);
    expect(doc.fields[0].text).toMatch(/Vaswani/);
  });

  it("unlinks after confirmation and clears document data", async () => {
    const doc = new FakeDocument();
    await new CiteSession(doc, ui(), library).run("addEditCitation");
    const declined = ui({ confirm: async () => false });
    await new CiteSession(doc, declined, library).run("removeCodes");
    expect(doc.fields).toHaveLength(1);
    await new CiteSession(doc, ui(), library).run("removeCodes");
    expect(doc.calls.at(-2)).toMatchObject({
      op: "Document.removeFields",
      keepText: true,
    });
    expect(doc.data).toBe("");
  });

  it("removes placeholders left by an interrupted insert", async () => {
    const doc = new FakeDocument();
    doc.fields.push({ code: TEMP_CODE, text: "{Citation}", noteIndex: 0 });
    doc.position = 1;
    await new CiteSession(doc, ui(), library).run("addEditCitation");
    expect(doc.texts()).toEqual(["[1]"]);
  });

  it("stops without changes when a dialog is cancelled", async () => {
    const doc = new FakeDocument();
    await new CiteSession(
      doc,
      ui({ documentPrefs: async () => null }),
      library,
    ).run("addEditCitation");
    await new CiteSession(
      doc,
      ui({ editCitation: async () => null }),
      library,
    ).run("addEditCitation");
    expect(doc.fields).toEqual([]);
  });
});

describe("citation formatting", () => {
  it("applies locators, prefixes and suppressed authors", async () => {
    const engine = await createEngine("apa", "en-US");
    const item = {
      ...citationItemFor(attention),
      locator: "12",
      label: "page",
      prefix: "see <i>also</i>",
      "suppress-author": true,
    };
    const result = engine.format([
      {
        citationID: "c1",
        properties: { noteIndex: 0 },
        citationItems: [item],
      },
    ]);
    const runs = result.citations.get("c1")!;
    expect(plainText(runs)).toBe("(see also 2017, p. 12)");
    expect(runs).toContainEqual({ text: "also", i: true });
  });

  it("keeps the chosen order only when asked", async () => {
    const engine = await createEngine("apa", "en-US");
    const both = (unsorted: boolean): Citation => ({
      citationID: "c",
      properties: { noteIndex: 0, ...(unsorted ? { unsorted } : {}) },
      citationItems: [citationItemFor(attention), citationItemFor(bert)],
    });
    expect(plainText(engine.format([both(false)]).citations.get("c")!)).toBe(
      "(Devlin & Chang, 2019; Vaswani et al., 2017)",
    );
    expect(plainText(engine.format([both(true)]).citations.get("c")!)).toBe(
      "(Vaswani et al., 2017; Devlin & Chang, 2019)",
    );
  });

  it("previews a citation at its position in the document", async () => {
    const engine = await createEngine(gb.styleId, "");
    const first: Citation = { ...citation(attention), citationID: "a" };
    engine.format([first]);
    const preview = engine.preview(
      { ...citation(bert), citationID: "b" },
      [first],
      [],
    );
    expect(plainText(preview)).toBe("[2]");
  });

  it("formats every bundled style", async () => {
    const { bundledStyles } = await import("./styles");
    for (const style of bundledStyles) {
      const engine = await createEngine(style.id, "");
      const result = engine.format([
        { ...citation(attention, chinese), citationID: "x" },
      ]);
      expect(plainText(result.citations.get("x")!), style.id).not.toBe("");
      expect(result.bibliography?.entries, style.id).toHaveLength(2);
    }
  });
});

describe("field codes", () => {
  it("round-trips citations and rejects broken codes", () => {
    const value: Citation = {
      ...citation(attention),
      citationID: "abc",
      properties: { noteIndex: 2, plainCitation: "[1]", dontUpdate: true },
    };
    const parsed = parseField(citationCode(value));
    expect(parsed).toEqual({
      kind: "citation",
      citation: { ...value, schema: expect.any(String) },
    });
    expect(parseField("READER_CITATION {broken").kind).toBe("corrupt");
    expect(parseField("ZOTERO_ITEM CSL_CITATION {}").kind).toBe("corrupt");
    expect(parseField("READER_BIBLIOGRAPHY")).toEqual({
      kind: "bibliography",
      bibliography: { uncited: [], omitted: [] },
    });
  });

  it("converts citeproc HTML to runs", () => {
    expect(
      htmlToRuns(
        '<div class="csl-entry"><div class="csl-left-margin">[1]</div><div class="csl-right-inline">A. <i>Title</i>, x<sup>2</sup> &#38; <span style="font-variant:small-caps;">sc</span>.</div></div>\n',
      ),
    ).toEqual([
      { text: "[1]\tA. " },
      { text: "Title", i: true },
      { text: ", x" },
      { text: "2", sup: true },
      { text: " & " },
      { text: "sc", sc: true },
      { text: "." },
    ]);
  });
});
