import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AnnotationQuote, reflowPDFQuote } from "./AnnotationQuote";
import type { PDFLocation } from "@reader/core";
const part = {
  blockId: "p1-b1",
  sourceHash: "h",
  sentenceIndex: 0,
  source: "An original sentence.",
  target: "完整译文句子。",
};
it("shows source above translation with the exact selected side preserved after reload", () => {
  const location: PDFLocation = JSON.parse(
    JSON.stringify({
      type: "pdf",
      page: 1,
      sentenceLink: { origin: "translation", parts: [part] },
    }),
  );
  const html = renderToStaticMarkup(
    <AnnotationQuote quote="译文" location={location} />,
  );
  expect(html).toContain("An original sentence.");
  expect(html).toContain("<span>译文</span>");
  expect(html).not.toContain("完整译文句子。");
  expect(html.indexOf("原文")).toBeLessThan(html.indexOf("译文"));
  const original = renderToStaticMarkup(
    <AnnotationQuote
      quote="original"
      location={{
        ...location,
        sentenceLink: { origin: "source", parts: [part] },
      }}
    />,
  );
  expect(original).toContain("完整译文句子。");
  expect(original).not.toContain("An original sentence.");
});
it("keeps existing unlinked annotations unchanged", () => {
  expect(
    renderToStaticMarkup(
      <AnnotationQuote quote="旧批注" location={{ type: "pdf", page: 1 }} />,
    ),
  ).toBe("旧批注");
});

it.each([
  [
    "通过对 DAMAS 定位算法的研究，对\nDAMAS 算法进行改进。粗定\n位，提高定位的准确\n性。",
    "通过对 DAMAS 定位算法的研究，对DAMAS 算法进行改进。粗定位，提高定位的准确性。",
  ],
  [
    "Acoustic source\nlocalization improves accuracy.",
    "Acoustic source localization improves accuracy.",
  ],
  ["First line.\n\nSecond paragraph.", "First line.\n\nSecond paragraph."],
  ["中文\r\n换行", "中文换行"],
  ["  source  \n  text", "  source text"],
  ["locali\u00adzation", "locali\u00adzation"],
  ["locali\u00ad\nzation", "localization"],
  ["state-\nof-the-art", "state-of-the-art"],
])("reflows PDF layout lines: %j", (input, expected) => {
  expect(reflowPDFQuote(input)).toBe(expected);
});
it("reflows existing PDF quotes without changing stored anchors or EPUB quotes", () => {
  const quote = "粗定\n位，提高准确\n性。";
  const location: PDFLocation = { type: "pdf", page: 4, quote };
  expect(
    renderToStaticMarkup(<AnnotationQuote quote={quote} location={location} />),
  ).toBe("粗定位，提高准确性。");
  expect(location.quote).toBe(quote);
  expect(
    renderToStaticMarkup(
      <AnnotationQuote
        quote={quote}
        location={{ type: "epub", href: "chapter.xhtml" }}
      />,
    ),
  ).toBe(quote);
});

it("reflows a linked PDF source while preserving authored translation paragraphs", () => {
  const quote = "粗定\n位";
  const location: PDFLocation = {
    type: "pdf",
    page: 4,
    sentenceLink: {
      origin: "source",
      parts: [{ ...part, target: "第一段。\n第二段。" }],
    },
  };
  const html = renderToStaticMarkup(
    <AnnotationQuote quote={quote} location={location} />,
  );
  expect(html).toContain("<span>粗定位</span>");
  expect(html).toContain("第一段。\n第二段。");
});

it.each([
  ["https://host/\npath", "https://host/path"],
  ["See http://example.com/  \r\n  paper", "See http://example.com/paper"],
  ["https://host/a/\nb/\nc", "https://host/a/b/c"],
  ["www.example.com/\npaper", "www.example.com/paper"],
  ["DOI: 10.1234/\nabcdef", "DOI: 10.1234/abcdef"],
  ["(https://doi.org/\n10.1234/\nabcdef)", "(https://doi.org/10.1234/abcdef)"],
  ["input /\noutput", "input / output"],
  [
    "See https://host/page and/or\nother text",
    "See https://host/page and/or other text",
  ],
  ["https://host/\n\nNext paragraph", "https://host/\n\nNext paragraph"],
])(
  "preserves URL slash wraps without joining ordinary prose: %j",
  (input, expected) => {
    expect(reflowPDFQuote(input)).toBe(expected);
  },
);
