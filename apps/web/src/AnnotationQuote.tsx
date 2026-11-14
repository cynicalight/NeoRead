import type { DocumentLocation } from "@neoread/core";

/** Keep only a legacy mark's positioned side when its excerpts match uniquely. */
function legacyPositionedQuote(
  quote: string,
  location: DocumentLocation,
): string {
  if (location.type !== "pdf" || location.sentenceLink) return quote;
  const anchors = location.sourceAnchors;
  const translation = location.translation;
  let parts: string[] | undefined;
  if (
    anchors?.length &&
    !translation &&
    anchors.every((a) => a.start === undefined && a.end === undefined)
  ) {
    parts = anchors.map((a) => a.source);
  } else if (
    !anchors?.length &&
    translation?.ranges?.length &&
    translation.ranges.every((r) => r.renderedText === undefined)
  ) {
    parts = translation.ranges.map((r) => r.quote);
  }
  if (!parts?.length || parts.some((part) => !part.trim())) return quote;
  let end = 0;
  let extra = "";
  for (const part of parts) {
    const start = quote.indexOf(part, end);
    if (start < 0 || quote.indexOf(part) !== quote.lastIndexOf(part))
      return quote;
    extra += quote.slice(end, start);
    end = start + part.length;
  }
  extra += quote.slice(end);
  return extra.trim() ? parts.join("\n\n") : quote;
}
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
    return (
      <>
        {location.type === "pdf"
          ? reflowPDFQuote(legacyPositionedQuote(quote, location))
          : quote}
      </>
    );
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
