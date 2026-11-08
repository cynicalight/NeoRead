import { useRef, useState, type PointerEvent } from "react";
import { GripVertical, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { HighlightColor } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import {
  MAX_HIGHLIGHT_COLORS,
  highlightColors,
  highlightPalette,
  validHighlightColor,
} from "./annotations";
import { useReaderStore } from "./store";

/** Add, rename, recolor, drag to reorder and remove highlight colors. */
export function HighlightColorsEditor() {
  const theme = useReaderStore((s) => s.theme);
  const setTheme = useReaderStore((s) => s.setTheme);
  const palette = highlightPalette(theme);
  // Hex text being typed, by row, until it is a valid color.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const save = (next: HighlightColor[]) => setTheme({ highlightColors: next });
  const change = (index: number, patch: Partial<HighlightColor>) =>
    save(palette.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= palette.length) return;
    const next = [...palette];
    next.splice(to, 0, ...next.splice(from, 1));
    save(next);
  };
  // The row being dragged by its handle, and the slot it would land in.
  const [drag, setDrag] = useState<{
    from: number;
    to: number;
    offset: number;
    step: number;
  } | null>(null);
  const start = useRef({ y: 0, centers: [] as number[] });
  const list = useRef<HTMLDivElement>(null);
  const beginDrag = (index: number, event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || palette.length < 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rows = [...list.current!.children].map((row) =>
      row.getBoundingClientRect(),
    );
    start.current = {
      y: event.clientY,
      centers: rows.map((rect) => rect.top + rect.height / 2),
    };
    const step =
      rows.length > 1 ? rows[1].top - rows[0].top : rows[index].height;
    setDrag({ from: index, to: index, offset: 0, step });
  };
  const dragTo = (event: PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const offset = event.clientY - start.current.y;
    const center = start.current.centers[drag.from] + offset;
    const to = start.current.centers.filter(
      (c, i) => i !== drag.from && c < center,
    ).length;
    setDrag({ ...drag, offset, to });
  };
  const endDrag = () => {
    if (!drag) return;
    move(drag.from, drag.to);
    setDrag(null);
  };
  const shift = (index: number) => {
    if (!drag || index === drag.from) return 0;
    if (drag.from < index && index <= drag.to) return -drag.step;
    if (drag.to <= index && index < drag.from) return drag.step;
    return 0;
  };
  const unused = () =>
    [
      "#e6b94c",
      "#6cc58c",
      "#5b9fe8",
      "#e8746b",
      "#a985e0",
      "#4fb3a9",
      "#e58fb5",
      "#9aa0a6",
    ].find((value) => !palette.some((c) => c.value.toLowerCase() === value)) ||
    "#9aa0a6";
  const isDefault = JSON.stringify(palette) === JSON.stringify(highlightColors);
  const full = palette.length >= MAX_HIGHLIGHT_COLORS;
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">高亮颜色</h3>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="添加颜色"
          title={full ? `最多 ${MAX_HIGHLIGHT_COLORS} 种` : "添加颜色"}
          disabled={full}
          onClick={() =>
            save([...palette, { value: unused(), label: "新颜色" }])
          }
        >
          <Plus />
        </Button>
      </div>
      <div ref={list} className="space-y-2">
        {palette.map((color, index) => (
          <div
            key={index}
            className="highlight-color-row"
            data-dragging={drag?.from === index || undefined}
            data-reordering={!!drag || undefined}
            style={{
              transform: `translateY(${drag?.from === index ? drag.offset : shift(index)}px)`,
            }}
          >
            <Button
              size="icon-sm"
              variant="ghost"
              className="highlight-color-handle"
              aria-label={`拖动排序${color.label}`}
              aria-keyshortcuts="ArrowUp ArrowDown"
              title="拖动排序"
              disabled={palette.length < 2}
              onPointerDown={(event) => beginDrag(index, event)}
              onPointerMove={dragTo}
              onPointerUp={endDrag}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                  return;
                event.preventDefault();
                move(index, index + (event.key === "ArrowUp" ? -1 : 1));
              }}
            >
              <GripVertical />
            </Button>
            <Input
              type="color"
              aria-label={`${color.label}的颜色`}
              value={color.value}
              className="highlight-color-picker"
              onChange={(e) => change(index, { value: e.target.value })}
            />
            <Input
              aria-label={`颜色 ${index + 1} 的名称`}
              maxLength={8}
              defaultValue={color.label}
              key={`${index}:${color.label}`}
              className="h-8 w-24"
              onBlur={(e) => {
                const label = e.currentTarget.value.trim();
                if (!label) e.currentTarget.value = color.label;
                else if (label !== color.label) change(index, { label });
              }}
            />
            <Input
              aria-label={`颜色 ${index + 1} 的色值`}
              value={drafts[index] ?? color.value}
              className="h-8 w-24 font-mono text-xs"
              onChange={(e) => {
                const value = e.target.value.trim();
                setDrafts((d) => ({ ...d, [index]: value }));
                if (validHighlightColor(value)) change(index, { value });
              }}
              onBlur={() => setDrafts(({ [index]: _, ...rest }) => rest)}
            />
            <Button
              size="icon-sm"
              variant="destructive-ghost"
              className="ml-auto"
              aria-label={`删除${color.label}`}
              disabled={palette.length <= 1}
              onClick={() => save(palette.filter((_, i) => i !== index))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-xs leading-5 text-muted-foreground">
          最多 {MAX_HIGHLIGHT_COLORS}{" "}
          种，拖动左侧手柄排序。删除颜色不会改变已有的高亮。
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          disabled={isDefault}
          onClick={() => save([...highlightColors])}
        >
          <RotateCcw />
          恢复默认
        </Button>
      </div>
    </>
  );
}
