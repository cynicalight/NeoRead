import { useCallback, useEffect, useRef, useState } from "react";
import type { EPUBLocation } from "@neoread/core";
import { api, type ChapterTranslationStatus } from "@neoread/api";

export type ChapterQuery =
  { location: EPUBLocation } | { fromPage: number; toPage: number };

export type ChapterPhase =
  "untranslated" | "translating" | "paused" | "complete";

/**
 * Failed paragraphs count as done: each keeps its own retry control in the
 * reading view, so the toolbar never asks to retry a chapter.
 */
export function chapterPhase(
  status: ChapterTranslationStatus,
  enabled: boolean,
): ChapterPhase {
  if (status.pending + status.running > 0 || status.parsing)
    return enabled ? "translating" : "paused";
  if (status.idle > 0 || status.unparsed > 0) return "untranslated";
  return "complete";
}

export function chapterQueryKey(query?: ChapterQuery) {
  if (!query) return "";
  if ("location" in query)
    return `${query.location.href}\0${query.location.blockId ?? ""}`;
  return `${query.fromPage}-${query.toPage}`;
}

/** Anchors in different spine files or page ranges never share a chapter. */
function chapterScope(query?: ChapterQuery) {
  if (!query) return "";
  if ("location" in query) return query.location.href.split("#")[0];
  return `${query.fromPage}-${query.toPage}`;
}

const settle = 250;
const poll = 3000;

/**
 * Counts for the chapter at the reader's anchor. A changed anchor or `revision`
 * (processing or translation updates) refetches after a short pause; work in
 * progress is also polled, since the stream may not cover the whole chapter.
 * Counts fetched for an earlier anchor are `stale`: hidden once the anchor
 * leaves their file or page range, and never acted on.
 */
export function useChapterTranslation(
  documentId: string,
  query: ChapterQuery | undefined,
  revision: string,
  active = true,
) {
  const [saved, setSaved] = useState<{
    key: string;
    scope: string;
    value: ChapterTranslationStatus;
  }>();
  const [tick, setTick] = useState(0);
  const latest = useRef(query);
  latest.current = query;
  const key = chapterQueryKey(query);
  const scope = chapterScope(query);
  useEffect(() => {
    setSaved(undefined);
  }, [documentId]);
  useEffect(() => {
    const current = latest.current;
    if (!active || !current) return;
    const fetched = { key, scope: chapterScope(current) };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() =>
          api.chapterTranslationStatus(documentId, current, controller.signal),
        )
        .then((next) => {
          if (!controller.signal.aborted) setSaved({ ...fetched, value: next });
        })
        .catch(() => {});
    }, settle);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [documentId, key, revision, tick, active]);
  const status = saved?.scope === scope ? saved.value : undefined;
  const stale = !status || saved?.key !== key;
  const working =
    !!status &&
    (status.pending + status.running > 0 || status.parsing === true);
  useEffect(() => {
    if (!active || !working) return;
    const timer = setInterval(() => setTick((n) => n + 1), poll);
    return () => clearInterval(timer);
  }, [active, working]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { status, stale, refresh };
}
