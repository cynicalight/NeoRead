import { memo, useEffect, useState } from "react";
import { CopyButton } from "../CopyButton";
import { copyText } from "./clipboard";
import type { ThemedToken } from "shiki";
// Fine-grained bundle: only these grammars/themes and the engine ship offline.

export default memo(function CodeBlock({
  content,
  language,
}: {
  content: string;
  language: string;
}) {
  const [result, setResult] = useState<{
    content: string;
    lines: ThemedToken[][];
  }>();
  useEffect(() => {
    let alive = true;
    // Coalesce rapidly changing code; show received source immediately while highlighting catches up.
    const timer = setTimeout(() => {
      if (content.length > 24_000) return;
      void import("./highlighter")
        .then((module) => module.highlighter)
        .then((engine) => {
          if (!alive) return;
          const lang = engine.getLoadedLanguages().includes(language)
            ? language
            : "text";
          setResult({
            content,
            lines: engine.codeToTokens(content, {
              lang,
              themes: { light: "github-light", dark: "github-dark" },
            }).tokens,
          });
        })
        .catch(() => {});
    }, 100);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [content, language]);
  return (
    <div className="markdown-code">
      <div className="code-toolbar">
        <span>{language}</span>
        <CopyButton
          label="复制代码"
          onCopy={() => copyText(content.replace(/\n$/, ""))}
        />
      </div>
      <pre>
        <code>
          {result?.content === content
            ? result.lines.map((line, i) => (
                <span key={i}>
                  {line.map((token, j) => (
                    <span
                      key={j}
                      style={{
                        color: token.color,
                        ...Object.fromEntries(
                          token.htmlStyle
                            ? Object.entries(token.htmlStyle)
                            : [],
                        ),
                      }}
                    >
                      {token.content}
                    </span>
                  ))}
                  {i < result.lines.length - 1 ? "\n" : ""}
                </span>
              ))
            : content}
        </code>
      </pre>
    </div>
  );
});
