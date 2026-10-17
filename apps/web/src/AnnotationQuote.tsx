import type { DocumentLocation } from "@reader/core";
/** Reflow PDF layout lines for display without changing stored text or anchors. */
export function reflowPDFQuote(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(
      /(\S)[^\S\n]*\n[^\S\n]*(?=(\S))/gu,
      (_, left: string, right: string, offset: number, input: string) => {
        if (left === "\u00ad") return "";
        // A hard hyphen may be part of a compound; preserve it.
        if (left === "-") return left;
        if (left === "/") {
          // Rejoin earlier slash wraps when recognizing a multi-line URL/DOI.
          const prefix = input
            .slice(0, offset + 1)
            .replace(/\/[^\S\n]*\n[^\S\n]*/g, "/");
          if (
            /(?:^|[\s(])(?:https?:\/\/|www\.|10\.\d{4,9}\/)\S*$/i.test(prefix)
          )
            return left;
        }
        const cjk =
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
        const punctuation = /[，。！？；：、）》」』】]/u;
        return (
          left +
          (cjk.test(left) ||
          cjk.test(right) ||
          punctuation.test(left) ||
          punctuation.test(right)
            ? ""
            : " ")
        );
      },
    );
}

/** The marked side keeps its excerpt; its counterpart uses whole sentences. */
export function AnnotationQuote({
  quote,
  location,
}: {
  quote: string;
  location: DocumentLocation;
}) {
  const pair = location.type === "pdf" ? location.sentenceLink : undefined;
  if (!pair?.parts.length)
    return <>{location.type === "pdf" ? reflowPDFQuote(quote) : quote}</>;
  const source =
    pair.origin === "source"
      ? quote
      : pair.parts.map((p) => p.source).join(" ");
  const target =
    pair.origin === "translation"
      ? quote
      : pair.parts.map((p) => p.target).join(" ");
  return (
    <span className="annotation-quote-pair">
      <span>
        <span className="annotation-quote-label">原文</span>
        <span>{reflowPDFQuote(source)}</span>
      </span>
      <span>
        <span className="annotation-quote-label">译文</span>
        <span>{target}</span>
      </span>
    </span>
  );
}
