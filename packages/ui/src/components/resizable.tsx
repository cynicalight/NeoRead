"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@neoread/ui/lib/utils";
import * as ResizablePrimitive from "react-resizable-panels";

// The library's own cursor injects `*, *:hover { cursor }` into the document on
// separator hover, drag and every size limit, which restyles every element; a
// large PDF text layer turns each into a multi-second stall. Handles carry
// their cursor in CSS, and a single overlay keeps it during a drag.
function ResizablePanelGroup({
  className,
  onPointerDownCapture,
  ...props
}: ResizablePrimitive.GroupProps) {
  const [dragging, setDragging] = useState<"col" | "row">();
  useEffect(() => {
    if (!dragging) return;
    const end = () => setDragging(undefined);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", end);
    };
  }, [dragging]);
  return (
    <>
      <ResizablePrimitive.Group
        data-slot="resizable-panel-group"
        className={cn(
          "flex h-full w-full aria-[orientation=vertical]:flex-col",
          className,
        )}
        disableCursor
        onPointerDownCapture={(event) => {
          onPointerDownCapture?.(event);
          const handle = (event.target as Element).closest<HTMLElement>(
            '[data-slot="resizable-handle"]',
          );
          if (
            event.button === 0 &&
            handle &&
            handle.closest('[data-slot="resizable-panel-group"]') ===
              event.currentTarget &&
            handle.dataset.separator !== "disabled"
          )
            setDragging(
              handle.getAttribute("aria-orientation") === "horizontal"
                ? "row"
                : "col",
            );
        }}
        {...props}
      />
      {dragging &&
        createPortal(
          <div
            data-slot="resizable-drag-cursor"
            aria-hidden
            className={cn(
              "fixed inset-0 z-[2147483647] [-webkit-app-region:no-drag]",
              dragging === "row" ? "cursor-row-resize" : "cursor-col-resize",
            )}
          />,
          document.body,
        )}
    </>
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px cursor-col-resize items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 data-[separator=disabled]:cursor-default [&[aria-orientation=horizontal]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  );
}

const usePanelRef = ResizablePrimitive.usePanelRef;
export { ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef };
