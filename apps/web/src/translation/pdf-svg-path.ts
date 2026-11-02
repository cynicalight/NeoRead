/** Normalize mathematical glyph outlines to absolute cubic curves. PDF has no
 * quadratic curve operator, and pdf-lib's Q/T conversion changes their shape. */
export function cubicGlyphPath(path: string): string {
  const token = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;
  if (path.replace(token, "").replace(/[\s,]/g, ""))
    throw new Error("Invalid glyph path");
  const tokens = path.match(token) ?? [];
  const counts: Record<string, number> = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    C: 6,
    S: 4,
    Q: 4,
    T: 2,
    Z: 0,
  };
  const output: string[] = [];
  let x = 0,
    y = 0,
    startX = 0,
    startY = 0;
  let controlX = 0,
    controlY = 0,
    previous = "",
    command = "",
    index = 0;
  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index])) command = tokens[index++];
    const kind = command.toUpperCase(),
      relative = command !== kind;
    const count = counts[kind];
    if (count === undefined || index + count > tokens.length)
      throw new Error("Unsupported glyph path");
    if (kind === "Z") {
      output.push("Z");
      x = startX;
      y = startY;
      previous = kind;
      command = "";
      continue;
    }
    const values = tokens.slice(index, index + count).map(Number);
    if (!values.every(Number.isFinite))
      throw new Error("Invalid glyph coordinates");
    index += count;
    const point = (offset: number): [number, number] => [
      values[offset] + (relative ? x : 0),
      values[offset + 1] + (relative ? y : 0),
    ];
    let end: [number, number];
    if (kind === "M" || kind === "L") {
      end = point(0);
      output.push(`${kind}${end.join(" ")}`);
      if (kind === "M") {
        [startX, startY] = end;
        command = relative ? "l" : "L";
      }
    } else if (kind === "H" || kind === "V") {
      end =
        kind === "H"
          ? [values[0] + (relative ? x : 0), y]
          : [x, values[0] + (relative ? y : 0)];
      output.push(`L${end.join(" ")}`);
    } else if (kind === "Q" || kind === "T") {
      const control =
        kind === "Q"
          ? point(0)
          : previous === "Q" || previous === "T"
            ? [2 * x - controlX, 2 * y - controlY]
            : [x, y];
      end = point(kind === "Q" ? 2 : 0);
      // Exact degree elevation: preserve the entire curve, not a sampled approximation.
      output.push(
        `C${[x + (2 * (control[0] - x)) / 3, y + (2 * (control[1] - y)) / 3, end[0] + (2 * (control[0] - end[0])) / 3, end[1] + (2 * (control[1] - end[1])) / 3, ...end].join(" ")}`,
      );
      [controlX, controlY] = control;
    } else {
      const first =
        kind === "C"
          ? point(0)
          : previous === "C" || previous === "S"
            ? [2 * x - controlX, 2 * y - controlY]
            : [x, y];
      const second = point(kind === "C" ? 2 : 0);
      end = point(kind === "C" ? 4 : 2);
      output.push(`C${[...first, ...second, ...end].join(" ")}`);
      [controlX, controlY] = second;
    }
    [x, y] = end;
    previous = kind;
  }
  return output.join(" ");
}
