import { expect, it } from "vitest";
import { addScanText, hasScanImage, missingScanText } from "./scan-page";
import type { Region } from "./layout";

const paragraph: Region = {
  label: "text",
  order: 0,
  confidence: 0.9,
  bounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 },
};
const number = {
  text: "38",
  bounds: { x: 0.5, y: 0.94, width: 0.02, height: 0.02 },
};
const line = {
  text: "供给量与价格",
  bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.03 },
};

it("considers scanned prose even with a selectable footer, but not a photograph or an existing CJK text layer", () => {
  expect(missingScanText([paragraph], [number])).toBe(true);
  expect(missingScanText([{ ...paragraph, label: "image" }], [])).toBe(false);
  expect(missingScanText([], [])).toBe(false);
  expect(missingScanText([paragraph], [{ ...line, text: "供" }])).toBe(false);
  expect(addScanText([number], [line, number])).toEqual([number, line]);
});

it("distinguishes a full-page image in a rotated form from a small logo", () => {
  const ops = {
    save: 1,
    restore: 2,
    transform: 3,
    paintFormXObjectBegin: 4,
    paintFormXObjectEnd: 5,
    paintImageXObject: 6,
    paintInlineImageXObject: 7,
    paintImageMaskXObject: 8,
  };
  const list = {
    fnArray: [4, 1, 3, 6, 2, 5],
    argsArray: [[[0, 1, -1, 0, 0, 0]], [], [10, 0, 0, 20, 0, 0], [], [], []],
  };
  expect(hasScanImage(list, ops, 600 * 800)).toBe(false);
  list.argsArray[2] = [590, 0, 0, 780, 0, 0];
  expect(hasScanImage(list, ops, 600 * 800)).toBe(true);
});
