import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractTextSpans, mathFontText } from "./text";

it("preserves TeX mathematical alphabets without changing ordinary italic letters or symbols", () => {
  expect(mathFontText("T ∈ ∅ ∩", "VOGGQR+CMSY10")).toBe("𝒯 ∈ ∅ ∩");
  expect(mathFontText("B E F H I L M R", "CMSY7")).toBe("ℬ ℰ ℱ ℋ ℐ ℒ ℳ ℛ");
  expect(mathFontText("R C N Z", "XSBJNE+MSBM10")).toBe("ℝ ℂ ℕ ℤ");
  expect(mathFontText("T", "PFXWVE+CMMI10")).toBe("T");
  expect(mathFontText("Text", "Times-Roman")).toBe("Text");
});

it("reads a CMSY font through PDF.js before assigning its extracted T to prose", async () => {
  // Same BaseFont/ASCII encoding as the reported paper; no external font asset.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /VOGGQR+CMSY10 /Encoding << /Type /Encoding /Differences [84 /T] >> >>",
  ];
  const content = "BT /F1 10 Tf 152 590 Td (T) Tj ET";
  objects.push(
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  );
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const task = getDocument({
    data: new TextEncoder().encode(pdf),
    verbosity: 0,
  });
  try {
    const page = await (await task.promise).getPage(1);
    expect((await page.getTextContent()).items[0]).toMatchObject({ str: "T" });
    expect((await extractTextSpans(page))[0].text).toBe("𝒯");
  } finally {
    await task.destroy();
  }
});
