import { expect, it } from "vitest";
import { conferenceVenue } from "./conferences";
import { paperByline, venueLabel } from "./format";
import { paper } from "./fixtures";

it.each([
  ["Neural Information Processing Systems", "NeurIPS"],
  ["Advances in Neural Information Processing Systems 36", "NeurIPS"],
  ["  INTERNATIONAL   CONFERENCE ON MACHINE LEARNING  ", "ICML"],
  ["International Joint Conference on Artificial Intelligence", "IJCAI"],
  ["International Conference on Learning Representations", "ICLR"],
  ["NeurIPS", "NeurIPS"],
  ["NIPS", "NeurIPS"],
])("abbreviates the recognized venue %s without changing metadata", (venue, label) => {
  const doc = paper({ author: "Ada", metadata: { venue, date: "2023" } });
  expect(conferenceVenue(venue).label).toBe(label);
  expect(venueLabel(doc.metadata)).toBe(venue);
  expect(paperByline(doc)).toBe(`Ada · 2023 · ${venue}`);
  expect(doc.metadata.venue).toBe(venue);
});

it.each([
  "An Unknown Conference 2023",
  "NeurIPS Workshop on Machine Learning",
  "International Conference on Machine Learning Workshops",
  "Proceedings of the ACL: System Demonstrations",
])("preserves unknown and non-main-conference venues: %s", (venue) => {
  expect(conferenceVenue(venue)).toEqual({ label: venue });
  expect(venueLabel({ venue })).toBe(venue);
});

it("retains arXiv fallback when no venue exists", () => {
  expect(venueLabel({ arxiv: "1706.03762" })).toBe("arXiv:1706.03762");
  expect(venueLabel({})).toBe("");
});
