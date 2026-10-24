import type { Run } from "./protocol";

type Style = Omit<Run, "text">;

const inline: Record<string, keyof Style> = {
  I: "i",
  EM: "i",
  B: "b",
  STRONG: "b",
  U: "u",
  SUP: "sup",
  SUB: "sub",
};

function styled(element: Element, style: Style): Style {
  const next = { ...style };
  const key = inline[element.tagName];
  if (key) next[key] = true;
  const css = (element.getAttribute("style") || "").replace(/\s+/g, "");
  if (/font-style:italic/.test(css)) next.i = true;
  if (/font-style:normal/.test(css)) delete next.i;
  if (/font-weight:bold/.test(css)) next.b = true;
  if (/font-weight:normal/.test(css)) delete next.b;
  if (/font-variant:small-caps/.test(css)) next.sc = true;
  if (/font-variant:normal/.test(css)) delete next.sc;
  if (/text-decoration:underline/.test(css)) next.u = true;
  if (/vertical-align:sup/.test(css)) next.sup = true;
  if (/vertical-align:sub/.test(css)) next.sub = true;
  return next;
}

function push(runs: Run[], text: string, style: Style) {
  if (!text) return;
  const last = runs[runs.length - 1];
  const same =
    last &&
    (["i", "b", "u", "sup", "sub", "sc"] as const).every(
      (key) => !!last[key] === !!style[key],
    );
  if (same) last.text += text;
  else runs.push({ text, ...style });
}

/** citeproc-js HTML output to formatted runs; unknown markup keeps its text. */
export function htmlToRuns(html: string): Run[] {
  const body = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    "text/html",
  ).body;
  const runs: Run[] = [];
  const walk = (node: Node, style: Style) => {
    if (node.nodeType === Node.TEXT_NODE) {
      push(runs, node.textContent || "", style);
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") return push(runs, "\n", style);
    const next = styled(node, style);
    node.childNodes.forEach((child) => walk(child, next));
    // A bibliography label is separated from its entry by a tab.
    if (node.classList.contains("csl-left-margin")) push(runs, "\t", style);
  };
  body.childNodes.forEach((child) => walk(child, {}));
  // citeproc ends entries with a newline; only the outer edges are trimmed.
  if (runs.length) runs[0].text = runs[0].text.replace(/^[ \n]+/, "");
  if (runs.length)
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(
      /[ \n]+$/,
      "",
    );
  return runs.filter((run) => run.text);
}

export const plainText = (runs: Run[]) => runs.map((r) => r.text).join("");

/** Word reports paragraph marks and tabs differently; compare loosely. */
export const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
