import { useEffect, useRef, useState } from "react";
import type { Document } from "@neoread/core";
import { uploadAttachments, useAttachments } from "./attachments";
import { PAPER_DRAG_TYPE } from "./PaperSidebar";

export const attachmentDwellMs = 700;
const movementTolerance = 8;
const fileDrag = (event: React.DragEvent) => {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes("Files") && !types.includes(PAPER_DRAG_TYPE);
};

/** PDF-only drops require dwell on collapsed papers; other files attach directly. */
export function useAttachmentDrop(doc: Document, immediate = false) {
  const [armed, setArmed] = useState(false);
  const state = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    armed: boolean;
    x: number;
    y: number;
  }>({ armed: false, x: 0, y: 0 });
  const release = useRef<(() => void) | null>(null);
  const running = useAttachments((s) => !!s.uploads[doc.id]?.running);
  const reset = () => {
    clearTimeout(state.current.timer);
    release.current?.();
    release.current = null;
    state.current = { armed: false, x: 0, y: 0 };
    setArmed(false);
  };
  // Only the hovered row installs window listeners, synchronously with entry.
  const watch = (row: HTMLElement) => {
    if (release.current) return;
    const elsewhere = (event: DragEvent) => {
      if (!(event.target instanceof Node) || !row.contains(event.target))
        reset();
    };
    window.addEventListener("dragover", elsewhere, true);
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    release.current = () => {
      window.removeEventListener("dragover", elsewhere, true);
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  };
  useEffect(() => {
    reset();
    return () => {
      clearTimeout(state.current.timer);
      release.current?.();
    };
  }, [doc.id, immediate]);
  return {
    armed,
    onDragEnter: (event: React.DragEvent<HTMLElement>) => {
      if (
        fileDrag(event) &&
        (!(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget))
      )
        reset();
    },
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!fileDrag(event) || running) {
        reset();
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      watch(event.currentTarget);
      const current = state.current;
      if (immediate) {
        clearTimeout(current.timer);
        current.armed = true;
        setArmed(true);
        return;
      }
      if (current.armed) return;
      if (
        current.timer &&
        Math.hypot(event.clientX - current.x, event.clientY - current.y) <=
          movementTolerance
      )
        return;
      clearTimeout(current.timer);
      current.x = event.clientX;
      current.y = event.clientY;
      current.timer = setTimeout(() => {
        current.armed = true;
        setArmed(true);
      }, attachmentDwellMs);
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      )
        reset();
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      if (!fileDrag(event)) {
        reset();
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      // Non-PDF files cannot be imported as papers; dropping them on a paper
      // always adds attachments, including mixed PDF/document batches.
      const hasSupplement = files.some((file) => !/\.pdf$/i.test(file.name));
      const accept = immediate || state.current.armed || hasSupplement;
      reset();
      if (!accept) return; // Bubble to App's normal import handler.
      event.preventDefault();
      event.stopPropagation();
      void uploadAttachments(doc, files);
    },
  };
}
