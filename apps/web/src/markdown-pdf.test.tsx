import { expect, it } from "vitest";
import { markdownPrintHTML } from "./markdown-pdf";
it("preserves Markdown structures and renders both math delimiter styles", () => {
  const html = markdownPrintHTML(
    "# 标题\n\n中文 **加粗**\n\n- 条目\n\n| A | B |\n|---|---|\n|甲|乙|\n\n$x^2$ 与 \\(y_1\\)\n\n$$\\frac{a}{b}$$\n\n```go\nfmt.Println(1)\n```",
  );
  for (const text of [
    "<h1>标题</h1>",
    "<strong>加粗</strong>",
    "<li>条目</li>",
    "<table>",
    "<math",
    "<mfrac>",
    "fmt.Println(1)",
  ])
    expect(html).toContain(text);
  expect(html).toContain("font-size: 16px");
  expect(html).not.toContain("原文");
});
it("does not turn untrusted document HTML, images or URLs into active content", () => {
  const html = markdownPrintHTML(
    "<script>alert(1)</script>\n\n[链接](javascript:alert%281%29)\n\n![图片](https://private.example/image)\n\n$\\href{javascript:alert(1)}{x}$",
  );
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("https://private.example");
  expect(html).toContain("default-src 'none'");
});

it("renders embedded images and escapes the print filename", () => {
  const html = markdownPrintHTML(
    "![Table 2](data:image/png;base64,aW1hZ2U=)",
    "论文<&>-译文",
  );
  expect(html).toContain(
    '<img src="data:image/png;base64,aW1hZ2U=" alt="Table 2"',
  );
  expect(html).toContain("<title>论文&lt;&amp;&gt;-译文</title>");
  expect(html).toContain("img-src data:");
  expect(
    markdownPrintHTML("![bad](data:text/html;base64,PHNjcmlwdD4=)"),
  ).not.toContain("<img");
});
