import type { TextSpan } from "./layout";

const accents: Record<string, string> = {
  "˜": "tilde",
  ˆ: "hat",
  "¯": "bar",
  "˙": "dot",
  "¨": "ddot",
};
const tex = (text: string) =>
  Array.from(text, (letter) => {
    if (/[𝐀-𝐳]/u.test(letter)) return `\\mathbf{${letter.normalize("NFKD")}}`;
    if (/[𝒜-𝒵ℬℰℱℋℐℒℳℛ]/u.test(letter))
      return `\\mathcal{${letter.normalize("NFKD")}}`;
    if (/[𝔸-𝕑ℂℍℕℙℚℝℤ]/u.test(letter))
      return `\\mathbb{${letter.normalize("NFKD")}}`;
    return letter;
  }).join("");

function mathText(spans: TextSpan[]) {
  type Node = {
    span: TextSpan;
    text: string;
    sub: Node[];
    sup: Node[];
    parent?: Node;
  };
  const nodes: Node[] = spans
    .filter((s) => !accents[s.text])
    .map((span) => ({ span, text: tex(span.text), sub: [], sup: [] }));
  for (const accent of spans.filter((s) => accents[s.text])) {
    const center = accent.bounds.x + accent.bounds.width / 2;
    const owner = nodes
      .filter(
        ({ span }) =>
          center >= span.bounds.x &&
          center <= span.bounds.x + span.bounds.width &&
          Math.abs(span.baseline! - accent.baseline!) < accent.fontSize! * 0.25,
      )
      .sort(
        (a, b) =>
          Math.abs(a.span.bounds.x + a.span.bounds.width / 2 - center) -
          Math.abs(b.span.bounds.x + b.span.bounds.width / 2 - center),
      )[0];
    if (owner) owner.text = `\\${accents[accent.text]}{${owner.text}}`;
    else nodes.push({ span: accent, text: accent.text, sub: [], sup: [] });
  }
  const bySize = [...nodes].sort((a, b) => b.span.fontSize! - a.span.fontSize!);
  for (const node of bySize) {
    const candidates = bySize
      .filter((parent) => {
        const gap =
          node.span.bounds.x - parent.span.bounds.x - parent.span.bounds.width;
        return (
          node !== parent &&
          node.span.fontSize! < parent.span.fontSize! * 0.85 &&
          Math.abs(node.span.baseline! - parent.span.baseline!) >
            parent.span.fontSize! * 0.07 &&
          gap >= -parent.span.fontSize! * 0.35 &&
          gap <= parent.span.fontSize! * 2.5
        );
      })
      .sort(
        (a, b) =>
          Math.abs(node.span.bounds.x - a.span.bounds.x - a.span.bounds.width) -
          Math.abs(node.span.bounds.x - b.span.bounds.x - b.span.bounds.width),
      );
    const parent = candidates[0];
    if (!parent) continue;
    node.parent = parent;
    (node.span.baseline! > parent.span.baseline!
      ? parent.sub
      : parent.sup
    ).push(node);
  }
  const render = (items: Node[]): string =>
    [...items]
      .sort((a, b) => a.span.bounds.x - b.span.bounds.x)
      .map(
        (n) =>
          n.text +
          (n.sub.length ? `_{${render(n.sub)}}` : "") +
          (n.sup.length ? `^{${render(n.sup)}}` : ""),
      )
      .join("");
  const text = render(nodes.filter((n) => !n.parent));
  return /\\(?:mathcal|mathbb|mathbf|tilde|hat|bar|dot|ddot)|[_^]\{/.test(text)
    ? `$${text}$`
    : text;
}

/** Prose baselines define lines; small scripts and overlapping accents belong
 * to those lines rather than being sorted into adjacent sentences. */
export function joinInlineText(spans: TextSpan[]) {
  const weighted = [...spans].sort((a, b) => a.fontSize! - b.fontSize!);
  const total = weighted.reduce((sum, s) => sum + s.text.length, 0);
  let weight = 0;
  const size = weighted.find(
    (s) => (weight += s.text.length) >= total / 2,
  )!.fontSize!;
  const lines: { baseline: number; spans: TextSpan[] }[] = [];
  const anchors = spans
    .filter((s) => s.fontSize! >= size * 0.88)
    .sort((a, b) => a.baseline! - b.baseline!);
  for (const span of anchors) {
    const line = lines.find(
      (l) => Math.abs(l.baseline - span.baseline!) < size * 0.25,
    );
    if (line) line.spans.push(span);
    else lines.push({ baseline: span.baseline!, spans: [span] });
  }
  for (const span of spans.filter((s) => s.fontSize! < size * 0.88)) {
    const line = [...lines].sort(
      (a, b) =>
        Math.abs(a.baseline - span.baseline!) -
        Math.abs(b.baseline - span.baseline!),
    )[0];
    if (line && Math.abs(line.baseline - span.baseline!) < size * 0.65)
      line.spans.push(span);
    else lines.push({ baseline: span.baseline!, spans: [span] });
  }
  return lines
    .sort((a, b) => a.baseline - b.baseline)
    .map((line) => {
      const parts: string[] = [],
        math: TextSpan[] = [];
      const flush = () => {
        if (math.length) parts.push(mathText(math.splice(0)));
      };
      for (const span of line.spans.sort((a, b) => a.bounds.x - b.bounds.x)) {
        if (span.math) math.push(span);
        else {
          flush();
          parts.push(span.text);
        }
      }
      flush();
      return parts.join(" ");
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
