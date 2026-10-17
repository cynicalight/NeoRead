import { Button } from "@reader/ui/components/button";
import { copyText } from "./clipboard";
import { Copy } from "lucide-react";
import { CachedMarkdown, Streamdown } from "@lobehub/streamdown";
import {
  memo,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  useContext,
  type ReactNode,
  type ComponentProps,
} from "react";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { ErrorBoundary } from "../ErrorBoundary";
import remend from "remend";
import { marked } from "marked";
import {
  ReadingLinkNavigation,
  openExternalLink,
  remarkReadingCitations,
} from "../reading-links";
import "./markdown.css";
import { remarkLatex } from "./remark-latex";
import { ChatCitationNavigation, remarkChatCitations } from "./citations";

const Code = lazy(() => import("./CodeBlock"));
const MathFormula = lazy(() => import("./MathFormula"));
const plugins = [remarkGfm, remarkMath, remarkLatex];
export const safeMarkdownURL = (url: string) =>
  /^(https?:\/\/|mailto:|#)/i.test(url)
    ? url.replace(/(?:[。，；！？]|%E3%80%82|%EF%BC%8C)+$/gi, "")
    : "";
function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const navigate = useContext(ReadingLinkNavigation);
  const evidence = useContext(ChatCitationNavigation);
  if (href?.startsWith("#reader-evidence?")) {
    const sourceId =
      new URLSearchParams(href.split("?")[1]).get("source") ?? "";
    if (!evidence?.sourceIds.includes(sourceId)) return <span>{children}</span>;
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          evidence.navigate(sourceId);
        }}
      >
        {children}
      </a>
    );
  }
  if (href?.startsWith("#"))
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          if (href.startsWith("#reader-citation?")) {
            const params = new URLSearchParams(
              href.slice(href.indexOf("?") + 1),
            );
            navigate?.(params.get("block") ?? "", params.get("label") ?? "");
            return;
          }
          const root = event.currentTarget.closest(".message-markdown");
          const target = Array.from(root?.querySelectorAll("[id]") || []).find(
            (element) => element.id === href.slice(1),
          );
          const viewport = root?.closest('[data-slot="scroll-area-viewport"]');
          if (target && viewport)
            viewport.scrollTop +=
              target.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top;
        }}
      >
        {children}
      </a>
    );
  if (!href) return <span>{children}</span>;
  return (
    <span className="markdown-link">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          if (/^https?:\/\//i.test(href)) {
            event.preventDefault();
            openExternalLink(href);
          }
        }}
      >
        {children}
      </a>
      {!navigate && (
        <Button
          variant="ghost"
          size="icon-xs"
          title="复制链接"
          aria-label={`复制链接 ${href}`}
          onClick={() => void copyText(href)}
        >
          <Copy className="size-3" />
        </Button>
      )}
    </span>
  );
}
function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node && typeof node === "object" && "props" in node)
    return textContent((node.props as { children?: ReactNode }).children);
  return "";
}
const components: Components = {
  img: ({ alt }) => (
    <span className="markdown-image">[图片：{alt || "未加载"}]</span>
  ),
  a: MarkdownLink,
  pre: ({ children }) => <div className="markdown-pre">{children}</div>,
  code: ({ className, children, node }) => {
    const value = textContent(children);
    if (
      className?.includes("math-inline") ||
      className?.includes("math-display")
    ) {
      const display = className.includes("math-display");
      return (
        <Suspense fallback={<code>{value}</code>}>
          <MathFormula value={value} display={display} />
        </Suspense>
      );
    }
    // remark emits a trailing newline for fenced/indented code, including unlabelled fences.
    const block = Boolean(
      className?.startsWith("language-") ||
      value.endsWith("\n") ||
      (node?.position && node.position.start.line !== node.position.end.line),
    );
    return block ? (
      <Suspense
        fallback={
          <pre>
            <code>{value}</code>
          </pre>
        }
      >
        <Code
          content={value}
          language={className?.replace("language-", "") || "text"}
        />
      </Suspense>
    ) : (
      <code>{children}</code>
    );
  },
  table: ({ children }) => (
    <div className="markdown-table">
      <table>{children}</table>
    </div>
  ),
};
export function useMotionPreference() {
  const [reduced, setReduced] = useState(
    () =>
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}
const markdownOptions = {
  remarkPlugins: plugins,
  components,
  skipHtml: true,
  urlTransform: safeMarkdownURL,
};
const StaticBlock = memo(function StaticBlock({
  text,
  citationBlockId,
  generating,
}: {
  text: string;
  citationBlockId?: string;
  generating: boolean;
}) {
  const evidence = useContext(ChatCitationNavigation);
  const options = useMemo<
    Pick<ComponentProps<typeof CachedMarkdown>, "remarkPlugins">
  >(
    () => ({
      remarkPlugins: [
        ...plugins,
        [remarkChatCitations, { sourceIds: evidence?.sourceIds, generating }],
        [remarkReadingCitations, { blockId: citationBlockId }],
      ],
    }),
    [citationBlockId, evidence?.sourceIds, generating],
  );
  return (
    <CachedMarkdown {...markdownOptions} {...options}>
      {text}
    </CachedMarkdown>
  );
});
function StaticMarkdown({
  content,
  generating,
  global,
  citationBlockId,
}: {
  content: string;
  generating: boolean;
  global: boolean;
  citationBlockId?: string;
}) {
  const blocks = useMemo(() => {
    const text = generating ? remend(content) : content;
    // Keep global definitions and math in one parser. Other long responses reuse
    // completed groups of top-level tokens, never splitting a fence/list/table.
    if (
      text.length <= 32_768 ||
      global ||
      text.includes("$") ||
      /\\[([]/.test(text)
    )
      return [text];
    const result: string[] = [];
    let group = "";
    for (const token of marked.lexer(text)) {
      group += token.raw;
      if (group.length >= 8192) {
        result.push(group);
        group = "";
      }
    }
    if (group) result.push(group);
    return result;
  }, [content, generating, global]);
  return (
    <>
      {blocks.map((text, index) => (
        <StaticBlock
          key={index}
          text={text}
          citationBlockId={citationBlockId}
          generating={generating}
        />
      ))}
    </>
  );
}
export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  generating = false,
  reducedMotion = false,
  animated = true,
  citationBlockId,
}: {
  content: string;
  generating?: boolean;
  reducedMotion?: boolean;
  animated?: boolean;
  citationBlockId?: string;
}) {
  const reduced = useMotionPreference();
  const evidence = useContext(ChatCitationNavigation);
  const streamingPlugins = useMemo<
    ComponentProps<typeof CachedMarkdown>["remarkPlugins"]
  >(
    () => [
      ...plugins,
      [remarkChatCitations, { sourceIds: evidence?.sourceIds, generating }],
    ],
    [evidence?.sourceIds, generating],
  );
  const [backgrounded, setBackgrounded] = useState(false);
  useEffect(() => {
    // Once backgrounded, this message stays immediate through completion: no backlog replay.
    const change = () => {
      if (document.hidden) setBackgrounded(true);
    };
    change();
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  // Bound DOM animation cost. Global references use one parser throughout the stream.
  const globalDefinitions =
    /^ {0,3}\[(?:\^)?[^\]]+\]:/m.test(content) ||
    /\[[^\]]+\]\[[^\]]*\]|\[\^/.test(content);
  const animate =
    generating &&
    animated &&
    !reducedMotion &&
    !reduced &&
    !backgrounded &&
    content.length <= 32_768 &&
    !globalDefinitions;
  return (
    <div className="message-markdown" data-animated={animate}>
      {/* A Markdown failure falls back to the raw text of this message only. */}
      <ErrorBoundary
        resetKey={content}
        fallback={<div style={{ whiteSpace: "pre-wrap" }}>{content}</div>}
      >
        {animate ? (
          <Streamdown
            {...markdownOptions}
            remarkPlugins={streamingPlugins}
            content={content}
            smoothing="realtime"
            granularity="word"
          />
        ) : (
          <StaticMarkdown
            content={content}
            generating={generating}
            global={globalDefinitions}
            citationBlockId={citationBlockId}
          />
        )}
      </ErrorBoundary>
    </div>
  );
});
