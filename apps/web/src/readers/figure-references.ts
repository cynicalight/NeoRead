import type { PDFBlock } from "@reader/core";

const number = String.raw`(?:[Ss]?\d+(?:\.\d+)*|[零〇一二三四五六七八九十百两]+)`;
const pattern = new RegExp(
  String.raw`(?:\bfig(?:ure)?\.?\s*|图\s*)(?:\[\s*(${number})\s*\]|［\s*(${number})\s*］|(${number}))(?:\s*\([a-z]\)|[a-z])?(?![\w.]*\d|[a-z])`,
  "gi",
);
function normalize(value: string) {
  if (/^[s\d]/i.test(value))
    return value.toLowerCase().replace(/^0+(?=\d)/, "");
  const digits = "零一二三四五六七八九";
  let total = 0,
    digit = 0;
  for (const char of value.replaceAll("〇", "零").replaceAll("两", "二")) {
    if (char === "十" || char === "百") {
      total += (digit || 1) * (char === "十" ? 10 : 100);
      digit = 0;
    } else digit = digits.indexOf(char);
  }
  return String(total + digit);
}
export function figureReferences(text: string) {
  return Array.from(text.matchAll(pattern), (match) => ({
    index: match.index,
    text: match[0],
    label: normalize(match[1] ?? match[2] ?? match[3]),
  }));
}
const isFigure = (block: PDFBlock) =>
  ["image", "chart", "figure"].includes(block.label);

/** Only captions establish figure numbers; mentions in body text are not targets. */
export function figureTarget(blocks: PDFBlock[], label: string) {
  const matches = (value: string) => {
    // Strip only explicit title prefixes, not arbitrary text before a mention.
    const title = value.trim().replace(/^supplement(?:ary|al)\s+/i, "");
    const first = figureReferences(title)[0];
    return first?.index === 0 && first.label === normalize(label);
  };
  const direct = blocks.filter(
    (block) => isFigure(block) && matches(block.caption || block.text),
  );
  if (direct.length) return direct.length === 1 ? direct[0] : undefined;
  const captions = blocks.filter(
    (block) =>
      ["figure_title", "figure_caption", "caption"].includes(block.label) &&
      matches(block.text),
  );
  if (captions.length !== 1) return;
  const caption = captions[0];
  const candidates = blocks
    .filter((block) => {
      if (!isFigure(block) || block.page !== caption.page) return false;
      const a = block.bounds,
        b = caption.bounds;
      return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x);
    })
    .map((block) => ({
      block,
      distance: Math.min(
        Math.abs(block.bounds.y + block.bounds.height - caption.bounds.y),
        Math.abs(caption.bounds.y + caption.bounds.height - block.bounds.y),
      ),
    }))
    .filter(({ distance }) => distance < 0.15)
    .sort((a, b) => a.distance - b.distance);
  if (
    !candidates.length ||
    (candidates[1] &&
      Math.abs(candidates[0].distance - candidates[1].distance) < 0.005)
  )
    return;
  return candidates[0].block;
}
