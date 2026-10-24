import { expect, it } from "vitest";
import { encodeForVBA } from "./vba";

it("encodes field updates line by line with escaped text", () => {
  expect(
    encodeForVBA({
      op: "Document.updateFields",
      updates: [
        {
          index: 2,
          code: 'READER_CITATION {"t":"a\\tb"}',
          text: [{ text: "[1]", sup: true }],
        },
        {
          index: 0,
          bibliography: {
            entries: [
              [{ text: "[1]\tA. " }, { text: "T", i: true }],
              [{ text: "[2]\tB" }],
            ],
            format: {
              hangingIndent: false,
              secondFieldAlign: "flush",
              maxOffset: 3,
              lineSpacing: 1,
              entrySpacing: 0,
            },
          },
        },
      ],
    }).split("\n"),
  ).toEqual([
    "op\tDocument.updateFields",
    "field\t2",
    'code\tREADER_CITATION {"t":"a\\\\tb"}',
    "text",
    "run\t^\t[1]",
    "end",
    "field\t0",
    "bibliography\t0\tflush\t3\t1\t0",
    "run\t\t[1]\\tA. ",
    "run\ti\tT",
    "para",
    "run\t\t[2]\\tB",
    "end",
  ]);
});

it("lists removed fields from the last one", () => {
  expect(
    encodeForVBA({
      op: "Document.removeFields",
      indexes: [0, 3, 1],
      keepText: true,
    }),
  ).toBe(
    "op\tDocument.removeFields\nkeepText\t1\nindex\t3\nindex\t1\nindex\t0",
  );
  expect(encodeForVBA({ op: "Document.setData", data: "a\nb" })).toBe(
    "op\tDocument.setData\ndata\ta\\nb",
  );
});
