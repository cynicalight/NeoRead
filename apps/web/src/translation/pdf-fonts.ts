import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";

export type FontBytes = { cjk: Uint8Array; latin: Uint8Array };
type Face = { pdf: PDFFont; source: fontkit.Font };

/** Use the same font runs for measurement and writing, including Greek/symbol fallback. */
export async function embedExportFonts(
  document: PDFDocument,
  bytes: FontBytes,
) {
  document.registerFontkit(fontkit);
  // Keep the bundled CJK font complete. Fontkit's subset encoder can drop the
  // composite glyph outlines while leaving valid Unicode mappings behind.
  const faces: Face[] = await Promise.all(
    [bytes.cjk, bytes.latin].map(async (data) => ({
      source: fontkit.create(data),
      pdf: await document.embedFont(data, { subset: false }),
    })),
  );
  const glyphs = new Map<string, Face | null>();
  function faceFor(char: string): Face | null {
    if (glyphs.has(char)) return glyphs.get(char)!;
    const face = faces.find((f) =>
      f.source.hasGlyphForCodePoint(char.codePointAt(0)!),
    );
    if (!face) {
      glyphs.set(char, null);
      return null;
    }
    const box = face.source.glyphForCodePoint(char.codePointAt(0)!).bbox;
    const supported =
      box.maxY <= face.source.unitsPerEm &&
      box.minY >= -face.source.unitsPerEm * 0.25;
    glyphs.set(char, supported ? face : null);
    return supported ? face : null;
  }
  function runs(text: string) {
    const result: { text: string; font: PDFFont }[] = [];
    for (const char of text) {
      const face = faceFor(char);
      if (!face) return null;
      const last = result.at(-1);
      if (last?.font === face.pdf) last.text += char;
      else result.push({ text: char, font: face.pdf });
    }
    return result;
  }
  const widthCache = new Map<string, number>();
  return {
    runs,
    supports: (text: string) => runs(text.replaceAll("\n", "")) !== null,
    measure: (text: string, size: number) => {
      let width = widthCache.get(text);
      if (width === undefined) {
        const parts = runs(text);
        width = parts
          ? parts.reduce(
              (sum, r) => sum + r.font.widthOfTextAtSize(r.text, 1),
              0,
            )
          : Infinity;
        // Keep measurements bounded for long books.
        if (widthCache.size >= 5000) widthCache.clear();
        widthCache.set(text, width);
      }
      return width * size;
    },
  };
}
