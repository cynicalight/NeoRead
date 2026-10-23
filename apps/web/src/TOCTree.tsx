import { useEffect, useMemo, useRef } from "react";
import { ChevronDown } from "lucide-react";
import type { DocumentLocation, TOCItem } from "@reader/core";
import { Button } from "@reader/ui/components/button";

export function activePDFSection(items: TOCItem[], page: number) {
  let active: TOCItem | undefined;
  function visit(items: TOCItem[]) {
    for (const item of items) {
      const target = item.location;
      if (
        target.type === "pdf" &&
        target.page > 0 &&
        target.page <= page &&
        (!active ||
          (active.location.type === "pdf" &&
            target.page >= active.location.page))
      ) {
        // PDF outlines currently expose pages, not heading coordinates.
        // Prefer the last (usually deepest) entry starting on the same page.
        active = item;
      }
      visit(item.children);
    }
  }
  visit(items);
  return active?.id;
}

export function TOCTree({
  items,
  go,
  location,
  visible = true,
}: {
  items: TOCItem[];
  go: (location: DocumentLocation) => void;
  location?: DocumentLocation;
  visible?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const pdfSection = useMemo(
    () =>
      location?.type === "pdf"
        ? activePDFSection(items, location.page)
        : undefined,
    [
      items,
      location?.type,
      location?.type === "pdf" ? location.page : undefined,
    ],
  );
  const epubHref =
    location?.type === "epub" ? location.href.split("#")[0] : undefined;

  useEffect(() => {
    if (!visible) return;
    const selected =
      root.current?.querySelector<HTMLElement>(".toc-item.selected");
    const viewport = root.current?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!selected || !viewport) return;
    const item = selected.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    const top = bounds.top + viewport.clientTop;
    const bottom = top + viewport.clientHeight;
    // Scroll only this sidebar, and only enough to reveal a hidden entry.
    // Page changes inside a section must not undo manual TOC browsing.
    if (item.top < top) viewport.scrollTop += item.top - top;
    else if (item.bottom > bottom) viewport.scrollTop += item.bottom - bottom;
  }, [pdfSection, epubHref, visible, items]);

  function tree(items: TOCItem[], depth: number): React.ReactNode {
    return (
      <div className="toc-tree">
        {items.map((item) => {
          const selected =
            item.location.type === "pdf"
              ? item.id === pdfSection
              : epubHref !== undefined &&
                item.location.href.split("#")[0] === epubHref;
          return (
            <div key={item.id}>
              <Button
                variant="ghost"
                className={`toc-item ${selected ? "selected" : ""}`}
                aria-current={selected ? "location" : undefined}
                style={{ paddingLeft: Math.min(12 + depth * 14, 96) }}
                title={item.label}
                onClick={() => go(item.location)}
              >
                {item.children.length > 0 ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <span className="toc-dot" />
                )}
                <span>{item.label}</span>
                {item.location.type === "pdf" && (
                  <small>{item.location.page}</small>
                )}
              </Button>
              {item.children.length > 0 && tree(item.children, depth + 1)}
            </div>
          );
        })}
      </div>
    );
  }

  return <div ref={root}>{tree(items, 0)}</div>;
}
