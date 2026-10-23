import { lazy, memo, Suspense } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { openExternalLink } from "./reading-links";
import "./chat/markdown.css";

const MathFormula = lazy(() => import("./chat/MathFormula"));
const plugins = [remarkGfm, remarkMath];
const externalURL = (url: string) => (/^https?:\/\//i.test(url) ? url : "");
const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          openExternalLink(href);
        }}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Previews never fetch remote images or execute embedded HTML.
  img: ({ alt }) => (
    <span className="text-muted-foreground">[图片：{alt || "未加载"}]</span>
  ),
  table: ({ children }) => (
    <div className="markdown-table">
      <table>{children}</table>
    </div>
  ),
  code: ({ className, children }) => {
    if (
      className?.includes("math-inline") ||
      className?.includes("math-display")
    )
      return (
        <Suspense fallback={<code>{children}</code>}>
          <MathFormula
            value={String(children)}
            display={className.includes("math-display")}
          />
        </Suspense>
      );
    return <code className={className}>{children}</code>;
  },
};

/** Note Markdown is deliberately independent from chat streaming/citations. */
export const PaperNoteMarkdown = memo(function PaperNoteMarkdown({
  body,
}: {
  body: string;
}) {
  return (
    <div className="message-markdown paper-note-markdown">
      <Markdown
        remarkPlugins={plugins}
        components={components}
        urlTransform={externalURL}
        skipHtml
      >
        {body}
      </Markdown>
    </div>
  );
});
