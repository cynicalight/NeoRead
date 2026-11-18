import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Document } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { Maximize, Minus, Plus, ExternalLink, Search, X } from "lucide-react";
import {
  allGraphRelations,
  buildPaperGraph,
  graphText,
  createPaperSimulation,
} from "./graph";
import type { PaperGraphNode, PaperGraphRelation } from "./graph";
import "./paper-graph.css";
import { reducedMotion, subscribeMotion } from "../motion";
import { displayTitleTranslation } from "../library";

function labelWidth(label: string) {
  let width = 0;
  for (const char of label) width += char.charCodeAt(0) > 255 ? 11 : 6;
  return width;
}

const labels: Record<PaperGraphRelation | "paper", string> = {
  paper: "论文",
  author: "作者",
  venue: "出处",
  manual: "手动关联",
};

export function PaperGraph({
  documents,
  selectedId,
  showBilingualTitles,
  onSelect,
  onOpen,
}: {
  documents: Document[];
  selectedId: string | null;
  showBilingualTitles: boolean;
  onSelect: (doc: Document) => void;
  onOpen: (doc: Document) => void;
}) {
  const [filters, setFilters] = useState(allGraphRelations);
  const [query, setQuery] = useState("");
  const [hub, setHub] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [exploring, setExploring] = useState(false);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const graph = useMemo(
    () => buildPaperGraph(documents, filters),
    [documents, filters],
  );
  // Background job/metadata refreshes must not reset a user's dragged layout.
  const topology = JSON.stringify([
    graph.nodes.map(({ id, kind }) => [id, kind]),
    graph.edges.map(({ id, source, target, kind }) => [
      id,
      source,
      target,
      kind,
    ]),
  ]);
  const layout = useMemo(() => createPaperSimulation(graph), [topology]);
  const byId = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph],
  );
  const translations = useMemo(() => {
    const result = new Map<string, string>();
    if (showBilingualTitles)
      for (const node of graph.nodes) {
        const title = node.document && displayTitleTranslation(node.document);
        if (title) result.set(node.id, title);
      }
    return result;
  }, [graph, showBilingualTitles]);
  const current =
    hub === ""
      ? null
      : hub && byId.has(hub)
        ? hub
        : selectedId
          ? `paper:${selectedId}`
          : null;
  const terms = graphText(query).split(" ").filter(Boolean);
  const matches = terms.length
    ? graph.nodes.filter((node) => {
        const title = graphText(node.label);
        const translation = graphText(
          node.document?.metadata.translatedTitle ?? "",
        );
        return terms.every(
          (term) => title.includes(term) || translation.includes(term),
        );
      })
    : [];
  const focusId = hovered ?? focused ?? current;
  const visibleLabels = useMemo(() => {
    // Reserve every star's hit area, then place labels by priority. Crowded
    // labels stay available through the node's name, hover and text view.
    const occupied = new Map<string, Set<string>>();
    const cells = (x: number, y: number, width: number, height: number) => {
      const keys: string[] = [];
      for (
        let row = Math.floor(y / 32);
        row <= Math.floor((y + height) / 32);
        row++
      )
        for (
          let col = Math.floor(x / 32);
          col <= Math.floor((x + width) / 32);
          col++
        )
          keys.push(`${col}:${row}`);
      return keys;
    };
    for (const node of graph.nodes) {
      const { x, y } = layout.positions.get(node.id)!;
      for (const key of cells(x - 10, y - 10, 20, 20)) {
        const owners = occupied.get(key) ?? new Set<string>();
        owners.add(node.id);
        occupied.set(key, owners);
      }
    }
    // Focus first, then papers before hubs, best-connected first; each label
    // tries the right of its dot, then the left.
    const placed = new Map<string, "right" | "left">();
    const rank = (node: PaperGraphNode) =>
      (node.id === focusId ? 1e6 : 0) +
      (node.kind === "paper" ? 1e5 : 0) +
      graph.adjacency.get(node.id)!.size;
    for (const node of [...graph.nodes].sort((a, b) => rank(b) - rank(a))) {
      const { x, y } = layout.positions.get(node.id)!;
      const translated = translations.get(node.id);
      const height = translated ? 40 : 30;
      const width = Math.min(
        180,
        28 + Math.max(labelWidth(node.label), labelWidth(translated ?? "")),
      );
      // Paper titles may pass over author and venue dots, whose own labels
      // then yield; they never cover another label or paper.
      const blocks = (owner: string) =>
        owner !== node.id &&
        (node.kind !== "paper" ||
          placed.has(owner) ||
          byId.get(owner)?.kind === "paper");
      const sides = [
        ["right", cells(x - 12, y - height / 2, width, height)],
        ["left", cells(x + 12 - width, y - height / 2, width, height)],
      ] as const;
      const side =
        node.id === focusId
          ? sides[0]
          : sides.find(([, keys]) =>
              keys.every((key) =>
                [...(occupied.get(key) ?? [])].every((owner) => !blocks(owner)),
              ),
            );
      if (!side) continue;
      placed.set(node.id, side[0]);
      for (const key of side[1]) {
        const owners = occupied.get(key) ?? new Set<string>();
        owners.add(node.id);
        occupied.set(key, owners);
      }
    }
    return placed;
  }, [graph, layout, focusId, layoutRevision, translations]);
  // Hop distance from the focused node: hubs are one hop, papers sharing a
  // hub are two. Edges flow outward along increasing distance.
  const distance = new Map<string, number>();
  if (focusId && byId.has(focusId)) {
    distance.set(focusId, 0);
    for (const neighbor of graph.adjacency.get(focusId)!) {
      distance.set(neighbor, 1);
      if (byId.get(neighbor)?.kind !== "paper")
        for (const paper of graph.adjacency.get(neighbor)!)
          if (!distance.has(paper)) distance.set(paper, 2);
    }
  }
  const highlighted = new Set<string>(distance.keys());
  if (terms.length) for (const match of matches) highlighted.add(match.id);
  const currentNode = current ? byId.get(current) : undefined;
  const related = new Map<string, Set<string>>();
  if (currentNode)
    for (const id of graph.adjacency.get(currentNode.id)!) {
      const node = byId.get(id)!;
      if (node.kind === "paper") {
        const descriptions = related.get(id) ?? new Set<string>();
        descriptions.add(
          currentNode.kind === "paper"
            ? labels.manual
            : labels[currentNode.kind],
        );
        related.set(id, descriptions);
      } else
        for (const paper of graph.adjacency.get(id)!) {
          if (paper === currentNode.id) continue;
          const descriptions = related.get(paper) ?? new Set<string>();
          descriptions.add(`${labels[node.kind]} · ${node.label}`);
          related.set(paper, descriptions);
        }
    }
  const viewport = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLDivElement>(null);
  const zoomOutput = useRef<HTMLOutputElement>(null);
  const view = useRef({ x: 0, y: 0, scale: 1, fit: 1 });
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    nodeId?: string;
    originX: number;
    originY: number;
    moved: boolean;
    capture: HTMLElement;
  } | null>(null);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const edges = useRef(new Map<string, SVGPathElement>());
  const flows = useRef(new Map<string, SVGPathElement>());
  const animation = useRef(0);
  const suppressClick = useRef<string | null>(null);
  const inputId = useId();
  const hintId = useId();
  function paint() {
    const { x, y, scale } = view.current;
    if (scene.current)
      scene.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    if (zoomOutput.current)
      zoomOutput.current.textContent = `${Math.round((scale / view.current.fit) * 100)}%`;
  }
  function paintGraph() {
    for (const [id, point] of layout.positions) {
      const element = nodes.current.get(id);
      if (element) {
        element.style.left = `${point.x}px`;
        element.style.top = `${point.y}px`;
      }
    }
    for (const edge of graph.edges) {
      const a = layout.positions.get(edge.source)!,
        b = layout.positions.get(edge.target)!;
      const d = `M${a.x},${a.y} L${b.x},${b.y}`;
      edges.current.get(edge.id)?.setAttribute("d", d);
      flows.current.get(edge.id)?.setAttribute("d", d);
    }
  }
  function animateLayout() {
    if (animation.current) return;
    if (reducedMotion()) {
      for (let i = 0; i < 160 && layout.tick(); i++) {}
      paintGraph();
      setLayoutRevision((value) => value + 1);
      return;
    }
    const step = () => {
      const active = layout.tick();
      paintGraph();
      if (active) animation.current = requestAnimationFrame(step);
      else {
        animation.current = 0;
        setLayoutRevision((value) => value + 1);
      }
    };
    animation.current = requestAnimationFrame(step);
  }
  function finishDrag() {
    const previous = drag.current;
    if (!previous) return;
    drag.current = null;
    previous.capture.removeAttribute("data-dragging");
    viewport.current?.removeAttribute("data-panning");
    if (previous.capture.hasPointerCapture?.(previous.id))
      previous.capture.releasePointerCapture(previous.id);
    if (previous.nodeId && previous.moved) {
      suppressClick.current = previous.nodeId;
      layout.release(previous.nodeId);
      animateLayout();
    }
  }
  function reset() {
    const element = viewport.current;
    if (!element) return;
    let minX = 0,
      minY = 0,
      maxX = layout.width,
      maxY = layout.height;
    if (layout.positions.size) {
      minX = Infinity;
      minY = Infinity;
      maxX = -Infinity;
      maxY = -Infinity;
      for (const { x, y } of layout.positions.values()) {
        minX = Math.min(minX, x - 40);
        minY = Math.min(minY, y - 40);
        maxX = Math.max(maxX, x + 180);
        maxY = Math.max(maxY, y + 40);
      }
    }
    const width = maxX - minX,
      height = maxY - minY;
    const fit = Math.max(
      0.001,
      Math.min(element.clientWidth / width, element.clientHeight / height, 1),
    );
    view.current = {
      x: (element.clientWidth - width * fit) / 2 - minX * fit,
      y: (element.clientHeight - height * fit) / 2 - minY * fit,
      scale: fit,
      fit,
    };
    paint();
  }
  function zoom(factor: number, x?: number, y?: number) {
    const element = viewport.current;
    if (!element) return;
    const v = view.current;
    const next = Math.min(v.fit * 8, Math.max(v.fit * 0.35, v.scale * factor));
    const ratio = next / v.scale;
    const cx = x ?? element.clientWidth / 2,
      cy = y ?? element.clientHeight / 2;
    v.x = cx - (cx - v.x) * ratio;
    v.y = cy - (cy - v.y) * ratio;
    v.scale = next;
    paint();
  }
  useEffect(() => {
    reset();
    const element = viewport.current;
    if (!element) return;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => reset());
    observer?.observe(element);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoom(
        Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.003),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    const unsubscribe = subscribeMotion(() => {
      if (!reducedMotion()) return;
      cancelAnimationFrame(animation.current);
      animation.current = 0;
      animateLayout();
    });
    return () => {
      observer?.disconnect();
      element.removeEventListener("wheel", wheel);
      unsubscribe();
      cancelAnimationFrame(animation.current);
      animation.current = 0;
      layout.dispose();
      drag.current = null;
    };
  }, [layout]); // Only graph/layout changes reset the viewport; selection does not.
  function choose(node: PaperGraphNode) {
    setHub(node.kind === "paper" ? null : node.id);
    if (node.document) onSelect(node.document);
  }
  function center(node: PaperGraphNode) {
    const point = layout.positions.get(node.id)!;
    const element = viewport.current;
    if (!element) return;
    view.current.x = element.clientWidth / 2 - point.x * view.current.scale;
    view.current.y = element.clientHeight / 2 - point.y * view.current.scale;
    paint();
    choose(node);
  }
  // Scale each kind independently; square root keeps small differences visible.
  const maxDegree = { paper: 1, author: 1, venue: 1 };
  for (const node of graph.nodes)
    maxDegree[node.kind] = Math.max(
      maxDegree[node.kind],
      graph.adjacency.get(node.id)!.size,
    );
  const nodeSize = (node: PaperGraphNode) => {
    const strength = Math.sqrt(
      graph.adjacency.get(node.id)!.size / maxDegree[node.kind],
    );
    return node.kind === "paper" ? 7 + strength * 11 : 6 + strength * 7;
  };
  const list = terms.length
    ? matches
    : currentNode
      ? [...related.keys()].map((id) => byId.get(id)!)
      : graph.nodes.filter((node) => node.kind === "paper");
  return (
    <div
      className="paper-graph"
      data-exploring={exploring || !!currentNode || undefined}
    >
      <div className="paper-graph-toolbar">
        <div className="paper-graph-zoom">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="搜索图谱"
            aria-expanded={exploring || !!currentNode}
            onClick={() => {
              if (exploring || currentNode) {
                setExploring(false);
                setHub("");
              } else setExploring(true);
            }}
          >
            <Search aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="缩小图谱"
            onClick={() => zoom(1 / 1.25)}
          >
            <Minus aria-hidden="true" />
          </Button>
          <output ref={zoomOutput} aria-label="图谱缩放">
            100%
          </output>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="放大图谱"
            onClick={() => zoom(1.25)}
          >
            <Plus aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="复位图谱"
            onClick={reset}
          >
            <Maximize aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="paper-graph-body">
        <div
          className="paper-graph-viewport"
          ref={viewport}
          aria-describedby={hintId}
          onPointerDown={(event) => {
            if (
              event.button !== 0 ||
              drag.current ||
              (event.target as Element).closest("button")
            )
              return;
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              startX: event.clientX,
              startY: event.clientY,
              originX: 0,
              originY: 0,
              moved: false,
              capture: event.currentTarget,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.setAttribute("data-panning", "");
          }}
          onPointerMove={(event) => {
            const previous = drag.current;
            if (!previous || previous.id !== event.pointerId) return;
            const dx = event.clientX - previous.startX,
              dy = event.clientY - previous.startY;
            if (!previous.moved && Math.hypot(dx, dy) < 4) return;
            previous.moved = true;
            if (previous.nodeId) {
              previous.capture.setAttribute("data-dragging", "");
              layout.pin(
                previous.nodeId,
                previous.originX + dx / view.current.scale,
                previous.originY + dy / view.current.scale,
              );
              paintGraph();
              animateLayout();
            } else {
              view.current.x += event.clientX - previous.x;
              view.current.y += event.clientY - previous.y;
              paint();
            }
            previous.x = event.clientX;
            previous.y = event.clientY;
          }}
          onPointerUp={(event) => {
            if (drag.current?.id === event.pointerId) finishDrag();
          }}
          onPointerCancel={(event) => {
            if (drag.current?.id === event.pointerId) finishDrag();
          }}
          onLostPointerCapture={(event) => {
            if (drag.current?.id === event.pointerId) finishDrag();
          }}
        >
          <div
            ref={scene}
            className="paper-graph-scene"
            style={{ width: layout.width, height: layout.height }}
          >
            <svg
              className="paper-graph-edges"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              {graph.edges.map((edge) => {
                const a = layout.positions.get(edge.source)!,
                  b = layout.positions.get(edge.target)!;
                const active =
                  !highlighted.size ||
                  (highlighted.has(edge.source) &&
                    highlighted.has(edge.target));
                const near =
                  distance.has(edge.source) && distance.has(edge.target);
                const line = `M${a.x},${a.y} L${b.x},${b.y}`;
                return (
                  <Fragment key={edge.id}>
                    <path
                      className="paper-graph-edge"
                      ref={(element) => {
                        if (element) edges.current.set(edge.id, element);
                        else edges.current.delete(edge.id);
                      }}
                      data-kind={edge.kind}
                      data-dim={!active || undefined}
                      data-active={near || undefined}
                      d={line}
                    />
                    {near && (
                      <path
                        className="paper-graph-flow"
                        ref={(element) => {
                          if (element) flows.current.set(edge.id, element);
                          else flows.current.delete(edge.id);
                        }}
                        data-kind={edge.kind}
                        data-reverse={
                          distance.get(edge.target)! <
                            distance.get(edge.source)! || undefined
                        }
                        d={line}
                      />
                    )}
                  </Fragment>
                );
              })}
            </svg>
            {graph.nodes.map((node) => {
              const point = layout.positions.get(node.id)!;
              const translated = translations.get(node.id);
              return (
                <Button
                  key={node.id}
                  ref={(element) => {
                    if (element) nodes.current.set(node.id, element);
                    else nodes.current.delete(node.id);
                  }}
                  variant="ghost"
                  className="paper-graph-node"
                  data-kind={node.kind}
                  data-selected={current === node.id || undefined}
                  data-dim={
                    (highlighted.size > 0 && !highlighted.has(node.id)) ||
                    undefined
                  }
                  style={
                    {
                      left: point.x,
                      top: point.y,
                      "--node-size": `${nodeSize(node)}px`,
                    } as CSSProperties
                  }
                  title={translated ? `${node.label}\n${translated}` : node.label}
                  aria-label={`${labels[node.kind]}：${node.label}${translated ? `，译名：${translated}` : ""}`}
                  data-bilingual={!!translated || undefined}
                  aria-pressed={current === node.id}
                  data-labelled={visibleLabels.get(node.id)}
                  data-focus={focusId === node.id || undefined}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setFocused(node.id)}
                  onBlur={() => setFocused(null)}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || drag.current) return;
                    event.stopPropagation();
                    suppressClick.current = null;
                    const point = layout.positions.get(node.id)!;
                    drag.current = {
                      id: event.pointerId,
                      nodeId: node.id,
                      x: event.clientX,
                      y: event.clientY,
                      startX: event.clientX,
                      startY: event.clientY,
                      originX: point.x,
                      originY: point.y,
                      moved: false,
                      capture: event.currentTarget,
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onClick={() => {
                    if (suppressClick.current === node.id) {
                      suppressClick.current = null;
                      return;
                    }
                    choose(node);
                  }}
                  onKeyDown={(event) => {
                    const delta = {
                      ArrowLeft: [-1, 0],
                      ArrowRight: [1, 0],
                      ArrowUp: [0, -1],
                      ArrowDown: [0, 1],
                    }[event.key];
                    if (!delta) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const point = layout.positions.get(node.id)!;
                    const step =
                      (event.shiftKey ? 80 : 20) / view.current.scale;
                    layout.pin(
                      node.id,
                      point.x + delta[0] * step,
                      point.y + delta[1] * step,
                    );
                    paintGraph();
                    layout.release(node.id);
                    animateLayout();
                  }}
                  onDoubleClick={() => {
                    if (node.document) onOpen(node.document);
                  }}
                >
                  <span className="paper-graph-dot" aria-hidden="true" />
                  <span className="paper-graph-node-label">
                    <span className="truncate">{node.label}</span>
                    {translated && (
                      <span className="paper-graph-node-translation truncate">
                        {translated}
                      </span>
                    )}
                  </span>
                </Button>
              );
            })}
          </div>
          {!graph.nodes.length && (
            <p className="paper-graph-empty">当前筛选中没有论文</p>
          )}
        </div>
        <aside className="paper-graph-inspector" aria-label="图谱文字视图">
          <label htmlFor={inputId}>搜索图谱</label>
          <Input
            id={inputId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="论文、作者或出处"
          />
          {currentNode && (
            <div className="paper-graph-current">
              <span>
                {labels[currentNode.kind]} · {currentNode.label}
                {translations.has(currentNode.id) && (
                  <span className="paper-graph-inspector-translation">
                    {translations.get(currentNode.id)}
                  </span>
                )}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="清除图谱聚焦"
                onClick={() => {
                  setHub("");
                  setQuery("");
                  setFocused(null);
                  setHovered(null);
                  setExploring(false);
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          )}
          <h3>
            {terms.length ? "搜索结果" : currentNode ? "相关论文" : "全部论文"}{" "}
            <span>{list.length}</span>
          </h3>
          <ul className="paper-graph-results" role="list">
            {list.map((node) => (
              <li key={node.id}>
                <Button
                  variant="ghost"
                  className="paper-graph-result"
                  onClick={() => center(node)}
                  onFocus={() => setFocused(node.id)}
                  onBlur={() => setFocused(null)}
                  aria-pressed={current === node.id}
                >
                  <span>{node.label}</span>
                  {translations.has(node.id) && (
                    <span className="paper-graph-inspector-translation">
                      {translations.get(node.id)}
                    </span>
                  )}
                  <small>
                    {related.has(node.id) && !terms.length
                      ? [...related.get(node.id)!].join("；")
                      : labels[node.kind]}
                  </small>
                </Button>
                {node.document && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`打开论文：${node.label}`}
                    onClick={() => onOpen(node.document!)}
                  >
                    <ExternalLink aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {!list.length && (
            <p className="paper-graph-no-results">
              {terms.length
                ? "未找到匹配节点"
                : currentNode
                  ? "没有当前已启用类型的关联"
                  : "暂无论文"}
            </p>
          )}
          {currentNode?.document && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpen(currentNode.document!)}
            >
              打开选中论文
            </Button>
          )}
        </aside>
      </div>
      <div className="paper-graph-caption">
        <span id={hintId}>
          {graph.nodes.filter((node) => node.kind === "paper").length} 篇论文 ·{" "}
          {graph.edges.length} 条关系
          <span className="sr-only">
            。拖动节点调整关系，拖动空白平移，滚轮缩放，方向键移动聚焦节点
          </span>
        </span>
        <span className="paper-graph-legend">
          <span
            className="paper-graph-legend-mark"
            data-kind="paper"
            aria-hidden="true"
          />
          论文 · 关联越多越大
        </span>
        <div
          className="paper-graph-legend-toggles"
          role="group"
          aria-label="图谱关系类型"
        >
          {(["author", "venue", "manual"] as const).map((kind) => (
            <Button
              key={kind}
              data-kind={kind}
              variant="ghost"
              size="xs"
              className="paper-graph-legend-toggle"
              aria-pressed={filters[kind]}
              title={`${filters[kind] ? "隐藏" : "显示"}${labels[kind]}关系`}
              onClick={() =>
                setFilters((previous) => ({
                  ...previous,
                  [kind]: !previous[kind],
                }))
              }
            >
              <span
                className="paper-graph-legend-mark"
                data-kind={kind}
                aria-hidden="true"
              />
              {labels[kind]}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default PaperGraph;
