import { Marked, type Token, type Tokens } from "marked";
import type { PDFBlock, TranslationBlock } from "@neoread/core";

export const preservedLabels = new Set([
  "image",
  "figure",
  "table",
  "chart",
  "display_formula",
  "inline_formula",
  "formula_number",
  "reference",
  "reference_content",
  "header",
  "footer",
  "number",
]);

/** Convert ordinary Markdown to text. Complex structures stay in the original PDF. */
export function exportText(
  markdown: string,
  inlineMath?: (tex: string) => string,
): string | null {
  if (markdown.length > 50_000) return null;
  // Parse math before Markdown consumes TeX escapes and underscores. Code spans,
  // escaped dollars and link destinations retain their normal Markdown meaning.
  const parser = new Marked({
    extensions: [
      {
        name: "exportMath",
        level: "inline",
        start: (source) => source.search(/\\[([]|\$/u),
        tokenizer(source) {
          const match =
            /^(?:\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\$((?:\\.|[^$\n])+?)\$|\\\(([\s\S]*?)\\\))/.exec(
              source,
            );
          if (!match) return;
          return {
            type: "exportMath",
            raw: match[0],
            text: match[3] ?? match[4],
            display: match[1] !== undefined || match[2] !== undefined,
          };
        },
      },
    ],
  });
  let supported = true;
  const flatten = (tokens: Token[]): string =>
    tokens
      .map((token): string => {
        switch (token.type) {
          case "exportMath":
            if (token.display || !inlineMath) {
              supported = false;
              return "";
            }
            return inlineMath(token.text);
          case "space":
            return "\n";
          case "br":
            return "\n";
          case "text":
          case "paragraph":
          case "heading":
          case "strong":
          case "em":
          case "del":
          case "link":
            return (
              ("tokens" in token && token.tokens
                ? flatten(token.tokens)
                : token.text.replaceAll("\n", " ")) +
              (["paragraph", "heading"].includes(token.type) ? "\n" : "")
            );
          case "escape":
          case "codespan":
            return token.text;
          case "list":
            return (
              (token as Tokens.List).items
                .map(
                  (item, i) =>
                    `${token.ordered ? `${Number(token.start || 1) + i}.` : "•"} ${flatten(item.tokens).trim()}`,
                )
                .join("\n") + "\n"
            );
          case "blockquote":
            return flatten(token.tokens ?? []);
          default:
            supported = false;
            return "";
        }
      })
      .join("");
  const text = flatten(parser.lexer(markdown))
    .trim()
    .replace(/\n{3,}/g, "\n\n");
  return supported && text ? text : null;
}

/** Match the server's translationHash; reject a snapshot from a different parse. */
export async function matchesSource(
  block: PDFBlock,
  translation: TranslationBlock,
): Promise<boolean> {
  const bytes = new TextEncoder().encode(`zh-CN:v1:${block.text.trim()}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return (
    [...new Uint8Array(hash)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("") === translation.sourceHash
  );
}
