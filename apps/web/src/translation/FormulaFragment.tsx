import { FormulaRow } from "./FormulaRow";
import katex from "katex";
import { useMemo, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import { copyText } from "../chat/clipboard";
import "katex/dist/katex.min.css";

export default function FormulaFragment({
  content,
  fallback,
  number,
  onCopyOriginal,
}: {
  content: string;
  fallback: ReactNode;
  number?: string;
  onCopyOriginal?: () => void;
}) {
  const formula = useMemo(() => {
    const expressions = [...content.matchAll(/\$\$([\s\S]*?)\$\$/g)].map(
      (match) => match[1].trim(),
    );
    const source = expressions.length
      ? expressions.map((value) => `$${value}$`).join("\n\n")
      : `$${content.trim()}$`;
    if (!expressions.length) return { source };
    try {
      return {
        source,
        html: expressions
          .map((value) =>
            katex.renderToString(value, {
              displayMode: true,
              throwOnError: true,
              trust: false,
              strict: "ignore",
              maxExpand: 100,
              maxSize: 20,
            }),
          )
          .join(""),
      };
    } catch {
      return { source };
    }
  }, [content]);
  const copyButton = (
    <Button
      variant="ghost"
      size="sm"
      aria-label="复制 LaTeX"
      data-copy-ignore=""
      onClick={(event) => {
        event.stopPropagation();
        void copyText(formula.source, "已复制 LaTeX");
      }}
    >
      <Copy />
      复制 LaTeX
    </Button>
  );
  if (!formula.html)
    return (
      <>
        <FormulaRow number={number}>{fallback}</FormulaRow>
        {copyButton}
      </>
    );
  return (
    <div className="translation-formula">
      <FormulaRow number={number}>
        <div dangerouslySetInnerHTML={{ __html: formula.html }} />
      </FormulaRow>
      {copyButton}
      {fallback && (
        <details className="translation-formula-source">
          <summary>查看原公式</summary>
          {fallback}
          {onCopyOriginal && (
            <Button
              variant="ghost"
              size="sm"
              data-copy-ignore=""
              onClick={(event) => {
                event.stopPropagation();
                onCopyOriginal();
              }}
            >
              <Copy />
              复制原公式
            </Button>
          )}
        </details>
      )}
    </div>
  );
}
