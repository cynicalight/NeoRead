import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import katex from "katex";
import { remarkLatex } from "./chat/remark-latex";

// A self-contained print document: no app theme, reader zoom, scripts or remote assets.
export function markdownPrintHTML(markdown: string): string {
  const body = renderToStaticMarkup(
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm, remarkMath, remarkLatex]}
      urlTransform={(url) => (/^(https?:\/\/|mailto:|#)/i.test(url) ? url : "")}
      components={{
        img: ({ alt }) => <span>[图片：{alt || "未包含"}]</span>,
        code: ({ className, children }) => {
          if (
            className?.includes("math-inline") ||
            className?.includes("math-display")
          ) {
            return (
              <span
                dangerouslySetInnerHTML={{
                  __html: katex.renderToString(String(children).trimEnd(), {
                    output: "mathml",
                    displayMode: className.includes("math-display"),
                    throwOnError: false,
                    trust: false,
                    maxExpand: 1000,
                  }),
                }}
              />
            );
          }
          return <code>{children}</code>;
        },
      }}
    >
      {markdown}
    </ReactMarkdown>,
  );
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>译文</title><style>
@page { size: A4; margin: 20mm; }
body { font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.6; color: #111; background: white; overflow-wrap: anywhere; }
h1,h2,h3,h4,h5,h6 { line-height: 1.4; break-after: avoid; }
h1 { font-size: 1.4em; } h2 { font-size: 1.25em; } h3 { font-size: 1.1em; }
p { margin: .65em 0; orphans: 3; widows: 3; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 2px solid #ccc; color: #555; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
code { font-family: ui-monospace, monospace; font-size: .95em; }
pre:has(math) { white-space: normal; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; }
th,td { border: 1px solid #ccc; padding: .4em; vertical-align: top; }
thead { display: table-header-group; } tr { break-inside: avoid; }
a { color: inherit; } math[display="block"] { margin: 1em 0; }
</style></head><body>${body}</body></html>`;
}

export async function printMarkdownInBrowser(
  html: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const frame = document.createElement("iframe");
  frame.title = "译文打印";
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.style.cssText =
    "position:fixed;left:-10000px;width:800px;height:600px;border:0";
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => finish(new DOMException("已取消导出", "AbortError"));
      const timer = setTimeout(
        () => finish(new Error("打印页面加载超时")),
        30_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      frame.onload = () => finish();
      signal.addEventListener("abort", abort, { once: true });
      frame.srcdoc = html;
      document.body.append(frame);
    });
    signal.throwIfAborted();
    if (!frame.contentWindow) throw new Error("无法打开打印页面");
    await frame.contentDocument?.fonts.ready;
    signal.throwIfAborted();
    // afterprint closes preview; it does not prove that a file was saved.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(new DOMException("已取消导出", "AbortError"));
      };
      frame.contentWindow!.addEventListener("afterprint", cleanup, {
        once: true,
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        frame.contentWindow!.print();
      } catch (error) {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    });
  } finally {
    frame.remove();
  }
}
