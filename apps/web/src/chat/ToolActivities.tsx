import { useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  CircleSlash,
  CircleX,
  Globe,
  ListChecks,
  Search,
  Wrench,
} from "lucide-react";
import type { ToolActivity, WebSource } from "@neoread/core";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@neoread/ui/components/trace";
import { openExternalLink } from "../reading-links";

// Completed and failed rows carry their state in a unique icon; no text.
const states: Record<ToolActivity["status"], string | undefined> = {
  running: "执行中",
  completed: undefined,
  failed: undefined,
  cancelled: "已取消",
  unavailable: "此网址无法读取",
  deferred: "暂未取得结果",
};
const documentTools = new Set([
  "get_outline",
  "search_document",
  "read_passage",
  "read_pdf_pages",
]);
function isDocumentTool(tool: ToolActivity) {
  const parts = tool.tool.split("/");
  return (
    tool.kind === "tool" &&
    (parts.length === 1 ||
      (parts.length === 2 && parts[0] === "neoread_document")) &&
    documentTools.has(parts.at(-1)!)
  );
}
function displayTarget(tool: ToolActivity) {
  if (!isDocumentTool(tool)) {
    if (tool.target) return tool.target;
    if (tool.kind === "web" && tool.url && /^https?:\/\//i.test(tool.url)) {
      try {
        const url = new URL(tool.url);
        return `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (!tool.target || documentTools.has(tool.target)) return undefined;
  return tool.target
    .split(" · ")[0]
    .replace(/第\s*(\d+)\s*[-–—]\s*(\d+)\s*页/g, (match, first, last) =>
      first === last ? `第 ${first} 页` : match,
    );
}
const rowTitle = (tool: ToolActivity) =>
  [
    states[tool.status],
    isDocumentTool(tool) ? "读取文档" : tool.title,
    displayTarget(tool),
  ]
    .filter(Boolean)
    .join(" · ");
const traceStatus = (status: ToolActivity["status"]) =>
  status === "running" ? "running" : status === "failed" ? "error" : undefined;
function ToolIcon({ tool }: { tool: ToolActivity }) {
  if (tool.status === "failed") return <CircleX />;
  if (
    tool.status === "cancelled" ||
    tool.status === "unavailable" ||
    tool.status === "deferred"
  )
    return <CircleSlash />;
  if (tool.status === "completed") return <Check />;
  if (tool.kind === "search") return <Search />;
  if (tool.kind === "web") return <Globe />;
  return /read|search|page|passage|pdf/i.test(tool.tool) ? (
    <BookOpen />
  ) : (
    <Wrench />
  );
}
function duration(tool: ToolActivity) {
  if (!tool.finishedAt) return undefined;
  const ms = Date.parse(tool.finishedAt) - Date.parse(tool.startedAt);
  return Number.isFinite(ms) && ms >= 0
    ? `${(ms / 1000).toFixed(1)} 秒`
    : undefined;
}

export function ToolActivities({
  tools = [],
  sources = [],
}: {
  tools?: ToolActivity[];
  sources?: WebSource[];
}) {
  const [open, setOpen] = useState(false);
  if (!tools.length && !sources.length) return null;
  const current = tools.filter((tool) => tool.status === "running").at(-1);
  const failed = tools.some((tool) => tool.status === "failed");
  const cancelled = tools.some((tool) => tool.status === "cancelled");
  const summary = `执行记录${failed ? "（有失败）" : cancelled ? "（有取消）" : ""}`;
  return (
    <Trace className="mb-2">
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger title={summary}>
          <TraceLine
            status={current ? "running" : failed ? "error" : undefined}
          >
            <TraceIcon>
              <ListChecks />
            </TraceIcon>
            <TraceTitle>{summary}</TraceTitle>
            <TraceDescription>
              {current ? "执行中 · " : ""}
              {tools.length} 项
              {sources.length ? ` · ${sources.length} 个网页来源` : ""}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent
          keepMounted
          className="max-h-80 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <Trace>
            {tools.map((tool) => {
              const line = (
                <TraceLine status={traceStatus(tool.status)}>
                  <TraceIcon>
                    <ToolIcon tool={tool} />
                  </TraceIcon>
                  <TraceTitle>{rowTitle(tool)}</TraceTitle>
                  {duration(tool) && (
                    <TraceDescription>{duration(tool)}</TraceDescription>
                  )}
                </TraceLine>
              );
              return (
                <div key={tool.id} className="min-w-0">
                  {tool.kind === "web" &&
                  tool.url &&
                  /^https?:\/\//i.test(tool.url) ? (
                    <a
                      href={tool.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        event.preventDefault();
                        void openExternalLink(tool.url!);
                      }}
                    >
                      {line}
                      <span className="sr-only">（在浏览器中打开）</span>
                    </a>
                  ) : (
                    line
                  )}
                  {tool.detail &&
                    tool.detail !== tool.target &&
                    tool.detail !== states[tool.status] && (
                      <p className="mt-1 ml-6 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {tool.detail}
                      </p>
                    )}
                </div>
              );
            })}
            {sources.map((source) => (
              <div key={source.id} className="min-w-0">
                <WebLink url={source.url} title={source.title || source.url} />
                <p className="mt-1 text-xs text-muted-foreground">
                  {source.kind === "page"
                    ? source.text
                      ? "网页正文"
                      : "网页读取记录"
                    : "搜索摘要"}{" "}
                  · {new Date(source.retrievedAt).toLocaleString()}
                  {source.truncated ? " · 已截短" : ""}
                </p>
                {source.text && (
                  <p className="mt-1 max-h-32 overflow-y-auto text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {source.text}
                  </p>
                )}
              </div>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
function WebLink({ url, title }: { url: string; title: string }) {
  if (!/^https?:\/\//i.test(url)) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="block max-w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => {
        event.preventDefault();
        void openExternalLink(url);
      }}
    >
      <TraceLine>
        <TraceIcon>
          <Globe />
        </TraceIcon>
        <TraceTitle>
          {title}
          <span className="sr-only">（在浏览器中打开）</span>
        </TraceTitle>
        <TraceIcon>
          <ArrowUpRight />
        </TraceIcon>
      </TraceLine>
    </a>
  );
}
