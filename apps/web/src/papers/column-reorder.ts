import { moveColumn, type TableColumn } from "./columns";

/** Keep native drag sources mounted; preview the new slots with transforms only. */
export function beginColumnReorder(
  source: HTMLElement,
  order: TableColumn[],
  vertical: boolean,
) {
  const container = source.closest<HTMLElement>(
    vertical ? ".paper-columns-popover" : "table",
  )!;
  const scroller = vertical
    ? container
    : container.closest<HTMLElement>('[data-slot="table-container"]');
  const scroll = () =>
    (vertical ? scroller?.scrollTop : scroller?.scrollLeft) || 0;
  const initialScroll = scroll();
  const items = [
    ...container.querySelectorAll<HTMLElement>(
      vertical ? ".paper-column-option" : "th[data-column]",
    ),
  ].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      column: element.dataset.column as TableColumn,
      start: vertical ? rect.top : rect.left,
      size: vertical ? rect.height : rect.width,
    };
  });
  const gap =
    items.length > 1 ? items[1].start - items[0].start - items[0].size : 0;
  const from = source.dataset.column as TableColumn;
  const originalIndex = items.findIndex((item) => item.column === from);
  const others = items.filter((item) => item.column !== from);
  const style = document.createElement("style");
  const selector = "[data-column-reordering] [data-column]";
  // One variable per column also reaches offscreen cells without measuring rows.
  style.textContent =
    items
      .map(
        ({ column }) =>
          `[data-column-reordering] [data-column="${column}"] { transform: translate${vertical ? "Y" : "X"}(var(--column-${column}, 0px)); }`,
      )
      .join("\n") +
    `
    [data-column-reordering] [data-column="${from}"] { opacity: 0.12; }
    :root:not([data-reduced-motion="true"]) ${selector} {
      transition: transform 160ms ease, opacity 140ms ease;
    }
  `;
  document.head.append(style);
  container.setAttribute("data-column-reordering", "");
  let index = originalIndex;
  const preview = {
    order,
    destination: null as {
      column: TableColumn;
      side: "before" | "after";
    } | null,
    update(coordinate: number) {
      coordinate += scroll() - initialScroll;
      // Use the original slots, not the animated rectangles, to avoid oscillation.
      const slot = others.filter(
        (item) => coordinate >= item.start + item.size / 2,
      ).length;
      if (slot === index) return;
      index = slot;
      preview.destination =
        slot === originalIndex
          ? null
          : {
              column: (others[slot] || others[slot - 1]).column,
              side: others[slot] ? "before" : "after",
            };
      preview.order = preview.destination
        ? moveColumn(
            order,
            from,
            preview.destination.column,
            preview.destination.side,
          )
        : order;
      const sorted = preview.order
        .map((column) => items.find((item) => item.column === column))
        .filter((item) => item !== undefined);
      let position = items[0].start;
      for (const item of sorted) {
        container.style.setProperty(
          `--column-${item.column}`,
          `${position - item.start}px`,
        );
        position += item.size + gap;
      }
    },
    cleanup() {
      container.removeAttribute("data-column-reordering");
      for (const { column } of items)
        container.style.removeProperty(`--column-${column}`);
      style.remove();
    },
  };
  return preview;
}
