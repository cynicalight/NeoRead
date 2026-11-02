import { describe, expect, it } from "vitest";
import { assignText, decodeRegions, isAsset } from "./layout";
describe("layout boundary", () => {
  it("rejects invalid boxes, clips coordinates and retains logical reading order", () => {
    const regions = decodeRegions(
      [
        22,
        0.9,
        -2,
        20,
        70,
        40,
        2,
        21,
        0.8,
        10,
        0,
        90,
        18,
        1,
        3,
        0.99,
        NaN,
        0,
        100,
        10,
        0,
        22,
        0.4,
        0,
        0,
        50,
        50,
        0,
      ],
      100,
      100,
    );
    expect(regions.map((r) => r.label)).toEqual(["table", "text"]);
    expect(regions[1].bounds.x).toBe(0);
  });
  it("suppresses duplicate detections without dropping separate nearby blocks", () => {
    expect(
      decodeRegions(
        [
          21, 0.9, 0, 0, 80, 30, 0, 21, 0.8, 1, 1, 80, 30, 1, 21, 0.8, 0, 35,
          80, 70, 2,
        ],
        100,
        100,
      ),
    ).toHaveLength(2);
  });
  it("preserves unmatched text and does not duplicate spans in overlapping blocks", () => {
    const regions = decodeRegions(
      [22, 0.9, 0, 0, 50, 50, 0, 22, 0.8, 20, 20, 70, 70, 1],
      100,
      100,
    );
    const result = assignText(regions, [
      { text: "shared", bounds: { x: 0.3, y: 0.3, width: 0.1, height: 0.1 } },
      { text: "outside", bounds: { x: 0.8, y: 0.8, width: 0.1, height: 0.1 } },
    ]);
    expect(result.texts.join(" ").match(/shared/g)).toHaveLength(1);
    expect(result.unmatched).toBe("outside");
  });
});

import { readingRegions } from "./layout";
it("keeps inline symbols in prose and groups panels under their shared numbered caption", () => {
  const r = decodeRegions(
    [
      3, 0.9, 10, 10, 30, 30, 0, 3, 0.9, 60, 10, 80, 30, 1, 7, 0.9, 8, 33, 83,
      40, 2, 22, 0.9, 10, 50, 80, 70, 3, 15, 0.9, 20, 55, 25, 60, 4,
    ],
    100,
    100,
  );
  const blocks = readingRegions(r, [
    {
      text: "Figure 1: comparison",
      bounds: { x: 0.1, y: 0.34, width: 0.7, height: 0.05 },
    },
    { text: "prose", bounds: { x: 0.1, y: 0.51, width: 0.1, height: 0.05 } },
    { text: "x", bounds: { x: 0.2, y: 0.55, width: 0.05, height: 0.05 } },
  ]);
  expect(blocks).toHaveLength(3);
  expect(blocks[0].members).toEqual([0, 1]);
  expect(blocks[0].bounds.height).toBeCloseTo(0.2);
  expect(blocks[1].bounds).toEqual(r[2].bounds);
  expect(blocks[1].text).toBe("Figure 1: comparison");
  expect(blocks[2].text).toBe("prose x");
});
it("does not merge neighboring figures with different captions", () => {
  const r = decodeRegions(
    [
      3, 0.9, 5, 5, 40, 20, 0, 3, 0.9, 60, 5, 90, 20, 1, 7, 0.9, 5, 23, 40, 30,
      2, 7, 0.9, 60, 23, 90, 30, 3,
    ],
    100,
    100,
  );
  const blocks = readingRegions(r, [
    {
      text: "Figure 1: left",
      bounds: { x: 0.06, y: 0.24, width: 0.3, height: 0.05 },
    },
    {
      text: "Figure 2: right",
      bounds: { x: 0.61, y: 0.24, width: 0.28, height: 0.05 },
    },
  ]);
  expect(blocks).toHaveLength(4);
  expect(blocks.filter((b) => b.members).map((b) => b.members?.length)).toEqual(
    [1, 1],
  );
});

it("does not absorb an adjacent uncaptioned chart into a narrow caption", () => {
  const r = decodeRegions(
    [
      3, 0.9, 52, 10, 71, 20, 0, 3, 0.9, 72, 10, 91, 20, 1, 7, 0.9, 51, 22, 71,
      25, 2,
    ],
    100,
    100,
  );
  const blocks = readingRegions(r, [
    {
      text: "Figure 11: first chart",
      bounds: { x: 0.52, y: 0.23, width: 0.18, height: 0.01 },
    },
  ]);
  expect(blocks).toHaveLength(3);
  expect(blocks.find((b) => b.members)?.bounds.width).toBeLessThan(0.22);
});

it("expands a grouped crop to include full subfigure captions", () => {
  const r = decodeRegions(
    [
      3, 0.9, 15, 5, 40, 20, 0, 7, 0.9, 10, 21, 41, 25, 1, 7, 0.9, 15, 28, 40,
      32, 2,
    ],
    100,
    100,
  );
  const blocks = readingRegions(r, [
    {
      text: "(a) wide subcaption",
      bounds: { x: 0.11, y: 0.22, width: 0.29, height: 0.02 },
    },
    {
      text: "Figure 1: main",
      bounds: { x: 0.16, y: 0.29, width: 0.23, height: 0.02 },
    },
  ]);
  expect(blocks).toHaveLength(2);
  expect(blocks[0].bounds.x).toBe(0.1);
  expect(blocks[0].bounds.width).toBeCloseTo(0.31);
});

it("keeps the lines and indentation of algorithm blocks", () => {
  const region = (label: string, y: number) => ({
    label,
    confidence: 1,
    order: 0,
    bounds: { x: 0.05, y, width: 0.6, height: 0.2 },
  });
  // Every glyph is 0.005 wide, so a 0.025 gap is five spaces.
  const span = (text: string, x: number, y: number) => ({
    text,
    bounds: { x, y, width: text.length * 0.005, height: 0.01 },
  });
  const { texts } = assignText(
    [region("algorithm", 0.05), region("text", 0.5)],
    [
      span("2", 0.1, 0.14),
      span("latch(record)", 0.15, 0.14),
      span("Algorithm 1: Read phase", 0.1, 0.1),
      span("1", 0.1, 0.12),
      span("Function read(txn, record)", 0.13, 0.12),
      span("Prose wraps", 0.1, 0.55),
      span("onto one line.", 0.1, 0.57),
    ],
  );
  expect(texts[0]).toBe(
    "Algorithm 1: Read phase\n1     Function read(txn, record)\n2         latch(record)",
  );
  expect(texts[1]).toBe("Prose wraps onto one line.");
});

it("keeps algorithm regions as standalone image assets with searchable text", () => {
  const regions = decodeRegions([1, 0.886, 10, 10, 90, 70, 0], 100, 100);
  const blocks = readingRegions(regions, [
    {
      text: "Algorithm 1: Read phase",
      bounds: { x: 0.12, y: 0.12, width: 0.5, height: 0.03 },
    },
    {
      text: "latch(record)",
      bounds: { x: 0.15, y: 0.2, width: 0.3, height: 0.03 },
    },
  ]);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].label).toBe("algorithm");
  expect(blocks[0].text).toContain("latch(record)");
  expect(isAsset(blocks[0].label)).toBe(true);
});

it("keeps a table caption above the table as a separate paragraph at its original bounds", () => {
  const raw = decodeRegions(
    [7, 0.9, 10, 10, 90, 20, 0, 21, 0.9, 10, 22, 90, 65, 1],
    100,
    100,
  );
  const blocks = readingRegions(raw, [
    {
      text: "Table 5: Results",
      bounds: { x: 0.1, y: 0.11, width: 0.6, height: 0.08 },
    },
    {
      text: "Model 90.1",
      bounds: { x: 0.1, y: 0.3, width: 0.6, height: 0.08 },
    },
  ]);
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toMatchObject({
    label: "figure_title",
    text: "Table 5: Results",
    bounds: raw[0].bounds,
  });
  expect(blocks[1]).toMatchObject({
    label: "table",
    text: "Model 90.1",
    bounds: raw[1].bounds,
  });
  expect(blocks[1].caption).toBeUndefined();
});
