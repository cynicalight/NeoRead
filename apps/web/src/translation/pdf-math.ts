import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import type { LiteElement } from "mathjax-full/js/adaptors/lite/Element.js";
import {
  concatTransformationMatrix,
  pushGraphicsState,
  popGraphicsState,
  rgb,
  type PDFPage,
} from "pdf-lib";
import { cubicGlyphPath } from "./pdf-svg-path";
import { exportText } from "./pdf-content";
import type { embedExportFonts } from "./pdf-fonts";

type Fonts = Awaited<ReturnType<typeof embedExportFonts>>;
type Matrix = [number, number, number, number, number, number];
type Shape = {
  path?: string;
  rect?: [number, number, number, number];
  transforms: Matrix[];
};
type Formula = {
  width: number;
  ascent: number;
  descent: number;
  shapes: Shape[];
};
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const mathDocument = mathjax.document("", {
  InputJax: new TeX({
    packages: ["base", "ams", "boldsymbol"],
    maxBuffer: 4096,
    maxMacros: 256,
  }),
  OutputJax: new SVG({ fontCache: "none" }),
});

/** Accept only vector geometry produced by the local math engine. No DOM, images or URLs. */
function transforms(value: string): Matrix[] {
  const result: Matrix[] = [];
  const rest = value.replace(
    /(translate|scale|matrix)\(([^)]+)\)/g,
    (_, name: string, args: string) => {
      const n = args
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (!n.every(Number.isFinite)) throw new Error("Invalid math transform");
      if (name === "translate" && n.length >= 1 && n.length <= 2)
        result.push([1, 0, 0, 1, n[0], n[1] ?? 0]);
      else if (name === "scale" && n.length >= 1 && n.length <= 2)
        result.push([n[0], 0, 0, n[1] ?? n[0], 0, 0]);
      else if (name === "matrix" && n.length === 6) result.push(n as Matrix);
      else throw new Error("Unsupported math transform");
      return "";
    },
  );
  if (rest.trim()) throw new Error("Unsupported math transform");
  return result;
}

export function compileFormula(tex: string): Formula {
  if (!tex.trim() || tex.length > 4096)
    throw new Error("Invalid inline formula");
  // Some saved JSON translations decoded the start of \frac as JSON's \f.
  // Repair this unambiguous command spelling only; never rewrite stored text.
  const normalized = tex.replace(/\u000crac(?=\s*\{)/g, String.raw`\frac`);
  const container = mathDocument.convert(normalized, { display: false });
  const svg = adaptor.firstChild(container) as LiteElement;
  const viewBox = adaptor
    .getAttribute(svg, "viewBox")
    ?.split(/\s+/)
    .map(Number);
  if (
    !viewBox ||
    viewBox.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    viewBox[2] <= 0
  )
    throw new Error("Invalid math bounds");
  const shapes: Shape[] = [];
  function visit(node: LiteElement, inherited: Matrix[], root = false) {
    const kind = adaptor.kind(node);
    if (adaptor.getAttribute(node, "data-mml-node") === "merror")
      throw new Error("Invalid TeX");
    if (!["g", "path", "rect"].includes(kind))
      throw new Error("Unsupported math geometry");
    const value = adaptor.getAttribute(node, "transform") ?? "";
    // The SVG outer group flips math coordinates to screen coordinates. PDF
    // already uses upward Y, so retain the original mathematical coordinates.
    if (root && value !== "scale(1,-1)")
      throw new Error("Unexpected math origin");
    const current = [...inherited, ...transforms(root ? "" : value)];
    if (kind === "path")
      shapes.push({
        path: cubicGlyphPath(adaptor.getAttribute(node, "d") ?? ""),
        transforms: current,
      });
    else if (kind === "rect") {
      const rect = ["x", "y", "width", "height"].map((key) =>
        Number(adaptor.getAttribute(node, key) ?? 0),
      );
      if (!rect.every(Number.isFinite))
        throw new Error("Invalid math rectangle");
      shapes.push({ rect: rect as Shape["rect"], transforms: current });
    } else
      for (const child of adaptor.childNodes(node))
        visit(child as LiteElement, current);
  }
  visit(
    adaptor.firstChild(svg) as LiteElement,
    [[1, 0, 0, 1, -viewBox[0], 0]],
    true,
  );
  if (!shapes.length || shapes.length > 5000)
    throw new Error("Unsupported inline formula");
  return {
    width: viewBox[2] / 1000,
    ascent: -viewBox[1] / 1000,
    descent: (viewBox[1] + viewBox[3]) / 1000,
    shapes,
  };
}

function drawFormula(
  page: PDFPage,
  formula: Formula,
  x: number,
  y: number,
  size: number,
) {
  for (const shape of formula.shapes) {
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(size / 1000, 0, 0, size / 1000, x, y),
    );
    for (const matrix of shape.transforms)
      page.pushOperators(concatTransformationMatrix(...matrix));
    if (shape.path) {
      // drawSvgPath applies its own downward-Y transform; cancel it here.
      page.pushOperators(concatTransformationMatrix(1, 0, 0, -1, 0, 0));
      page.drawSvgPath(shape.path, { color: rgb(0, 0, 0) });
    } else if (shape.rect) {
      const [rx, ry, width, height] = shape.rect;
      page.drawRectangle({ x: rx, y: ry, width, height, color: rgb(0, 0, 0) });
    }
    page.pushOperators(popGraphicsState());
  }
}

/** Formula markers are indivisible layout units; they never enter the text font encoder. */
export function preparePDFText(markdown: string, fonts: Fonts) {
  const formulas = new Map<string, Formula>();
  let marker = 0xe000;
  let text: string | null;
  try {
    text = exportText(markdown, (tex) => {
      while (markdown.includes(String.fromCharCode(marker))) marker++;
      if (marker > 0xf8ff) throw new Error("Too many formulas");
      const key = String.fromCharCode(marker++);
      formulas.set(key, compileFormula(tex));
      return key;
    });
  } catch {
    return null;
  }
  if (!text) return null;
  function parts(line: string) {
    const result: { text: string; formula?: Formula }[] = [];
    for (const char of line) {
      const formula = formulas.get(char);
      const last = result.at(-1);
      if (!formula && last && !last.formula) last.text += char;
      else result.push({ text: char, formula });
    }
    return result;
  }
  return {
    text,
    ascent: Math.max(1, ...[...formulas.values()].map((f) => f.ascent)),
    descent: Math.max(0.25, ...[...formulas.values()].map((f) => f.descent)),
    supported: parts(text).every((p) => p.formula || fonts.supports(p.text)),
    measure: (line: string, size: number) =>
      parts(line).reduce(
        (width, p) =>
          width +
          (p.formula ? p.formula.width * size : fonts.measure(p.text, size)),
        0,
      ),
    draw(page: PDFPage, line: string, x: number, y: number, size: number) {
      for (const part of parts(line)) {
        if (part.formula) {
          drawFormula(page, part.formula, x, y, size);
          x += part.formula.width * size;
        } else
          for (const run of fonts.runs(part.text)!) {
            page.drawText(run.text, {
              x,
              y,
              size,
              font: run.font,
              color: rgb(0, 0, 0),
            });
            x += run.font.widthOfTextAtSize(run.text, size);
          }
      }
    },
  };
}
