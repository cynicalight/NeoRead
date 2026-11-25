import { orderPageBlocks } from "./reading-order";
export const labels = [
  "abstract",
  "algorithm",
  "aside_text",
  "chart",
  "content",
  "display_formula",
  "doc_title",
  "figure_title",
  "footer",
  "footer_image",
  "footnote",
  "formula_number",
  "header",
  "header_image",
  "image",
  "inline_formula",
  "number",
  "paragraph_title",
  "reference",
  "reference_content",
  "seal",
  "table",
  "text",
  "vertical_text",
  "vision_footnote",
] as const;
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Region {
  label: string;
  confidence: number;
  order: number;
  bounds: Box;
}
export interface TextSpan {
  text: string;
  bounds: Box;
}
export const isAsset = (label: string) =>
  [
    "algorithm",
    "chart",
    "image",
    "table",
    "display_formula",
    "inline_formula",
  ].includes(label);
export function intersection(a: Box, b: Box) {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}
const minimumConfidence = 0.5;
// Dense plots, embeddings and structures often score below the general
// threshold. readingRegions keeps such panels only inside a captioned figure.
// The reading settings adjust the panel threshold within 0.2–0.5.
export const defaultPanelConfidence = 0.35;
const isPanel = (label: string) => label === "chart" || label === "image";
// Match PaddleX postprocessing: confidence filtering and per-class/cross-class NMS.
export function decodeRegions(
  data: ArrayLike<number>,
  width: number,
  height: number,
  panelConfidence = defaultPanelConfidence,
): Region[] {
  const boxes: Region[] = [];
  for (let i = 0; i + 6 < data.length; i += 7) {
    const [cls, confidence, x1, y1, x2, y2, order] = Array.from(
      { length: 7 },
      (_, n) => Number(data[i + n]),
    );
    if (
      ![cls, confidence, x1, y1, x2, y2, order].every(Number.isFinite) ||
      !labels[cls] ||
      confidence < (isPanel(labels[cls]) ? panelConfidence : minimumConfidence)
    )
      continue;
    const x = Math.max(0, Math.min(1, x1 / width));
    const y = Math.max(0, Math.min(1, y1 / height));
    const bounds = {
      x,
      y,
      width: Math.max(0, Math.min(1, x2 / width) - x),
      height: Math.max(0, Math.min(1, y2 / height) - y),
    };
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    if (labels[cls] === "image" && bounds.width * bounds.height > 0.9) continue;
    boxes.push({ label: labels[cls], confidence, order, bounds });
  }
  const kept: Region[] = [];
  for (const b of boxes.sort((a, b) => b.confidence - a.confidence)) {
    if (
      kept.some((a) => {
        const shared = intersection(a.bounds, b.bounds);
        const union =
          a.bounds.width * a.bounds.height +
          b.bounds.width * b.bounds.height -
          shared;
        return shared / union > (a.label === b.label ? 0.6 : 0.98);
      })
    )
      continue;
    kept.push(b);
  }
  // A weak box spanning a whole figure duplicates the panels detected in it.
  return kept
    .filter(
      (b) =>
        b.confidence >= minimumConfidence ||
        !isPanel(b.label) ||
        !kept.some(
          (a) =>
            a !== b &&
            isPanel(a.label) &&
            intersection(a.bounds, b.bounds) >
              0.8 * a.bounds.width * a.bounds.height,
        ),
    )
    .sort((a, b) => a.order - b.order);
}
// Each span belongs to at most one region. Unmatched spans are retained separately.
function partitionText(regions: Region[], spans: TextSpan[]) {
  const groups: TextSpan[][] = regions.map(() => []);
  const unmatched: TextSpan[] = [];
  for (const span of spans) {
    let best = -1,
      score = 0.2;
    regions.forEach((region, i) => {
      const overlap =
        intersection(region.bounds, span.bounds) /
        (span.bounds.width * span.bounds.height || 1);
      if (overlap > score) {
        score = overlap;
        best = i;
      }
    });
    if (best < 0) unmatched.push(span);
    else groups[best].push(span);
  }
  return { groups, unmatched };
}

export function assignText(regions: Region[], spans: TextSpan[]) {
  const { groups, unmatched } = partitionText(regions, spans);
  return {
    texts: groups.map((group, i) =>
      regions[i].label === "algorithm" ? joinLines(group) : joinSpans(group),
    ),
    unmatched: joinSpans(unmatched),
  };
}
const sameLine = (a: TextSpan, b: TextSpan) =>
  Math.abs(a.bounds.y - b.bounds.y) <
  Math.min(a.bounds.height, b.bounds.height) * 0.45;
/**
 * Spans grouped into lines in reading order. Body-sized spans form the lines;
 * a smaller span (a subscript or superscript) joins the line its centre falls
 * in, so it stays after the character it belongs to instead of moving to the
 * end of the line.
 */
function readingLines(spans: TextSpan[]): TextSpan[][] {
  const heights = spans.map((s) => s.bounds.height).sort((a, b) => a - b);
  const body = heights[Math.floor(heights.length / 2)] ?? 0;
  const small = (s: TextSpan) => s.bounds.height < body * 0.85;
  // PDF content streams can list columns out of order. Sort only inside one
  // detected region.
  const lines: TextSpan[][] = [];
  // A radical's glyph can sit above the baseline of its operand, overlapping
  // the preceding line. Place it after the ordinary lines have been formed.
  const radical = (s: TextSpan) => s.text.trim() === "√";
  for (const span of [...spans]
    .filter((s) => !small(s) && !radical(s))
    .sort((a, b) => a.bounds.y - b.bounds.y)) {
    const line = lines.find((l) => sameLine(l[0], span));
    if (line) line.push(span);
    else lines.push([span]);
  }
  for (const span of spans.filter(radical)) {
    const right = span.bounds.x + span.bounds.width;
    const candidates = lines
      .flatMap((line) =>
        line.flatMap((other) => {
          const gap = other.bounds.x - right;
          const overlap =
            Math.min(
              span.bounds.y + span.bounds.height,
              other.bounds.y + other.bounds.height,
            ) - Math.max(span.bounds.y, other.bounds.y);
          return gap >= -span.bounds.width * 0.25 &&
            gap <= span.bounds.width &&
            overlap >= Math.min(span.bounds.height, other.bounds.height) * 0.1
            ? [{ line, gap: Math.abs(gap) }]
            : [];
        }),
      )
      .sort((a, b) => a.gap - b.gap);
    const line = candidates[0]?.line ?? lines.find((l) => sameLine(l[0], span));
    if (line) line.push(span);
    else lines.push([span]);
  }
  for (const span of spans.filter((s) => small(s) && !radical(s))) {
    const centre = span.bounds.y + span.bounds.height / 2;
    const line = lines.find(
      (l) =>
        centre >= l[0].bounds.y && centre <= l[0].bounds.y + l[0].bounds.height,
    );
    if (line) line.push(span);
    else lines.push([span]);
  }
  return lines
    .sort((a, b) => a[0].bounds.y - b[0].bounds.y)
    .map((line) => line.sort((a, b) => a.bounds.x - b.bounds.x));
}
function joinSpans(spans: TextSpan[]) {
  return spanText(readingLines(spans).flat());
}
function spanText(spans: TextSpan[]) {
  return spans
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
function joinLines(spans: TextSpan[], lines?: TextSpan[][]) {
  if (!spans.length) return "";
  lines ??= readingLines(spans);
  // Horizontal gaps become spaces at the region's median character width.
  const widths = spans
    .map((s) => s.bounds.width / Math.max(1, s.text.trim().length))
    .sort((a, b) => a - b);
  const char = widths[Math.floor(widths.length / 2)] || 1;
  const spaces = (gap: number, least: number) =>
    " ".repeat(
      gap <= char * 0.15
        ? 0
        : Math.min(40, Math.max(least, Math.round(gap / char))),
    );
  const left = Math.min(...spans.map((s) => s.bounds.x));
  return lines
    .map((line) => {
      let text = spaces(line[0].bounds.x - left, 0),
        end = line[0].bounds.x;
      line.forEach((span, i) => {
        if (i) text += spaces(span.bounds.x - end, 1);
        text += span.text.replace(/\s+/g, " ").trim();
        end = Math.max(end, span.bounds.x + span.bounds.width);
      });
      return text.trimEnd();
    })
    .join("\n");
}

export interface ReadingRegion extends Region {
  text: string;
  ocrLines?: TextSpan[];
  members?: number[];
  caption?: string;
}

function retainOcrLines(
  block: ReadingRegion,
  ordered: TextSpan[],
  ocr: ReadonlySet<TextSpan>,
) {
  for (const span of ordered) {
    if (ocr.has(span)) (block.ocrLines ??= []).push(span);
  }
}
const mainCaption = /^(?:figure|fig\.?|table)\s*\d+[\s:.]/i;
function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}
// Separated by at most a small gap, side by side or stacked.
function adjacent(a: Box, b: Box) {
  const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width),
    gapY = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
  return (gapX < 0 && gapY <= 0.04) || (gapY < 0 && gapX <= 0.04);
}
function gapBetween(a: Box, b: Box): Box {
  const span = (a0: number, a1: number, b0: number, b1: number) =>
    Math.max(a0, b0) > Math.min(a1, b1)
      ? [Math.min(a1, b1), Math.max(a0, b0)]
      : [Math.max(a0, b0), Math.min(a1, b1)];
  const [x0, x1] = span(a.x, a.x + a.width, b.x, b.x + b.width),
    [y0, y1] = span(a.y, a.y + a.height, b.y, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
// Inline symbols remain in their paragraph. Group panels only when a nearby
// numbered caption provides evidence that they belong to one figure; panels
// stacked above the caption join through their adjacent grouped neighbours.
export function readingRegions(
  raw: Region[],
  spans: TextSpan[],
  ocr?: ReadonlySet<TextSpan>,
) {
  const regions = raw.filter((r) => r.label !== "inline_formula");
  const assigned = assignText(regions, spans);
  const entries: ReadingRegion[] = regions.map((r, i) => ({
    ...r,
    text: assigned.texts[i],
  }));
  const captions = entries.filter(
    (r) => r.label === "figure_title" && mainCaption.test(r.text),
  );
  // Two-column captions continue in an unnumbered title on the same row.
  const continuations = new Map(
    captions.map((c) => [
      c,
      entries.filter(
        (r) =>
          r.label === "figure_title" &&
          !mainCaption.test(r.text) &&
          Math.abs(r.bounds.y - c.bounds.y) < 0.02,
      ),
    ]),
  );
  const extent = new Map(
    captions.map((c) => [
      c,
      union([c.bounds, ...continuations.get(c)!.map((r) => r.bounds)]),
    ]),
  );
  const tolerance = (c: ReadingRegion) => Math.min(0.12, c.bounds.width / 4);
  // Prose or another numbered caption separates figures.
  const separators = entries.filter(
    (r) =>
      r.label === "text" ||
      r.label === "paragraph_title" ||
      mainCaption.test(r.text),
  );
  const owner = new Map<ReadingRegion, ReadingRegion>();
  for (const asset of entries.filter((r) =>
    ["chart", "image", "table"].includes(r.label),
  )) {
    const b = asset.bounds;
    const eligible = captions
      .filter((c) => {
        if ((asset.label === "table") !== /^table/i.test(c.text)) return false;
        const cb = c.bounds;
        const gap =
          asset.label === "table"
            ? Math.min(
                Math.abs(cb.y - b.y - b.height),
                Math.abs(b.y - cb.y - cb.height),
              )
            : cb.y - b.y - b.height;
        const center = b.x + b.width / 2,
          x = asset.label === "table" ? cb : extent.get(c)!;
        if (
          gap < -0.01 ||
          gap > 0.12 ||
          center < x.x - tolerance(c) ||
          center > x.x + x.width + tolerance(c)
        )
          return false;
        // Do not combine across intervening prose or another numbered caption.
        return !separators.some(
          (r) =>
            r !== asset &&
            r !== c &&
            r.bounds.y > b.y + b.height &&
            r.bounds.y + r.bounds.height < cb.y &&
            center >= r.bounds.x &&
            center <= r.bounds.x + r.bounds.width,
        );
      })
      .sort(
        (a, z) =>
          Math.abs(a.bounds.y - b.y - b.height) -
          Math.abs(z.bounds.y - b.y - b.height),
      );
    const caption = eligible[0];
    if (caption) owner.set(asset, caption);
  }
  const panels = entries.filter((r) => isPanel(r.label));
  for (let changed = true; changed;) {
    changed = false;
    for (const asset of panels) {
      if (owner.has(asset)) continue;
      const b = asset.bounds,
        center = b.x + b.width / 2;
      const candidates = new Set(
        [...owner]
          .filter(([member, c]) => {
            const x = extent.get(c)!;
            return (
              isPanel(member.label) &&
              b.y + b.height <= c.bounds.y + 0.01 &&
              center >= x.x - tolerance(c) &&
              center <= x.x + x.width + tolerance(c) &&
              adjacent(b, member.bounds) &&
              !separators.some(
                (r) => intersection(r.bounds, gapBetween(b, member.bounds)) > 0,
              )
            );
          })
          .map(([, c]) => c),
      );
      if (candidates.size !== 1) continue;
      owner.set(asset, [...candidates][0]);
      changed = true;
    }
  }
  const groups = new Map<ReadingRegion, ReadingRegion[]>();
  for (const [asset, caption] of [...owner].sort(
    ([a], [b]) => a.order - b.order,
  ))
    groups.set(caption, [...(groups.get(caption) ?? []), asset]);
  const consumed = new Set<ReadingRegion>();
  const merged: (Region & { members: number[] })[] = [];
  for (const [caption, assets] of groups) {
    let bounds = union([caption.bounds, ...assets.map((a) => a.bounds)]);
    // Subfigure captions inside the figure, not the caption's next column.
    const parts = entries.filter(
      (r) =>
        r.label === "figure_title" &&
        !mainCaption.test(r.text) &&
        !continuations.get(caption)!.includes(r) &&
        intersection(r.bounds, bounds) / (r.bounds.width * r.bounds.height) >
          0.8,
    );
    const members = [...assets, ...parts];
    bounds = union(members.map((r) => r.bounds));
    members.forEach((r) => consumed.add(r));
    merged.push({
      ...assets[0],
      bounds,
      order: Math.min(...members.map((r) => r.order)),
      confidence: Math.min(...assets.map((r) => r.confidence)),
      members: members.map((r) => r.order),
    });
  }
  const composed = orderPageBlocks(
    [
      ...entries.filter(
        (r) =>
          !consumed.has(r) &&
          !(isPanel(r.label) && r.confidence < minimumConfidence),
      ),
      ...merged,
    ].sort((a, b) => a.order - b.order),
  );
  const final = partitionText(composed, spans);
  const blocks = composed.flatMap((region, i): ReadingRegion[] => {
    const group = final.groups[i];
    if (!group.length) return [{ ...region, text: "" }];
    const lines = readingLines(group);
    // Assign spans before splitting so competing regions cannot claim a row twice.
    if (region.label === "content") {
      const split = lines.length > 1;
      return lines.map((line) => {
        const block: ReadingRegion = {
          ...region,
          bounds: split
            ? union(line.map((span) => span.bounds))
            : region.bounds,
          text: spanText(line),
        };
        if (ocr) retainOcrLines(block, line, ocr);
        return block;
      });
    }
    if (region.label === "algorithm") {
      const block: ReadingRegion = { ...region, text: joinLines(group, lines) };
      if (ocr) retainOcrLines(block, lines.flat(), ocr);
      return [block];
    }
    const ordered = lines.flat();
    const block: ReadingRegion = { ...region, text: spanText(ordered) };
    if (ocr) retainOcrLines(block, ordered, ocr);
    return [block];
  });
  if (!ocr || !final.unmatched.length)
    return { blocks, unmatched: joinSpans(final.unmatched) };

  // Give unassigned OCR lines real text blocks without renumbering composed
  // blocks or repeating the same text in the unmatched Markdown section.
  const native: TextSpan[] = [];
  for (const line of readingLines(final.unmatched).flat()) {
    if (!ocr.has(line)) {
      native.push(line);
      continue;
    }
    const text = line.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    blocks.push({
      label: "text",
      confidence: 0,
      order: blocks.length,
      bounds: line.bounds,
      text,
      ocrLines: [line],
    });
  }
  return { blocks, unmatched: spanText(native) };
}
