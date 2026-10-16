import { expect, it } from "vitest";
import { migratePDFMarks } from "./endnote-pdf";
function fixture(rotation = 0, reply = false) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /CropBox [20 30 180 270] /Rotate ${rotation} /Resources << >> /Contents 4 0 R /Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R] >>`,
    "<< /Length 0 >>\nstream\n\nendstream",
    "<< /Type /Annot /Subtype /Underline /Rect [40 90 100 100] /QuadPoints [40 100 100 100 40 90 100 90] /C [1 0.5 0] /Contents (underline comment) >>",
    "<< /Type /Annot /Subtype /Highlight /Rect [40 110 100 120] /QuadPoints [40 120 100 120 40 110 100 110] /C [1 1 0] >>",
    `<< /Type /Annot /Subtype /Text /Rect [110 90 130 110] /Contents (sticky note) ${reply ? "/IRT 5 0 R /RT /R" : ""} >>`,
    "<< /Type /Annot /Subtype /StrikeOut /Rect [40 130 100 140] /QuadPoints [40 140 100 140 40 130 100 130] >>",
    "<< /Type /Annot /Subtype /Link /Rect [40 150 100 160] /A << /S /URI /URI (https://example.com) >> >>",
  ];
  let data = "%PDF-1.7\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(data.length);
    data += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = data.length;
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    data += `${String(offset).padStart(10, "0")} 00000 n \n`;
  data += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new TextEncoder().encode(data);
}
it.each([0, 90, 180, 270])(
  "converts supported marks and preserves links/unsupported marks with rotation %i",
  async (rotation) => {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const result = await migratePDFMarks(getDocument, fixture(rotation));
    expect(result.marks.map((m) => m.kind)).toEqual([
      "underline",
      "highlight",
      "note",
    ]);
    expect(result.marks[0].note).toBe("underline comment");
    expect(result.marks[2].note).toBe("sticky note");
    expect(result.warnings).toHaveLength(1);
    if (rotation === 90)
      expect(result.marks[0].location.rects[0]).toEqual({
        x: 0.25,
        y: 0.125,
        width: 10 / 240,
        height: 60 / 160,
      });
    const task = getDocument({ data: result.bytes.slice(), verbosity: 0 });
    try {
      const pdf = await task.promise;
      const annots = await (await pdf.getPage(1)).getAnnotations();
      expect(annots.map((a) => a.subtype).sort()).toEqual([
        "Link",
        "StrikeOut",
      ]);
    } finally {
      await task.destroy();
    }
    // Reprocessing the cleaned document must not create duplicate Reader marks.
    const again = await migratePDFMarks(getDocument, result.bytes.slice());
    expect(again.marks).toEqual([]);
  },
);

it("keeps the entire reply thread attached to its parent", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const result = await migratePDFMarks(getDocument, fixture(0, true));
  expect(result.marks.map((m) => m.kind)).toEqual(["highlight"]);
  const task = getDocument({ data: result.bytes.slice(), verbosity: 0 });
  try {
    const annotations = await (
      await (await task.promise).getPage(1)
    ).getAnnotations();
    const reply = annotations.find((a) => a.inReplyTo);
    expect(reply).toBeDefined();
    expect(
      annotations.some(
        (a) => a.id === reply.inReplyTo && a.subtype === "Underline",
      ),
    ).toBe(true);
  } finally {
    await task.destroy();
  }
});
