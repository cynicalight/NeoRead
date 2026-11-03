import { useEffect, useRef, useState, type RefObject } from "react";
import type { SelectionAnchor } from "@neoread/core";
import { Quote } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import { SelectionToolbar } from "../SelectionToolbar";
import {
  isSelectionToolbar,
  selectionAnchor,
} from "../readers/selection-anchor";

export function ChatSelectionToolbar({
  content,
  pane,
  identity,
  onQuote,
}: {
  content: RefObject<HTMLDivElement | null>;
  pane: RefObject<HTMLDivElement | null>;
  identity: object;
  onQuote: (text: string) => void;
}) {
  const [selected, setSelected] = useState<{
    text: string;
    anchor: SelectionAnchor;
  }>();
  const quote = useRef(onQuote);
  quote.current = onQuote;
  useEffect(() => {
    setSelected(undefined);
    let dragging = false,
      frame = 0;
    const clear = () => setSelected(undefined);
    const capture = () => {
      frame = 0;
      if (dragging) return;
      const selection = window.getSelection();
      if (
        !selection?.rangeCount ||
        selection.isCollapsed ||
        pane.current?.closest("[inert]")
      )
        return clear();
      const range = selection.getRangeAt(0);
      const element = (node: Node) =>
        node instanceof Element ? node : node.parentElement;
      const start = element(range.startContainer)?.closest("[data-chat-text]");
      const end = element(range.endContainer)?.closest("[data-chat-text]");
      if (
        !start ||
        !end ||
        !content.current?.contains(start) ||
        !content.current.contains(end)
      )
        return clear();
      const text = selection.toString().trim(),
        anchor = selectionAnchor(selection);
      if (!text || !anchor) return clear();
      setSelected({ text, anchor });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(capture);
    };
    const down = (event: PointerEvent) => {
      if (isSelectionToolbar(event.target)) return;
      dragging =
        event.button === 0 && !!content.current?.contains(event.target as Node);
      clear();
    };
    const up = () => {
      dragging = false;
      schedule();
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    const host = pane.current;
    host?.addEventListener("scroll", clear, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      host?.removeEventListener("scroll", clear, true);
    };
  }, [content, pane, identity]);
  if (!selected) return null;
  return (
    <SelectionToolbar
      anchor={selected.anchor}
      pane={pane}
      label="聊天选中文字操作"
    >
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="引用到对话"
        title="引用到对话"
        onClick={() => {
          quote.current(selected.text);
          window.getSelection()?.removeAllRanges();
          setSelected(undefined);
        }}
      >
        <Quote />
      </Button>
    </SelectionToolbar>
  );
}
