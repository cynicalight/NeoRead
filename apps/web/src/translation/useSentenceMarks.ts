import {
  clearFormulaMarks,
  formulaAwareRects,
  formulaHighlightRules,
  markFormulas,
} from "./formula-highlight";
import { annotationsAtPoint, annotationsInRects } from "./annotation-hover";
import { SentenceHover } from "./sentence-hover";
import { useEffect, useId, useRef } from "react";
import type { RefObject } from "react";
import type {
  Annotation,
  PDFBlock,
  EPUBReadingBlock,
  ReaderAdapter,
  ReaderEvents,
  ReaderAnnotationTarget,
  SearchResult,
  TranslationBlock,
} from "@neoread/core";
import { translatedAnnotationRanges } from "./annotations";
import { sourcePassage, translatedSentenceRanges } from "./sentence-links";
import { blockRange, resolveEPUBLocation } from "../readers/epub-web-location";
import { epubSentenceSlice } from "./epub-links";
import { searchRanges } from "./search-ranges";
import { overlap } from "../readers/pdf-reading";
import {
  hasReflowSource,
  reflowQuoteRanges,
  reflowSourceRanges,
  reflowMarkRanges,
  segmentSentences,
} from "./reflow";

type Mark = { annotation: Annotation; range: Range };
const hit = (range: Range, x: number, y: number) =>
  Array.from(range.getClientRects()).some(
    (r) =>
      r.width &&
      r.height &&
      x >= r.left &&
      x <= r.right &&
      y >= r.top &&
      y <= r.bottom,
  );

/** Saved marks stay on their origin side; hover may still link sentences. */
export function useSentenceMarks(
  root: RefObject<HTMLDivElement | null>,
  engine: ReaderAdapter | undefined,
  blocks: (PDFBlock | EPUBReadingBlock)[],
  translations: TranslationBlock[],
  annotations: Annotation[],
  linked: boolean,
  mode: string,
  events: ReaderEvents,
  searchQuery = "",
  searchResults: SearchResult[] = [],
) {
  const prefix = `neoread-sentences-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const latest = useRef({
    blocks,
    translations,
    annotations,
    events,
    searchQuery,
    searchResults,
  });
  latest.current = {
    blocks,
    translations,
    annotations,
    events,
    searchQuery,
    searchResults,
  };
  const repaint = useRef<(() => void) | undefined>(undefined);
  const pointer = useRef<{ target: Element; x: number; y: number } | undefined>(
    undefined,
  );
  useEffect(() => {
    const host = root.current;
    if (!host || !engine || typeof Highlight === "undefined" || !CSS.highlights)
      return;
    const registry = CSS.highlights;
    const style = document.createElement("style");
    document.head.append(style);
    let marks: Mark[] = [],
      names: string[] = [],
      frame = 0;
    const searchName = `${prefix}-search`;
    const cache = new Map<string, Range[]>();
    let geometry = new WeakMap<Range, DOMRect[]>();
    const rectsOf = (range: Range) => {
      let rects = geometry.get(range);
      if (!rects) {
        rects = formulaAwareRects([range]);
        geometry.set(range, rects);
      }
      return rects;
    };
    const containsPoint = (range: Range, x: number, y: number) => {
      const rects = rectsOf(range);
      return rects.some(
        (r) =>
          r.width &&
          r.height &&
          x >= r.left &&
          x <= r.right &&
          y >= r.top &&
          y <= r.bottom,
      );
    };
    const sourceRanges = (t: TranslationBlock, i: number) => {
      const key = `${t.blockId}:${i}`;
      if (!cache.has(key)) {
        const block = latest.current.blocks.find((b) => b.id === t.blockId);
        // Reflowed PDF text renders each source sentence as its own element.
        if (hasReflowSource(host, t.blockId)) {
          cache.set(key, reflowSourceRanges(host, t.blockId, i));
        } else if (block && "location" in block) {
          const slice = epubSentenceSlice(block, t.sentences, [i]);
          // A failed alignment must not highlight the entire paragraph.
          const range = slice
            ? blockRange(host, {
                block,
                start: slice.start,
                end: slice.end,
              })
            : undefined;
          cache.set(key, range ? [range] : []);
        } else {
          cache.set(key, engine.sentenceRanges?.([sourcePassage(t, i)]) ?? []);
        }
      }
      return cache.get(key)!;
    };
    const hover = new SentenceHover(host);
    let enterTimer: ReturnType<typeof setTimeout> | undefined;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    let anchor: { x: number; y: number } | undefined;
    let activeRanges: Range[] = [];
    let activeAnnotationTarget: ReaderAnnotationTarget | null = null;
    // Marks in the active sentence and its hover, so moving within the
    // sentence can switch between the note card and the sentence highlight.
    let activeMarked: Annotation[] = [];
    let activeHover: { key: string; ranges: Range[] } | undefined;
    const cancelEnter = () => {
      clearTimeout(enterTimer);
      enterTimer = undefined;
      anchor = undefined;
    };
    const cancelLeave = () => {
      clearTimeout(leaveTimer);
      leaveTimer = undefined;
    };
    const deferClear = () => {
      if (leaveTimer !== undefined || !activeRanges.length) return;
      leaveTimer = setTimeout(() => {
        leaveTimer = undefined;
        activeRanges = [];
        activeAnnotationTarget = null;
        activeMarked = [];
        activeHover = undefined;
        hover.clear();
      }, 500);
    };
    const clearHover = () => {
      latest.current.events.annotationHover?.(null);
      pointer.current = undefined;
      cancelEnter();
      deferClear();
    };
    const interruptHover = () => {
      latest.current.events.annotationHover?.(null);
      geometry = new WeakMap();
      pointer.current = undefined;
      cancelEnter();
      cancelLeave();
      activeRanges = [];
      activeAnnotationTarget = null;
      activeMarked = [];
      activeHover = undefined;
      hover.clear(true);
    };
    const targetCache = new Map<string, Range[]>();
    const targetRanges = (blockId: string, index: number) => {
      const key = `${blockId}:${index}`;
      if (!targetCache.has(key))
        targetCache.set(key, translatedSentenceRanges(host, blockId, index));
      return targetCache.get(key)!;
    };
    const paint = () => {
      frame = 0;
      cache.clear();
      geometry = new WeakMap();
      targetCache.clear();
      hover.invalidate();
      const { annotations, translations, blocks, searchQuery, searchResults } =
        latest.current;
      names.forEach((name) => registry.delete(name));
      registry.delete(searchName);
      clearFormulaMarks(host, prefix);
      names = [];
      marks = translatedAnnotationRanges(host, annotations, translations);
      for (const annotation of annotations) {
        if (
          annotation.location.type === "epub" &&
          !annotation.location.translation &&
          annotation.kind !== "bookmark"
        ) {
          const epubBlocks = blocks.filter(
            (b): b is EPUBReadingBlock => "location" in b,
          );
          for (const slice of resolveEPUBLocation(
            {
              ...annotation.location,
              quote: annotation.location.quote || annotation.quote,
            },
            epubBlocks,
          )) {
            const range = blockRange(host, slice);
            if (range) marks.push({ annotation, range });
          }
        }
        if (
          annotation.location.type !== "pdf" ||
          annotation.location.translation ||
          annotation.kind === "bookmark"
        )
          continue;
        const passages = annotation.location.sourceAnchors?.flatMap(
          (anchor) => {
            const normalize = (text: string) =>
              text.replace(/\s/g, "").toLowerCase();
            const candidates = blocks.filter(
              (block) =>
                "page" in block &&
                block.page === anchor.page &&
                normalize(block.text).includes(normalize(anchor.source)),
            );
            const block =
              candidates.find((block) => block.id === anchor.blockId) ??
              (candidates.length === 1 ? candidates[0] : undefined);
            return block
              ? [{ blockId: block.id, sources: [anchor.source] }]
              : [];
          },
        );
        // Reflowed text has no PDF text layer; find the saved quote in it.
        const reflowed = (passages ?? []).filter((p) =>
          hasReflowSource(host, p.blockId),
        );
        for (const passage of reflowed)
          for (const source of passage.sources)
            marks.push(
              ...reflowQuoteRanges(host, passage.blockId, source).map(
                (range) => ({ annotation, range }),
              ),
            );
        // Ordinary source marks live in the PDF text layer; reflowed text
        // finds their quote in the paragraphs under the saved rectangles.
        // A text-layer quote is found across the paragraphs it covers.
        const location = annotation.location;
        if (!passages?.length && location.quote?.trim()) {
          const covered = blocks.flatMap((block) =>
            "page" in block &&
            block.page === location.page &&
            hasReflowSource(host, block.id) &&
            (!location.rects?.length ||
              location.rects.some((r) => overlap(r, block.bounds) > 0))
              ? [block.id]
              : [],
          );
          marks.push(
            ...reflowMarkRanges(host, covered, location.quote).map((range) => ({
              annotation,
              range,
            })),
          );
        }
        if (passages?.length && !reflowed.length)
          marks.push(
            ...(engine.sentenceRanges?.(passages) ?? []).map((range) => ({
              annotation,
              range,
            })),
          );
      }
      const groups = new Map<string, Range[]>();
      const rules: string[] = [];
      for (const mark of marks) {
        // The EPUB adapter already paints saved source annotations.
        if (
          mark.annotation.location.type === "epub" &&
          !mark.annotation.location.translation
        )
          continue;
        const color = /^#[\da-f]{6}$/i.test(mark.annotation.color)
          ? mark.annotation.color.toLowerCase()
          : "#e6b94c";
        const kind =
          mark.annotation.kind === "underline" ? "underline" : "highlight";
        const name = `${prefix}-${kind}-${color.slice(1)}`;
        if (!groups.has(name)) {
          groups.set(name, []);
          rules.push(
            `::highlight(${name}) { ${kind === "underline" ? `text-decoration: underline 2px ${color};` : `background-color: ${color}66;`} }`,
          );
          rules.push(`.textLayer ::highlight(${name}) { color: transparent; }`);
          rules.push(
            ...formulaHighlightRules(
              name,
              kind === "underline"
                ? { underline: color }
                : { background: `${color}66` },
            ),
          );
        }
        groups.get(name)!.push(mark.range);
      }
      rules.push(
        `::highlight(${searchName}) { background-color: color-mix(in srgb, var(--primary) 25%, transparent); }`,
        `.textLayer ::highlight(${searchName}) { color: transparent; }`,
        ...formulaHighlightRules(searchName, {
          background: "color-mix(in srgb, var(--primary) 25%, transparent)",
        }),
      );
      const css = rules.join("\n");
      if (style.textContent !== css) style.textContent = css;
      for (const [name, ranges] of groups) {
        const highlight = new Highlight(...ranges);
        highlight.priority = 1;
        registry.set(name, highlight);
        markFormulas(host, name, ranges);
        names.push(name);
      }
      if (searchQuery.trim() && searchResults.length) {
        const ranges: Range[] = [];
        const found = new Set<string>();
        for (const result of searchResults) {
          if (!result.blockId || !result.side) continue;
          const key = `${result.blockId}:${result.side}`;
          if (found.has(key)) continue;
          found.add(key);
          const block = blocks.find((item) => item.id === result.blockId);
          if (!block) continue;
          const translation = translations.find(
            (item) => item.blockId === block.id,
          );
          if (result.side === "translation") {
            translation?.sentences.forEach((sentence, index) => {
              if (
                sentence.target
                  .toLocaleLowerCase()
                  .includes(searchQuery.trim().toLocaleLowerCase())
              )
                ranges.push(
                  ...searchRanges(targetRanges(block.id, index), searchQuery),
                );
            });
          } else if (
            translation?.status === "complete" &&
            translation.sentences.length
          ) {
            translation.sentences.forEach((sentence, index) => {
              if (
                sentence.source
                  .toLocaleLowerCase()
                  .includes(searchQuery.trim().toLocaleLowerCase())
              )
                ranges.push(
                  ...searchRanges(
                    sourceRanges(translation, index),
                    searchQuery,
                  ),
                );
            });
          } else {
            // Untranslated reflowed text is visible itself; the PDF text layer
            // is hidden.
            ranges.push(
              ...searchRanges(
                hasReflowSource(host, block.id)
                  ? reflowSourceRanges(host, block.id)
                  : (engine.sentenceRanges?.([
                      { blockId: block.id, sources: [block.text] },
                    ]) ?? []),
                searchQuery,
              ),
            );
          }
        }
        if (ranges.length) {
          const highlight = new Highlight(...ranges);
          highlight.priority = 2;
          registry.set(searchName, highlight);
          markFormulas(host, searchName, ranges);
        }
      }
      if (pointer.current && activeRanges.length && leaveTimer === undefined)
        resolveHover(pointer.current);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    };
    const report = (matches: Annotation[], rects: DOMRect[], x: number) => {
      activeAnnotationTarget =
        matches.length && rects.length
          ? {
              ids: matches.map((a) => a.id),
              anchor: {
                x,
                top: Math.min(...rects.map((r) => r.top)),
                bottom: Math.max(...rects.map((r) => r.bottom)),
              },
            }
          : null;
      latest.current.events.annotationHover?.(activeAnnotationTarget);
    };
    const resolveHover = (point: { target: Element; x: number; y: number }) => {
      const { blocks, translations } = latest.current;
      const target =
        document.elementFromPoint?.(point.x, point.y) ?? point.target;
      const event = { clientX: point.x, clientY: point.y };
      if (
        !host.contains(target) ||
        target.closest("a,button,input,textarea,[data-block-action]") ||
        window.getSelection()?.toString().trim()
      ) {
        deferClear();
        return;
      }
      const direct = annotationsAtPoint(
        host,
        latest.current.annotations,
        marks,
        point.x,
        point.y,
        rectsOf,
      );
      if (direct.annotations.length) hover.clear(true);
      const translated = target.closest<HTMLElement>("[data-sentence]");
      const reflowed = target.closest<HTMLElement>("[data-source-sentence]");
      let t: TranslationBlock | undefined,
        index = -1,
        fromTranslation = false;
      if (reflowed) {
        const blockId = reflowed.closest<HTMLElement>("[data-reflow-source]")
          ?.dataset.reflowSource;
        const block = blocks.find((b) => b.id === blockId);
        t = translations.find(
          (t) => t.blockId === blockId && t.status === "complete",
        );
        if (!t && block?.text)
          t = {
            blockId: block.id,
            sourceHash: "",
            status: "complete",
            sentences: segmentSentences(
              block.image
                ? (block as { caption?: string }).caption || block.text
                : block.text,
            ),
          };
        index = Number(reflowed.dataset.sourceSentence);
        if (
          t &&
          !sourceRanges(t, index).some((r) =>
            containsPoint(r, event.clientX, event.clientY),
          )
        ) {
          deferClear();
          return;
        }
      } else if (translated) {
        const blockId = translated.closest<HTMLElement>(
          "[data-translation-block]",
        )?.dataset.translationBlock;
        t = translations.find(
          (t) => t.blockId === blockId && t.status === "complete",
        );
        index = Number(translated.dataset.sentence);
        fromTranslation = true;
        // The full-width sentence container includes whitespace outside the text.
        if (
          !targetRanges(blockId ?? "", index).some((r) =>
            containsPoint(r, event.clientX, event.clientY),
          )
        ) {
          deferClear();
          return;
        }
      } else {
        const epubId =
          target.closest<HTMLElement>("[data-epub-run]")?.dataset.epubRun ??
          target.closest<HTMLElement>("[data-epub-block]")?.dataset.epubBlock;
        const page = target.closest<HTMLElement>(".page[data-page-number]");
        const rect = page?.getBoundingClientRect();
        const x = rect ? (event.clientX - rect.left) / rect.width : 0,
          y = rect ? (event.clientY - rect.top) / rect.height : 0;
        const block = blocks.find((b) =>
          "location" in b
            ? b.id === epubId
            : !!page &&
              b.page === Number(page.dataset.pageNumber) &&
              x >= b.bounds.x &&
              x <= b.bounds.x + b.bounds.width &&
              y >= b.bounds.y &&
              y <= b.bounds.y + b.bounds.height,
        );
        t = translations.find(
          (t) => t.blockId === block?.id && t.status === "complete",
        );
        if (!t && block?.text && !block.image) {
          t = {
            blockId: block.id,
            sourceHash: "",
            status: "complete",
            sentences: segmentSentences(block.text),
          };
        }
        if (t)
          index = t.sentences.findIndex((_, i) =>
            sourceRanges(t!, i).some((r) =>
              containsPoint(r, event.clientX, event.clientY),
            ),
          );
      }
      if (!t || index < 0 || !t.sentences[index]) {
        report(direct.annotations, direct.rects, point.x);
        deferClear();
        return;
      }
      const ranges = [
        ...(!fromTranslation || linked ? sourceRanges(t, index) : []),
        ...(fromTranslation || linked ? targetRanges(t.blockId, index) : []),
      ];
      cancelLeave();
      activeRanges = fromTranslation
        ? targetRanges(t.blockId, index)
        : sourceRanges(t, index);
      const rects = activeRanges.flatMap((range) =>
        Array.from(range.getClientRects()),
      );
      activeMarked = [
        ...new Set([
          ...annotationsInRects(host, latest.current.annotations, marks, rects),
          ...direct.annotations,
        ]),
      ];
      activeHover = { key: `${t.blockId}:${index}:${fromTranslation}`, ranges };
      applyPoint(point.x, point.y);
    };
    // Only the marked text opens the note; the rest of the sentence hovers.
    const applyPoint = (x: number, y: number) => {
      const hit = activeMarked.length
        ? annotationsAtPoint(host, activeMarked, marks, x, y, rectsOf)
        : { annotations: [], rects: [] };
      report(hit.annotations, hit.rects, x);
      if (hit.annotations.length) hover.clear(true);
      else if (activeHover) hover.show(activeHover.key, activeHover.ranges);
    };
    const move = (event: PointerEvent) => {
      if (event.buttons || window.getSelection()?.toString().trim()) {
        interruptHover();
        return;
      }
      if (!(event.target instanceof Element)) {
        clearHover();
        return;
      }
      pointer.current = {
        target: event.target,
        x: event.clientX,
        y: event.clientY,
      };
      // Reuse cached rectangles while inside the active sentence. No text
      // matching or layout reads are needed for normal pointer movement.
      if (
        activeRanges.some((range) =>
          containsPoint(range, event.clientX, event.clientY),
        )
      ) {
        cancelEnter();
        cancelLeave();
        applyPoint(event.clientX, event.clientY);
        return;
      }
      latest.current.events.annotationHover?.(null);
      deferClear();
      // Tolerate hand jitter without postponing the dwell indefinitely.
      if (
        anchor &&
        Math.hypot(anchor.x - event.clientX, anchor.y - event.clientY) <= 4
      )
        return;
      cancelEnter();
      anchor = { x: event.clientX, y: event.clientY };
      enterTimer = setTimeout(() => {
        enterTimer = undefined;
        anchor = undefined;
        if (pointer.current) resolveHover(pointer.current);
      }, 100);
    };
    let pressed: { x: number; y: number } | undefined;
    const down = (event: PointerEvent) => {
      interruptHover();
      pressed =
        event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
    };
    const click = (event: MouseEvent) => {
      const start = pressed;
      pressed = undefined;
      if (
        !start ||
        Math.hypot(start.x - event.clientX, start.y - event.clientY) > 5 ||
        window.getSelection()?.toString().trim()
      )
        return;
      const target = event.target instanceof Element ? event.target : undefined;
      if (target?.closest("a,button,input,textarea,[data-block-action]"))
        return;
      const matches = marks.filter((m) =>
        hit(m.range, event.clientX, event.clientY),
      );
      if (!matches.length) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = matches[0].range.getBoundingClientRect();
      latest.current.events.annotation?.({
        ids: [...new Set(matches.map((m) => m.annotation.id))],
        anchor: { x: event.clientX, top: rect.top, bottom: rect.bottom },
      });
    };
    const textSelector =
      ".textLayer, [data-epub-block], [data-translation-block], [data-reflow-block]";
    const containsText = (node: Node) =>
      node instanceof Element &&
      (node.matches(textSelector) || !!node.querySelector(textSelector));
    const observer = new MutationObserver((records) => {
      // Positioning and action overlays change frequently while scrolling. Only
      // text-layer replacement/content changes invalidate sentence ranges.
      if (
        records.some((record) => {
          const element =
            record.target instanceof Element
              ? record.target
              : record.target.parentElement;
          if (element?.closest(textSelector)) return true;
          return [...record.addedNodes, ...record.removedNodes].some(
            containsText,
          );
        })
      )
        schedule();
    });
    observer.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    repaint.current = paint;
    paint();
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", clearHover);
    host.addEventListener("pointerdown", down, true);
    host.addEventListener("click", click, true);
    host.addEventListener("scroll", interruptHover, true);
    return () => {
      observer.disconnect();
      resize.disconnect();
      cancelAnimationFrame(frame);
      cancelEnter();
      cancelLeave();
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", clearHover);
      host.removeEventListener("pointerdown", down, true);
      host.removeEventListener("click", click, true);
      host.removeEventListener("scroll", interruptHover, true);
      repaint.current = undefined;
      latest.current.events.annotationHover?.(null);
      hover.destroy();
      names.forEach((name) => registry.delete(name));
      registry.delete(searchName);
      clearFormulaMarks(host, prefix);
      style.remove();
    };
  }, [root, engine, linked, mode, prefix]);
  useEffect(() => {
    repaint.current?.();
  }, [blocks, translations, annotations, searchQuery, searchResults]);
}
