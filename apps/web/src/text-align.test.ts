import { expect, it } from "vitest";
import { alignedSpan } from "./text-align";
import { sentenceTextRanges } from "./readers/pdf-sentence-matching";

const compact = (text: string) => text.replace(/\s/g, "").toLowerCase();
// The PDF text layer keeps subscripts in place; the extracted paragraph moved
// them ("d , … √ d . … the k v query").
const layer = compact(
  "The input consists of queries and keys of dimension dk, and values of dimension dv. We compute the dot products of the query with all keys, divide each by √dk, and apply a softmax function",
);
const block = compact(
  "The input consists of queries and keys of dimension d , and values of dimension √ d . We compute the dot products of the k v query with all keys, divide each by d , and apply a softmax function",
);
const quote = compact(
  "n d , and values of dimension √ d . We compute the dot products of the k v query with all keys, divide each by d",
);

it("finds extracted text in a text layer that orders subscripts differently", () => {
  const span = alignedSpan(layer, quote)!;
  expect(layer.slice(span.start, span.end)).toBe(
    compact(
      "n dk, and values of dimension dv. We compute the dot products of the query with all keys, divide each by √d",
    ),
  );
  expect(alignedSpan(layer, compact("an unrelated sentence elsewhere"))).toBe(
    undefined,
  );
});

it("falls back to the aligned span when the PDF matchers cannot find it", () => {
  const [match] = sentenceTextRanges(layer, block, [quote]);
  expect(layer.slice(match.start, match.end)).toContain(
    compact("and values of dimension dv. We compute"),
  );
});
