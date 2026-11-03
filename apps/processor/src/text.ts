import { pdfFontAscent } from "../../../packages/neoread-core/src/pdf-text";
import type { PDFPageProxy } from "pdfjs-dist";
import type { TextSpan } from "./layout";

export async function extractTextSpans(
  page: PDFPageProxy,
  scale = 1,
): Promise<TextSpan[]> {
  const { Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width),
    height = Math.ceil(viewport.height);
  const content = await page.getTextContent();
  // Loading the operator list makes the embedded font names available. Generic
  // text styles alone cannot distinguish CMSY calligraphic letters from plain T.
  await page.getOperatorList();
  const fonts = new Map<string, string>(
    Object.keys(content.styles).map((key) => [
      key,
      page.commonObjs.get(key).name,
    ]),
  );
  return content.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const transform = Util.transform(viewport.transform, item.transform);
    const h = Math.hypot(transform[2], transform[3]);
    const ascent = pdfFontAscent(content.styles[item.fontName]);
    return [
      {
        text: mathFontText(item.str, fonts.get(item.fontName) ?? ""),
        bounds: {
          x: transform[4] / width,
          y: (transform[5] - h * ascent) / height,
          width: Math.abs(item.width * scale) / width,
          height: h / height,
        },
      },
    ];
  });
}

const script = Array.from("𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵");
const doubleStruck = Array.from("𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ");

// These TeX symbol fonts encode mathematical alphabets as ASCII capitals.
// Only restore the known font encodings; ordinary prose and math italic stay intact.
export function mathFontText(text: string, fontName: string) {
  const name = fontName.replace(/^[A-Z]{6}\+/, "");
  const alphabet = /^CMSY\d+$/i.test(name)
    ? script
    : /^MSBM\d+$/i.test(name)
      ? doubleStruck
      : undefined;
  return alphabet
    ? text.replace(/[A-Z]/g, (letter) => alphabet[letter.charCodeAt(0) - 65])
    : text;
}
