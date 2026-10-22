import { useEffect, useMemo, useRef, useState } from "react";
import type { Document, ReaderTheme } from "@reader/core";
import { useReaderStore } from "./store";

export function documentZoom(
  theme: ReaderTheme,
  id: string,
): ReaderTheme["zoom"] {
  const value = theme.documentZooms?.[id];
  return value === "width" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0.1 &&
      value <= 5)
    ? value
    : theme.zoom;
}

/** Manual preferences persist; layout and passage-focus zoom stay local to this tab. */
export function useDocumentTheme(
  shared: ReaderTheme,
  doc: Pick<Document, "id" | "type">,
  active: boolean,
) {
  const [focusZoom, setFocusZoom] = useState<ReaderTheme["zoom"]>();
  const [layoutZoom, setLayoutZoom] = useState<ReaderTheme["zoom"]>();
  const temporary = useRef<ReaderTheme["zoom"] | undefined>(undefined);
  const layout = useRef<ReaderTheme["zoom"] | undefined>(undefined);
  useEffect(() => {
    if (!active || doc.type !== "pdf") return;
    const state = useReaderStore.getState();
    if (state.theme.documentZooms?.[doc.id] !== undefined) return;
    state.setTheme({
      documentZooms: {
        ...state.theme.documentZooms,
        [doc.id]: state.theme.zoom,
      },
    });
  }, [active, doc.id, doc.type]);
  useEffect(() => {
    if (!active) {
      temporary.current = undefined;
      setFocusZoom(undefined);
    }
  }, [active]);
  const theme = useMemo(
    () =>
      doc.type === "pdf"
        ? {
            ...shared,
            zoom: focusZoom ?? layoutZoom ?? documentZoom(shared, doc.id),
          }
        : shared,
    [shared, doc.id, doc.type, focusZoom, layoutZoom],
  );
  const setTheme = (patch: Partial<ReaderTheme>) => {
    const state = useReaderStore.getState();
    if (doc.type === "pdf" && patch.zoom !== undefined) {
      temporary.current = undefined;
      layout.current = undefined;
      setFocusZoom(undefined);
      setLayoutZoom(undefined);
      state.setTheme({
        ...patch,
        documentZooms: { ...state.theme.documentZooms, [doc.id]: patch.zoom },
      });
    } else state.setTheme(patch);
  };
  const onZoom = (
    zoom: ReaderTheme["zoom"],
    origin?: "focus" | "layout",
    widthRatio = 1,
  ) => {
    if (origin === "focus") {
      temporary.current = zoom;
      setFocusZoom(zoom);
      return;
    }
    if (origin === "layout") {
      if (temporary.current !== undefined) {
        temporary.current = zoom;
        setFocusZoom(zoom);
        const saved =
          layout.current ??
          documentZoom(useReaderStore.getState().theme, doc.id);
        if (
          typeof saved === "number" &&
          Number.isFinite(widthRatio) &&
          widthRatio > 0
        ) {
          layout.current = saved * widthRatio;
          setLayoutZoom(Math.max(0.1, Math.min(5, layout.current)));
        } else {
          layout.current = saved;
          setLayoutZoom(saved);
        }
      } else {
        layout.current = zoom;
        setLayoutZoom(zoom);
      }
      return;
    }
    setTheme({ zoom });
  };
  return { theme, setTheme, onZoom };
}
