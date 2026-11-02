import { expect, it } from "vitest";
import { fitText, wrapText } from "./pdf-layout";
import { exportText } from "./pdf-content";

const measure = (text: string, size: number) => [...text].length * size;
it("wraps Chinese punctuation and long Latin words without losing text", () => {
  for (const text of [
    "这是第一段，接着写下一段。",
    "supercalifragilistic",
    "带有（中文）标点的内容。",
    "中文 English 中文",
  ]) {
    const lines = wrapText(text, 60, 10, measure)!;
    expect(lines.join("").replaceAll(" ", "")).toBe(text.replaceAll(" ", ""));
    expect(lines.every((l) => measure(l, 10) <= 60)).toBe(true);
    expect(
      lines.every((l) => !/^[，。）（]/u.test(l) && !/[（]$/u.test(l)),
    ).toBe(true);
  }
});
it("shrinks only within the readability floor and refuses overflow", () => {
  const box = { x: 0, y: 0, width: 100, height: 40 };
  const layout = fitText(
    "这是需要排版的一段译文，需要完整显示。",
    box,
    12,
    measure,
  )!;
  expect(layout.size).toBeGreaterThanOrEqual(7.8);
  expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(40);
  expect(fitText("文字".repeat(1000), box, 12, measure)).toBeNull();
  expect(fitText("文字", { ...box, width: NaN }, 12, measure)).toBeNull();
});
it("keeps readable Markdown text and refuses math, tables, HTML and images", () => {
  expect(
    exportText("## 标题\n\n**译文**与[链接](https://example.com)\n第二句。"),
  ).toBe("标题\n\n译文与链接 第二句。");
  expect(exportText("- 第一项\n- 第二项")).toBe("• 第一项\n• 第二项");
  for (const source of [
    "公式 $x^2$",
    "![图片](image.png)",
    "<script>bad()</script>",
    "|A|B|\n|-|-|\n|1|2|",
  ])
    expect(exportText(source)).toBeNull();
});

it("extracts inline formulas before Markdown parses escapes and keeps literal dollars", () => {
  const formulas: string[] = [];
  const math = (tex: string) => {
    formulas.push(tex);
    return "FORMULA";
  };
  expect(
    exportText(
      String.raw`状态 $h_t$ 与 \(h_{t-1}\)，价格 \$5，代码 ` + "`$x$`。",
      math,
    ),
  ).toBe("状态 FORMULA 与 FORMULA，价格 $5，代码 $x$。");
  expect(formulas).toEqual(["h_t", "h_{t-1}"]);
  expect(exportText("**状态 $x^2$**", math)).toBe("状态 FORMULA");
  expect(exportText("独立 $$x^2$$", math)).toBeNull();
});
