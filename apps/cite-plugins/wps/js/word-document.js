// Reader citation operations on a Word-compatible object model (WPS JS API).
// The Word VBA template implements the same operations; keep them in step.
(function (root) {
  "use strict";

  const PREFIX = "READER_";
  const PREF = "READER_PREF_";
  const PREF_CHUNK = 255;
  const wdFieldEmpty = -1;
  const wdCollapseEnd = 0;
  const wdMainTextStory = 1;
  const wdStyleBibliography = -266;
  const wdLineSpaceMultiple = 5;
  const msoPropertyTypeString = 4;
  const PLACEHOLDER = {
    citation: "{Citation}",
    bibliography: "{Bibliography}",
  };

  /** " ADDIN READER_CITATION {...} " → "READER_CITATION {...}". */
  function readerCode(text) {
    let code = String(text || "").trim();
    if (code.toUpperCase().startsWith("ADDIN ")) code = code.slice(6).trim();
    return code.startsWith(PREFIX) ? code : null;
  }

  function createDocument(app) {
    const doc = app.ActiveDocument;

    /** Reader fields in reading order; note fields sort by their reference. */
    function collect() {
      const found = [];
      const visit = (fields, noteIndex, anchor) => {
        for (let i = 1; i <= fields.Count; i++) {
          const field = fields.Item(i);
          const code = readerCode(field.Code.Text);
          if (code === null) continue;
          found.push({
            field,
            code,
            noteIndex,
            anchor: anchor === null ? field.Code.Start : anchor,
            offset: field.Code.Start,
          });
        }
      };
      visit(doc.Fields, 0, null);
      for (const notes of [doc.Footnotes, doc.Endnotes]) {
        if (!notes) continue;
        for (let i = 1; i <= notes.Count; i++) {
          const note = notes.Item(i);
          visit(note.Range.Fields, note.Index, note.Reference.Start);
        }
      }
      return found.sort((a, b) => a.anchor - b.anchor || a.offset - b.offset);
    }

    /** Main-text position of the selection, resolving notes to their reference. */
    function selectionAnchor(selection) {
      if (selection.StoryType === wdMainTextStory) return selection.Start;
      for (const notes of [doc.Footnotes, doc.Endnotes]) {
        if (!notes) continue;
        for (let i = 1; i <= notes.Count; i++) {
          const note = notes.Item(i);
          if (
            note.Range.StoryType === selection.StoryType &&
            note.Range.Start <= selection.Start &&
            selection.End <= note.Range.End
          )
            return note.Reference.Start;
        }
      }
      return selection.Start;
    }

    function readData() {
      const props = doc.CustomDocumentProperties;
      const chunks = [];
      for (let i = 1; i <= props.Count; i++) {
        const prop = props.Item(i);
        const name = String(prop.Name);
        if (name.startsWith(PREF))
          chunks.push([
            Number(name.slice(PREF.length)) || 0,
            String(prop.Value),
          ]);
      }
      return chunks
        .sort((a, b) => a[0] - b[0])
        .map((c) => c[1])
        .join("");
    }

    function getState() {
      const fields = collect();
      const selection = app.Selection;
      const anchor = selectionAnchor(selection);
      let cursor = null;
      fields.forEach((entry, index) => {
        const result = entry.field.Result;
        if (
          result.StoryType === selection.StoryType &&
          entry.field.Code.Start - 1 <= selection.Start &&
          selection.End <= result.End + 1
        )
          cursor = index;
      });
      let readOnly = false;
      try {
        readOnly = !!doc.ReadOnly;
      } catch (e) {
        /* Not every host exposes it. */
      }
      return {
        fields: fields.map((entry) => ({
          code: entry.code,
          text: String(entry.field.Result.Text || ""),
          noteIndex: entry.noteIndex,
        })),
        cursor,
        fieldsBefore: fields.filter((entry) => entry.anchor < anchor).length,
        data: readData(),
        canInsert: !readOnly,
      };
    }

    function insertField(op) {
      const range = app.Selection.Range;
      range.Collapse(wdCollapseEnd);
      let target = range;
      let note = null;
      if (op.noteType === 1 || op.noteType === 2) {
        note = (op.noteType === 2 ? doc.Endnotes : doc.Footnotes).Add(range);
        target = note.Range;
      }
      const field = doc.Fields.Add(
        target,
        wdFieldEmpty,
        "ADDIN READER_TEMP",
        false,
      );
      field.Result.Text = PLACEHOLDER[op.kind] || PLACEHOLDER.citation;
      // Continue typing after the citation (or its note reference).
      if (note) note.Reference.Select();
      else field.Select();
      app.Selection.Collapse(wdCollapseEnd);
      const index = collect().findIndex(
        (entry) => entry.code === "READER_TEMP",
      );
      if (index < 0) throw new Error("插入的域没有出现在文档中");
      return { index };
    }

    function clearFormatting(range) {
      const font = range.Font;
      font.Italic = false;
      font.Bold = false;
      font.Underline = 0;
      font.Superscript = false;
      font.Subscript = false;
      font.SmallCaps = false;
    }

    /** Writes paragraphs of runs as the field result, then formats each run. */
    function writeRuns(field, paragraphs) {
      const text = paragraphs
        .map((runs) => runs.map((run) => run.text).join(""))
        .join("\r");
      field.Result.Text = text;
      const result = field.Result;
      clearFormatting(result);
      let offset = result.Start;
      for (const runs of paragraphs) {
        for (const run of runs) {
          const length = run.text.length;
          if (
            length &&
            (run.i || run.b || run.u || run.sup || run.sub || run.sc)
          ) {
            const part = result.Duplicate;
            part.SetRange(offset, offset + length);
            const font = part.Font;
            if (run.i) font.Italic = true;
            if (run.b) font.Bold = true;
            if (run.u) font.Underline = 1;
            if (run.sup) font.Superscript = true;
            if (run.sub) font.Subscript = true;
            if (run.sc) font.SmallCaps = true;
          }
          offset += length;
        }
        offset += 1;
      }
      return field.Result;
    }

    function formatBibliography(range, format) {
      try {
        range.Style = wdStyleBibliography;
      } catch (e) {
        /* Hosts without the built-in style keep the paragraph style. */
      }
      const paragraph = range.ParagraphFormat;
      const size = Number(range.Font.Size) > 0 ? Number(range.Font.Size) : 10.5;
      if (format.secondFieldAlign) {
        const indent = Math.max(format.maxOffset, 1) * size * 0.55 + size;
        paragraph.TabStops.ClearAll();
        paragraph.TabStops.Add(indent);
        paragraph.LeftIndent = indent;
        paragraph.FirstLineIndent = -indent;
      } else if (format.hangingIndent) {
        paragraph.LeftIndent = size * 2;
        paragraph.FirstLineIndent = -size * 2;
      } else {
        paragraph.LeftIndent = 0;
        paragraph.FirstLineIndent = 0;
      }
      if (format.lineSpacing && format.lineSpacing !== 1) {
        paragraph.LineSpacingRule = wdLineSpaceMultiple;
        paragraph.LineSpacing = 12 * format.lineSpacing;
      }
      paragraph.SpaceAfter = format.entrySpacing
        ? size * format.entrySpacing
        : 0;
    }

    function updateFields(op) {
      const fields = collect();
      for (const update of op.updates) {
        const entry = fields[update.index];
        if (!entry) throw new Error("文档中的域已改变，请重试");
        if (update.code !== undefined)
          entry.field.Code.Text = " ADDIN " + update.code + " ";
        if (update.text) writeRuns(entry.field, [update.text]);
        if (update.bibliography) {
          formatBibliography(
            writeRuns(entry.field, update.bibliography.entries),
            update.bibliography.format,
          );
        }
      }
      return {};
    }

    function removeFields(op) {
      const fields = collect();
      const indexes = [...op.indexes].sort((a, b) => b - a);
      for (const index of indexes) {
        const entry = fields[index];
        if (!entry) continue;
        if (op.keepText) entry.field.Unlink();
        else entry.field.Delete();
      }
      return {};
    }

    function setData(op) {
      const props = doc.CustomDocumentProperties;
      for (let i = props.Count; i >= 1; i--) {
        const prop = props.Item(i);
        if (String(prop.Name).startsWith(PREF)) prop.Delete();
      }
      const data = String(op.data || "");
      for (let i = 0; i * PREF_CHUNK < data.length; i++)
        props.Add(
          PREF + (i + 1),
          false,
          msoPropertyTypeString,
          data.slice(i * PREF_CHUNK, (i + 1) * PREF_CHUNK),
        );
      return {};
    }

    return {
      id() {
        return String(doc.FullName || doc.Name || "document");
      },
      execute(op) {
        switch (op.op) {
          case "Document.getState":
            return getState();
          case "Document.insertField":
            return insertField(op);
          case "Document.updateFields":
            return updateFields(op);
          case "Document.removeFields":
            return removeFields(op);
          case "Document.setData":
            return setData(op);
          default:
            throw new Error("插件版本过旧，请在 Reader 设置中重新安装");
        }
      },
      activate() {
        doc.ActiveWindow.Activate();
      },
    };
  }

  const api = { createDocument, readerCode };
  root.ReaderCiteWord = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
