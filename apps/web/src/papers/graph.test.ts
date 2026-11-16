import { describe, expect, it } from "vitest";
import {
  allGraphRelations,
  buildPaperGraph,
  createPaperSimulation,
} from "./graph";
import { paper } from "./fixtures";

describe("paper graph", () => {
  it("deduplicates bidirectional, duplicate and self links and excludes ids outside the active set", () => {
    const a = paper({
      id: "a",
      related: ["a", "b", "b", "outside", "trash", "book"],
    });
    const b = paper({ id: "b", related: ["a"] });
    const before = JSON.stringify([a, b]);
    const graph = buildPaperGraph([
      a,
      b,
      paper({ id: "trash", deletedAt: "2026-01-01" }),
      paper({ id: "book", library: "books" }),
    ]);
    expect(graph.edges).toEqual([
      expect.objectContaining({
        source: "paper:a",
        target: "paper:b",
        kind: "manual",
      }),
    ]);
    expect(graph.nodes).toHaveLength(2);
    expect(JSON.stringify([a, b])).toBe(before);
  });

  it("matches whole author names with Unicode, whitespace and case normalization, not initials or surnames", () => {
    const graph = buildPaperGraph([
      paper({
        id: "a",
        metadata: {
          creators: [
            { given: "Ada", family: "Lovelace" },
            { name: "Ada Lovelace" },
          ],
        },
      }),
      paper({ id: "b", author: " ＡＤＡ   LOVELACE " }),
      paper({ id: "c", author: "A. Lovelace" }),
      paper({ id: "d", author: "Lovelace" }),
    ]);
    expect(graph.nodes.filter((node) => node.kind === "author")).toEqual([
      expect.objectContaining({ id: "author:ada lovelace" }),
    ]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.adjacency.get("author:ada lovelace")).toEqual(
      new Set(["paper:a", "paper:b"]),
    );
    expect(graph.adjacency.get("paper:c")?.size).toBe(0);
  });

  it("canonicalizes known conference names and aliases without treating workshops or display edits as equivalence", () => {
    const graph = buildPaperGraph([
      paper({
        id: "a",
        metadata: {
          venue: "International Conference on Machine Learning",
          venueShort: "Custom",
          sources: { venueShort: "manual" },
        },
      }),
      paper({ id: "b", metadata: { venue: "ICML" } }),
      paper({
        id: "c",
        metadata: {
          venue: "International Conference on Machine Learning Workshops",
        },
      }),
      paper({
        id: "d",
        metadata: { venue: "Different Venue", venueShort: "ICML" },
      }),
    ]);
    const hubs = graph.nodes.filter((node) => node.kind === "venue");
    expect(hubs).toHaveLength(1);
    expect(graph.adjacency.get(hubs[0].id)).toEqual(
      new Set(["paper:a", "paper:b"]),
    );
    expect(graph.edges).toHaveLength(2);
  });

  it("uses exact normalized names for unknown venues, never fuzzy matching", () => {
    const graph = buildPaperGraph([
      paper({ id: "a", metadata: { venue: "  Example   Journal " } }),
      paper({ id: "b", metadata: { venue: "EXAMPLE JOURNAL" } }),
      paper({ id: "c", metadata: { venue: "Example Journals" } }),
    ]);
    expect(graph.nodes.filter((node) => node.kind === "venue")).toHaveLength(1);
    expect(graph.edges).toHaveLength(2);
  });

  it("toggles relation projections independently without mutating manual relationship data", () => {
    const docs = [
      paper({
        id: "a",
        author: "Ada",
        metadata: { venue: "ICML" },
        related: ["b", "outside"],
      }),
      paper({
        id: "b",
        author: "Ada",
        metadata: { venue: "ICML" },
        related: ["a"],
      }),
    ];
    const before = JSON.stringify(docs);
    expect(
      buildPaperGraph(docs, {
        author: false,
        venue: false,
        manual: true,
      }).edges.map((edge) => edge.kind),
    ).toEqual(["manual"]);
    expect(
      buildPaperGraph(docs, { ...allGraphRelations, manual: false }).edges.map(
        (edge) => edge.kind,
      ),
    ).toEqual(["author", "author", "venue", "venue"]);
    expect(
      buildPaperGraph(docs, { author: false, venue: false, manual: false })
        .nodes,
    ).toHaveLength(2);
    expect(JSON.stringify(docs)).toBe(before);
    expect(buildPaperGraph(docs).edges).toHaveLength(5);
  });

  it("keeps isolated papers and builds shared hubs with linear edge counts", () => {
    const docs = Array.from({ length: 1000 }, (_, i) =>
      paper({
        id: String(i),
        author: "Shared Author",
        metadata: { venue: "ICML" },
      }),
    );
    const graph = buildPaperGraph([...docs, paper({ id: "isolated" })]);
    expect(graph.nodes).toHaveLength(1003);
    expect(graph.edges).toHaveLength(2000);
    expect(graph.adjacency.get("paper:isolated")?.size).toBe(0);
  });

  it("pre-settles deterministic positions without mutating graphs or source documents", () => {
    const docs = [
      paper({ id: "a", author: "Ada", related: ["b"] }),
      paper({ id: "b", author: "Ada" }),
      paper({ id: "c" }),
    ];
    const graph = buildPaperGraph(docs);
    const snapshot = () => ({
      nodes: graph.nodes,
      edges: graph.edges,
      adjacency: [...graph.adjacency].map(([id, neighbors]) => [
        id,
        [...neighbors],
      ]),
      documents: docs,
    });
    const before = JSON.stringify(snapshot());
    graph.nodes.forEach(Object.freeze);
    graph.edges.forEach(Object.freeze);
    Object.freeze(graph.nodes);
    Object.freeze(graph.edges);
    const a = createPaperSimulation(graph);
    const b = createPaperSimulation({
      ...graph,
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    });
    expect(a.positions).toEqual(b.positions);
    expect([a.width, a.height]).toEqual([b.width, b.height]);
    expect(a.positions.size).toBe(4);
    expect(a.tick()).toBe(false);
    expect(JSON.stringify(snapshot())).toBe(before);
    for (const point of a.positions.values()) {
      expect(point.x).toBeGreaterThanOrEqual(180 - 1e-8);
      expect(point.x).toBeLessThanOrEqual(a.width - 180 + 1e-8);
      expect(point.y).toBeGreaterThanOrEqual(180 - 1e-8);
      expect(point.y).toBeLessThanOrEqual(a.height - 180 + 1e-8);
    }
    expect(
      new Set([...a.positions.values()].map(({ x, y }) => `${x},${y}`)).size,
    ).toBe(4);
    a.pin("paper:a", 700, 400);
    for (let i = 0; i < 20; i++) a.tick();
    a.release("paper:a");
    expect(JSON.stringify(snapshot())).toBe(before);
    a.dispose();
    b.dispose();
  });

  it("pins in world coordinates immediately and pulls neighboring nodes through stable point objects", () => {
    const simulation = createPaperSimulation(
      buildPaperGraph([
        paper({ id: "a", related: ["b"] }),
        paper({ id: "b" }),
        paper({ id: "isolated" }),
      ]),
    );
    const pinned = simulation.positions.get("paper:a")!;
    const neighbor = simulation.positions.get("paper:b")!;
    const before = { ...neighbor };
    const target = { x: pinned.x + 300, y: pinned.y + 120 };
    simulation.pin("paper:a", target.x, target.y);
    expect(pinned).toEqual(target);
    for (let i = 0; i < 40; i++) {
      expect(simulation.tick()).toBe(true);
      expect(pinned).toEqual(target);
    }
    expect(simulation.positions.get("paper:a")).toBe(pinned);
    expect(simulation.positions.get("paper:b")).toBe(neighbor);
    expect(
      (neighbor.x - before.x) * 300 + (neighbor.y - before.y) * 120,
    ).toBeGreaterThan(0);
    expect(
      Math.hypot(neighbor.x - before.x, neighbor.y - before.y),
    ).toBeGreaterThan(20);
    expect(simulation.positions.has("paper:isolated")).toBe(true);
    simulation.dispose();
  });

  it("releases pinned nodes and cools to a stationary layout", () => {
    const simulation = createPaperSimulation(
      buildPaperGraph([paper({ id: "a", related: ["b"] }), paper({ id: "b" })]),
    );
    const point = simulation.positions.get("paper:a")!;
    const target = { x: point.x + 350, y: point.y + 180 };
    simulation.pin("paper:a", target.x, target.y);
    for (let i = 0; i < 10; i++) simulation.tick();
    simulation.release("paper:a");
    let active = true;
    let ticks = 0;
    while (active && ticks < 300) {
      active = simulation.tick();
      ticks++;
    }
    expect(active).toBe(false);
    expect(ticks).toBeGreaterThan(1);
    expect(point).not.toEqual(target);
    const settled = [...simulation.positions.values()].map((position) => ({
      ...position,
    }));
    for (let i = 0; i < 10; i++) expect(simulation.tick()).toBe(false);
    expect([...simulation.positions.values()]).toEqual(settled);
    simulation.dispose();
  });

  it("disposes idempotently, releases pins and allows interaction after effect setup reuses it", () => {
    const simulation = createPaperSimulation(
      buildPaperGraph([paper({ id: "a", related: ["b"] }), paper({ id: "b" })]),
    );
    simulation.pin("paper:a", 500, 600);
    const point = simulation.positions.get("paper:a")!;
    simulation.dispose();
    simulation.dispose();
    for (let i = 0; i < 10; i++) expect(simulation.tick()).toBe(false);
    expect(point).toEqual({ x: 500, y: 600 });
    simulation.pin("paper:a", 100, 200);
    expect(simulation.positions.get("paper:a")).toBe(point);
    expect(point).toEqual({ x: 100, y: 200 });
    expect(simulation.tick()).toBe(true);
    expect(point).toEqual({ x: 100, y: 200 });
    simulation.dispose();
    // Reheat through a different node; the old node must no longer be pinned.
    expect(simulation.tick()).toBe(false);
    expect(point).toEqual({ x: 100, y: 200 });
    simulation.pin("paper:b", 600, 700);
    for (let i = 0; i < 10; i++) simulation.tick();
    expect(point).not.toEqual({ x: 100, y: 200 });
    simulation.dispose();
  });

  it("handles empty graphs and unknown node interactions", () => {
    const simulation = createPaperSimulation(buildPaperGraph([]));
    expect(simulation.positions.size).toBe(0);
    expect(simulation.width).toBe(300);
    expect(simulation.height).toBe(240);
    simulation.pin("missing", 10, 20);
    simulation.release("missing");
    expect(simulation.tick()).toBe(false);
    simulation.dispose();
  });

  it("keeps finite coordinates for long chains and large shared hubs", () => {
    const docs = Array.from({ length: 2000 }, (_, i) =>
      paper({
        id: String(i),
        related: i ? [String(i - 1)] : [],
        author: "Shared Author",
      }),
    );
    const simulation = createPaperSimulation(
      buildPaperGraph([...docs, paper({ id: "isolated" })]),
    );
    expect(simulation.positions.size).toBe(2002);
    expect(Number.isFinite(simulation.width)).toBe(true);
    expect(Number.isFinite(simulation.height)).toBe(true);
    for (const point of simulation.positions.values()) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
    simulation.dispose();
  });
});
