import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "@neoread/api";
import type {
  JournalRankBadge,
  JournalRankConfig,
  JournalRankResult,
} from "@neoread/core";
import { Button } from "@neoread/ui/components/button";

function tone(badge: JournalRankBadge) {
  const value = badge.value.trim().toUpperCase();
  if (/\bQ1\b|(?:^|\D)1区|^A\+?$|^T1$/.test(value)) return "high";
  if (/\bQ2\b|(?:^|\D)2区|^B$|^T2$/.test(value)) return "mid";
  if (/\bQ3\b|(?:^|\D)3区|^C$|^T3$/.test(value)) return "low";
  if (/\bQ4\b|(?:^|\D)4区/.test(value)) return "basic";
  if (["sciif", "sciif5", "jci"].includes(badge.key)) {
    const number = Number(value);
    if (Number.isFinite(number))
      return number >= 4 ? "high" : number >= 2 ? "mid" : "low";
  }
  return "neutral";
}

export function JournalRankBadges({
  id,
  venue,
  venueShort,
  config,
  refreshRevision,
}: {
  id: string;
  venue: string;
  venueShort?: string;
  config: JournalRankConfig | null;
  refreshRevision: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<JournalRankResult | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [visibleCount, setVisibleCount] = useState(Infinity);
  const lastRefresh = useRef({ refreshRevision, retry });
  useEffect(() => {
    const force =
      refreshRevision !== lastRefresh.current.refreshRevision ||
      retry !== lastRefresh.current.retry;
    lastRefresh.current = { refreshRevision, retry };
    setResult(null);
    setError("");
    if (!config?.enabled || !config.hasKey || !venue.trim()) return;
    let cancelled = false;
    let observer: IntersectionObserver | undefined;
    const run = () => {
      observer?.disconnect();
      void api
        .documentJournalRank(id, force)
        .then((value) => {
          if (!cancelled) setResult(value);
        })
        .catch((cause: Error) => {
          if (!cancelled) setError(cause.message);
        });
    };
    if (typeof IntersectionObserver === "undefined") run();
    else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) run();
        },
        { rootMargin: "200px" },
      );
      if (ref.current) observer.observe(ref.current);
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [
    id,
    venue,
    venueShort,
    config?.enabled,
    config?.hasKey,
    refreshRevision,
    retry,
  ]);
  const badges =
    result?.badges.filter((badge) =>
      config?.filterMode === "exclude"
        ? !config.selected.includes(badge.key)
        : !!config?.selected.includes(badge.key),
    ) || [];
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const measure = () => {
      const elements = container.querySelectorAll<HTMLElement>(
        ".journal-rank-badge",
      );
      const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0;
      let width = 0;
      let count = 0;
      for (const element of elements) {
        const next = width + (count ? gap : 0) + element.offsetWidth;
        if (next > container.clientWidth) break;
        width = next;
        count++;
      }
      setVisibleCount(count);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [result, config?.filterMode, config?.selected]);
  if (!config?.enabled || !config.hasKey || !venue.trim()) return null;
  return (
    <div className="journal-rank-badges" ref={ref} data-row-action>
      {badges.map((badge, index) => (
        <span
          className="journal-rank-badge"
          data-tone={tone(badge)}
          data-hidden={index >= visibleCount || undefined}
          key={`${badge.key}:${badge.subject}:${index}`}
          title={[badge.name, badge.subject, badge.value, badge.year]
            .filter(Boolean)
            .join(" · ")}
        >
          {badge.name}
          {badge.subject ? ` ${badge.subject}` : ""} {badge.value}
          {badge.year ? ` · ${badge.year}` : ""}
        </span>
      ))}
      {error && (
        <span className="journal-rank-error" title={error}>
          {error}
        </span>
      )}
      {(result || error) && (
        <Button
          size="icon-xs"
          variant="ghost"
          className="journal-rank-refresh"
          aria-label={`刷新 ${venue} 的期刊指标`}
          title="刷新期刊指标"
          onClick={(event) => {
            event.stopPropagation();
            setRetry((value) => value + 1);
          }}
        >
          <RefreshCw />
        </Button>
      )}
    </div>
  );
}
