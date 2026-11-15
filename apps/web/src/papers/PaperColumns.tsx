import { beginColumnReorder } from "./column-reorder";
import { setColumnDragImage } from "./column-drag-image";
import {
  useState,
  useEffect,
  useRef,
  type DragEvent,
  type ReactNode,
} from "react";
import type { PaperColumn, PaperLibraryPreferences } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { savePaperPreferences } from "./actions";
import {
  columnOrder,
  moveColumn,
  tableColumnLabel,
  visibleColumns,
  type TableColumn,
} from "./columns";

/** Drag and keyboard reordering for the paper table headers. */
export function usePaperColumns(prefs: PaperLibraryPreferences) {
  const order = columnOrder(prefs);
  const visible = visibleColumns(prefs);
  const [dragging, setDragging] = useState<TableColumn | null>(null);
  const preview = useRef<ReturnType<typeof beginColumnReorder> | null>(null);
  const dragImage = useRef<(() => void) | undefined>(undefined);
  useEffect(
    () => () => {
      dragImage.current?.();
      preview.current?.cleanup();
    },
    [],
  );
  const finish = () => {
    dragImage.current?.();
    dragImage.current = undefined;
    setDragging(null);
    preview.current?.cleanup();
    preview.current = null;
  };
  const move = (
    from: TableColumn,
    to: TableColumn,
    side: "before" | "after",
  ) => {
    void savePaperPreferences((current) => {
      const next = moveColumn(columnOrder(current), from, to, side);
      const shown = new Set(visibleColumns(current));
      return {
        ...current,
        columnOrder: next,
        columns: next.filter(
          (c): c is PaperColumn => c !== "title" && shown.has(c),
        ),
      };
    });
  };
  const target = () => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!dragging || !preview.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      preview.current.update(event.clientX);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!dragging || !preview.current) return;
      event.preventDefault();
      event.stopPropagation();
      preview.current.update(event.clientX);
      const destination = preview.current.destination;
      if (destination) move(dragging, destination.column, destination.side);
      finish();
    },
  });
  const handle = (
    column: TableColumn,
    content?: ReactNode,
    onClick?: () => void,
  ) => (
    <Button
      variant="ghost"
      size="xs"
      className="paper-table-sort cursor-grab"
      aria-label={`移动${tableColumnLabel(column)}列`}
      title="拖动排序；Tab 聚焦列名后按 ← / → 移动"
      draggable
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.setData(
          "application/x-neoread-paper-column",
          column,
        );
        event.dataTransfer.effectAllowed = "move";
        const surface =
          event.currentTarget.closest<HTMLElement>("[data-column]");
        finish();
        if (surface) {
          dragImage.current = setColumnDragImage(
            surface,
            event.dataTransfer,
            event.clientX,
            event.clientY,
          );
          preview.current = beginColumnReorder(surface, order);
        }
        setDragging(column);
      }}
      onDragEnd={finish}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || dragging) event.stopPropagation();
        const backward = event.key === "ArrowLeft";
        const forward = event.key === "ArrowRight";
        if (event.key === "Escape") {
          finish();
          return;
        }
        if (!backward && !forward) return;
        event.preventDefault();
        const to = visible[visible.indexOf(column) + (backward ? -1 : 1)];
        if (to) move(column, to, backward ? "before" : "after");
      }}
    >
      {content ?? tableColumnLabel(column)}
    </Button>
  );
  return { order, visible, target, handle, cancel: finish };
}
