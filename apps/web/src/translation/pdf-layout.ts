/** Coordinates are points in the displayed page, with a top-left origin. */
export type Rect = { x: number; y: number; width: number; height: number };
export type TextLayout = { lines: string[]; size: number; lineHeight: number };
export type MeasureText = (text: string, size: number) => number;

const closing = /^[，。！？；：、）】》」』〕〉…,.!?;:%‰\)\]\}]/u;
const opening = /[（【《「『〔〈\(\[\{]$/u;
const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** Keep Latin words together when possible; CJK can break between graphemes. */
function units(text: string): string[] {
  return (
    text
      .match(/[\p{L}\p{N}_]+(?:[-'’][\p{L}\p{N}_]+)*|\s+|[^\s]/gu)
      ?.flatMap((word) =>
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
          word,
        )
          ? [...segmenter.segment(word)].map((s) => s.segment)
          : [word],
      ) ?? []
  );
}

export function wrapText(
  text: string,
  width: number,
  size: number,
  measure: MeasureText,
  maxLines = Infinity,
): string[] | null {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    const queue = units(paragraph);
    for (let i = 0; i < queue.length; i++) {
      if (lines.length >= maxLines) return null;
      let unit = queue[i];
      if (!line && !unit.trim()) continue;
      if (measure(unit, size) > width) {
        const letters = [...segmenter.segment(unit)].map((s) => s.segment);
        if (letters.length === 1) return null;
        queue.splice(i, 1, ...letters);
        unit = queue[i];
        if (measure(unit, size) > width) return null;
      }
      if (measure(line + unit, size) <= width) {
        line += unit;
        continue;
      }
      if (!unit.trim()) {
        lines.push(line.trimEnd());
        line = "";
        continue;
      }
      // Move the final grapheme to the next line rather than strand punctuation.
      if (closing.test(unit) || opening.test(line)) {
        const parts = [...segmenter.segment(line.trimEnd())].map(
          (s) => s.segment,
        );
        const last = parts.pop() ?? "";
        if (!parts.length || measure(last + unit, size) > width) return null;
        lines.push(parts.join(""));
        line = last + unit;
      } else {
        lines.push(line.trimEnd());
        line = unit;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** No clipping or horizontal distortion. A failed fit leaves the original intact. */
export function fitText(
  text: string,
  box: Rect,
  preferredSize: number,
  measure: MeasureText,
  lineHeightRatio = 1.25,
): TextLayout | null {
  if (!text.trim() || !validRect(box)) return null;
  const maximum = Math.max(6, Math.min(32, preferredSize));
  const minimum = Math.max(6, maximum * 0.65);
  for (let size = maximum; size >= minimum - 0.001; size -= 0.25) {
    const lineHeight = size * lineHeightRatio;
    const lines = wrapText(
      text,
      box.width,
      size,
      measure,
      Math.floor(box.height / lineHeight),
    );
    if (lines && lines.length * lineHeight <= box.height + 0.01)
      return { lines, size, lineHeight };
  }
  return null;
}

export function validRect(box: Rect): boolean {
  return (
    Object.values(box).every(Number.isFinite) && box.width > 0 && box.height > 0
  );
}

export function overlaps(a: Rect, b: Rect): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.1 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.1
  );
}
