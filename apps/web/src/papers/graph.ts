import type { Document } from "@neoread/core";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { conferenceVenue } from "./conferences";
import { creatorName, paperCreators } from "./format";

export type PaperGraphRelation = "author" | "venue" | "manual";
export type PaperGraphFilters = Record<PaperGraphRelation, boolean>;
export type PaperGraphNode = {
  id: string;
  kind: "paper" | "author" | "venue";
  label: string;
  document?: Document;
};
export type PaperGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: PaperGraphRelation;
};
export type PaperGraphData = {
  nodes: PaperGraphNode[];
  edges: PaperGraphEdge[];
  adjacency: Map<string, Set<string>>;
};
export const allGraphRelations: PaperGraphFilters = {
  author: true,
  venue: true,
  manual: true,
};
export const graphText = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const paperId = (id: string) => `paper:${id}`;

/** Shared names are hubs, never a quadratic clique. The source documents remain untouched. */
export function buildPaperGraph(
  documents: Document[],
  filters: PaperGraphFilters = allGraphRelations,
): PaperGraphData {
  const active = new Map(
    documents
      .filter((doc) => doc.library === "papers" && !doc.deletedAt)
      .map((doc) => [doc.id, doc]),
  );
  const papers = [...active.values()].sort((a, b) => a.id.localeCompare(b.id));
  const nodes: PaperGraphNode[] = papers.map((document) => ({
    id: paperId(document.id),
    kind: "paper",
    label: document.title || "未命名论文",
    document,
  }));
  const edges: PaperGraphEdge[] = [];
  for (const kind of ["author", "venue"] as const) {
    if (!filters[kind]) continue;
    const groups = new Map<string, { label: string; papers: Set<string> }>();
    for (const doc of papers) {
      const venue =
        kind === "venue"
          ? conferenceVenue({ venue: doc.metadata.venue?.normalize("NFKC") })
          : null;
      const labels =
        kind === "author"
          ? paperCreators(doc).map(creatorName)
          : [venue!.fullName || venue!.label];
      for (const label of labels) {
        const key = graphText(label);
        if (!key) continue;
        const group = groups.get(key) ?? {
          label: label.normalize("NFKC").trim().replace(/\s+/g, " "),
          papers: new Set<string>(),
        };
        group.papers.add(paperId(doc.id));
        groups.set(key, group);
      }
    }
    for (const [key, group] of [...groups].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (group.papers.size < 2) continue;
      const id = `${kind}:${key}`;
      nodes.push({ id, kind, label: group.label });
      for (const source of group.papers)
        edges.push({
          id: JSON.stringify([kind, source, id]),
          source,
          target: id,
          kind,
        });
    }
  }
  if (filters.manual) {
    const seen = new Set<string>();
    for (const doc of papers)
      for (const related of doc.related) {
        if (related === doc.id || !active.has(related)) continue;
        const [source, target] = [paperId(doc.id), paperId(related)].sort();
        const id = JSON.stringify(["manual", source, target]);
        if (!seen.has(id)) edges.push({ id, source, target, kind: "manual" });
        seen.add(id);
      }
  }
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }
  return { nodes, edges, adjacency };
}

export type PaperSimulation = {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
  pin(id: string, x: number, y: number): void;
  release(id: string): void;
  tick(): boolean;
  dispose(): void;
};

type ForceNode = SimulationNodeDatum & {
  id: string;
  kind: PaperGraphNode["kind"];
  x: number;
  y: number;
};
type ForceLink = SimulationLinkDatum<ForceNode> & {
  kind: PaperGraphRelation;
};

/** A pre-settled, deterministic force graph with caller-owned animation scheduling.
 * D3 only mutates private clones; published point objects retain their identity. */
export function createPaperSimulation(graph: PaperGraphData): PaperSimulation {
  const nodes: ForceNode[] = graph.nodes
    .map(({ id, kind }) => ({ id, kind, x: NaN, y: NaN }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const links: ForceLink[] = [...graph.edges]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ source, target, kind }) => ({ source, target, kind }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const positions = new Map<string, { x: number; y: number }>();
  const gravityX = forceX<ForceNode>(0).strength(0.006);
  const gravityY = forceY<ForceNode>(0).strength(0.006);
  const simulation = forceSimulation(nodes)
    .stop()
    .alphaDecay(0.05)
    .velocityDecay(0.4)
    .force("charge", forceManyBody<ForceNode>().strength(-260))
    .force(
      "link",
      forceLink<ForceNode, ForceLink>(links)
        .id((node) => node.id)
        .distance((link) => (link.kind === "venue" ? 125 : 100))
        .strength(0.35),
    )
    .force(
      "collision",
      forceCollide<ForceNode>()
        .radius((node) => (node.kind === "paper" ? 27 : 20))
        .iterations(2),
    )
    .force("gravityX", gravityX)
    .force("gravityY", gravityY);

  simulation.tick(150);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  const padding = 180;
  const width = nodes.length ? Math.max(300, maxX - minX + padding * 2) : 300;
  const height = nodes.length ? Math.max(240, maxY - minY + padding * 2) : 240;
  for (const node of nodes) {
    node.x += padding - minX;
    node.y += padding - minY;
    node.vx = node.vy = 0;
    positions.set(node.id, { x: node.x, y: node.y });
  }
  // Keep gravity in the same world space as the fitted graph, including after dragging.
  gravityX.x(width / 2);
  gravityY.y(height / 2);
  simulation.alpha(0);

  return {
    positions,
    width,
    height,
    pin(id, x, y) {
      const node = nodeById.get(id);
      if (!node) return;
      node.x = node.fx = x;
      node.y = node.fy = y;
      node.vx = node.vy = 0;
      const point = positions.get(id)!;
      point.x = x;
      point.y = y;
      simulation.alpha(Math.max(simulation.alpha(), 0.35)).alphaTarget(0.12);
    },
    release(id) {
      const node = nodeById.get(id);
      if (!node) return;
      node.fx = node.fy = null;
      simulation.alphaTarget(0);
    },
    tick() {
      if (simulation.alpha() < simulation.alphaMin()) return false;
      simulation.tick();
      for (const node of nodes) {
        const point = positions.get(node.id)!;
        point.x = node.x;
        point.y = node.y;
      }
      return simulation.alpha() >= simulation.alphaMin();
    },
    dispose() {
      // Effect cleanup may be followed by StrictMode setup with this same instance.
      // Reset activity and pins, but retain the force graph for the next interaction.
      simulation.stop().alpha(0).alphaTarget(0);
      for (const node of nodes) {
        node.fx = node.fy = null;
        node.vx = node.vy = 0;
      }
    },
  };
}
