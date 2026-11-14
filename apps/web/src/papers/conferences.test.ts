import { expect, it } from "vitest";
import conferences from "../../../server/internal/neoread/conferences.json";
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
])(
  "abbreviates the recognized venue %s without changing metadata",
  (venue, label) => {
    const doc = paper({ author: "Ada", metadata: { venue, date: "2023" } });
    expect(conferenceVenue(venue).label).toBe(label);
    expect(venueLabel(doc.metadata)).toBe(venue);
    expect(paperByline(doc)).toBe(`Ada · 2023 · ${venue}`);
    expect(doc.metadata.venue).toBe(venue);
  },
);

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

it.each([
  [
    "Proceedings of the 2026 ACM SIGSAC Conference on Computer and Communications Security",
    "CCS",
  ],
  ["USENIX Annual Technical Conference", "USENIX ATC"],
  [
    "Proceedings of the 20th USENIX Symposium on Operating Systems Design and Implementation",
    "OSDI",
  ],
  [
    "Proceedings of the 2019 Conference of the North American Chapter of the Association for Computational Linguistics: Human Language Technologies, Volume 1 (Long and Short Papers)",
    "NAACL",
  ],
  [
    "Advances in Neural Information Processing Systems 36 (NeurIPS 2023)",
    "NeurIPS",
  ],
  [
    "Advances in Neural Information Processing Systems 30 (NIPS 2017)",
    "NeurIPS",
  ],
  ["2024 IEEE International Conference on Communications (ICC)", "ICC"],
  [
    "2025 IEEE/ACM International Conference on Software Engineering (ICSE)",
    "ICSE",
  ],
  ["ACM SIGMOD International Conference on Management of Data", "SIGMOD"],
  ["ACM Symposium on Theory of Computing", "STOC"],
  ["ACM International Conference on Multimedia", "ACM MM"],
  ["ACM Conference on Human Factors in Computing Systems", "CHI"],
  ["The Web Conference 2026", "WWW"],
  [
    "IEEE International Conference on Acoustics, Speech, and Signal Processing",
    "ICASSP",
  ],
  ["IEEE International Conference on Image Processing", "ICIP"],
  ["IEEE Global Communications Conference", "GLOBECOM"],
  ["IEEE Conference on Decision and Control", "CDC"],
  ["American Control Conference", "ACC"],
  ["IEEE International Conference on Robotics and Automation", "ICRA"],
  [
    "IEEE/RSJ International Conference on Intelligent Robots and Systems",
    "IROS",
  ],
  ["International Conference on Automated Planning and Scheduling", "ICAPS"],
  ["International Conference on Computer-Aided Design", "ICCAD"],
  ["Design, Automation & Test in Europe", "DATE"],
  ["Design Automation Conference", "DAC"],
  ["IEEE International Solid-State Circuits Conference", "ISSCC"],
  ["IEEE International Electron Devices Meeting", "IEDM"],
  ["IEEE Applied Power Electronics Conference and Exposition", "APEC"],
  ["IEEE Energy Conversion Congress and Exposition", "ECCE"],
  ["IEEE Power & Energy Society General Meeting", "PES GM"],
  [
    "IEEE International Conference on Intelligent Transportation Systems",
    "ITSC",
  ],
  [" IEEE\u00a0 International   Conference on Communications ", "ICC"],
  ["USENIX Workshop on Hot Topics in Operating Systems", "HotOS"],
  ["ACM Workshop on Hot Topics in Networks", "HotNets"],
])(
  "recognizes complete cross-domain and engineering venue %s",
  (venue, label) => {
    const display = conferenceVenue(venue);
    expect(display.label).toBe(label);
    expect(display.fullName).toBeTruthy();
  },
);

it.each([
  "FSE",
  "SEC",
  "ISWC",
  "FSE 2026",
  "Findings of the Association for Computational Linguistics: ACL 2024",
  "Proceedings of the ACM SIGSAC Conference on Computer and Communications Security Workshops",
  "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition Workshops",
  "International Conference on Machine Learning Applications",
  "International Conference on Communications and Computing",
  "NeurIPS Workshop",
  "ICML Workshop",
  "ICML Demo",
  "ICC Workshops",
  "ICASSP Workshops",
  "Pattern Recognition",
  "IEEE Transactions on Computers",
])("does not guess ambiguous, neighboring, or companion venue %s", (venue) => {
  expect(conferenceVenue(venue)).toEqual({ label: venue });
});

it("round-trips every canonical catalog name to its abbreviation and full tooltip", () => {
  for (const conference of conferences) {
    expect(conferenceVenue(conference.fullName)).toMatchObject({
      label: conference.abbreviation,
      fullName: conference.fullName,
    });
  }
});

it("keeps colliding abbreviations distinct when full names are available", () => {
  const software = conferenceVenue(
    "ACM International Conference on the Foundations of Software Engineering",
  );
  const crypto = conferenceVenue("Fast Software Encryption");
  expect(software.label).toBe("FSE");
  expect(crypto.label).toBe("FSE");
  expect(software.fullName).not.toBe(crypto.fullName);
});

it("prefers catalog spelling over an externally supplied abbreviation", () => {
  expect(conferenceVenue("NIPS", "Wrong")).toMatchObject({
    label: "NeurIPS",
    fullName: "Conference on Neural Information Processing Systems",
  });
});

it("uses an unknown venue's supplied short name only for display", () => {
  const venue = "International Conference on A Previously Unknown Discipline";
  expect(conferenceVenue(venue, "  ICAPUD ")).toEqual({
    label: "ICAPUD",
    fullName: venue,
  });
  expect(conferenceVenue(venue, " ")).toEqual({ label: venue });
  expect(conferenceVenue(venue)).toEqual({ label: venue });
});
