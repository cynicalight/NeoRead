import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
export default function MathFormula({
  value,
  display,
}: {
  value: string;
  display: boolean;
}) {
  const html = useMemo(
    () =>
      katex.renderToString(value, {
        displayMode: display,
        throwOnError: false,
        trust: false,
        strict: "warn",
        maxExpand: 100,
        maxSize: 20,
      }),
    [value, display],
  );
  // HTML is produced exclusively by KaTeX with trust disabled, never by model HTML.
  return (
    <span
      className={display ? "markdown-math display" : "markdown-math"}
      data-tex={value}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
