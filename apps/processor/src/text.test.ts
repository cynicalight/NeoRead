import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, it } from "vitest";
import { extractTextSpans } from "./text";

it("drops slightly offset overprint without dropping the same word elsewhere", async () => {
  const stream = [
    "BT /F1 12 Tf",
    "1 0 0 1 40 350 Tm (Foreword) Tj",
    "1 0 0 1 40.4 350.1 Tm (Foreword) Tj",
    "1 0 0 1 210 350 Tm (Foreword) Tj",
    "1 0 0 1 40 330 Tm (Foreword) Tj ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  const task = getDocument({
    data: new TextEncoder().encode(pdf),
    useSystemFonts: true,
  });
  try {
    const page = await (await task.promise).getPage(1);
    for (const scale of [1, 2]) {
      const spans = await extractTextSpans(page, scale);
      expect(spans.map(({ text }) => text.trim())).toEqual([
        "Foreword",
        "Foreword",
        "Foreword",
      ]);
      expect(spans.map(({ bounds }) => bounds.x)).toEqual([0.1, 0.525, 0.1]);
      expect(spans[2].bounds.y).toBeGreaterThan(spans[0].bounds.y);
    }
  } finally {
    await task.destroy();
  }
});
