import { useEffect, useRef } from "react";
import { api, reportDiagnostic } from "@neoread/api";
import type { Annotation } from "@neoread/core";

// Hidden tabs release passive SSE connections; activation loads the latest revision.
export function useAnnotationUpdates(
  documentId: string,
  onUpdate: (items: Annotation[]) => void,
  onReset: (clear: boolean) => void,
  active = true,
) {
  const callbacks = useRef({ onUpdate, onReset });
  callbacks.current = { onUpdate, onReset };
  useEffect(() => {
    callbacks.current.onReset(true);
  }, [documentId]);
  useEffect(() => {
    if (!active) {
      // Keep cached marks while hidden, but don't consume links until the next
      // active subscription has delivered a fresh snapshot.
      callbacks.current.onReset(false);
      return;
    }
    const controller = new AbortController();
    let revision: string | undefined;
    let loadedRevision: string | undefined;
    let loading = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 500;
    let refreshDelay = 50;
    const scheduleRefresh = () => {
      if (
        controller.signal.aborted ||
        loading ||
        refreshTimer ||
        revision === loadedRevision
      )
        return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, refreshDelay);
    };
    const refresh = async () => {
      const requestedRevision = revision;
      loading = true;
      try {
        const items = await api.annotations(documentId, controller.signal);
        if (!controller.signal.aborted && revision === requestedRevision) {
          callbacks.current.onUpdate(items);
          loadedRevision = requestedRevision;
        }
        refreshDelay = 50;
      } catch {
        refreshDelay = Math.min(Math.max(refreshDelay * 2, 500), 5000);
      } finally {
        loading = false;
        scheduleRefresh();
      }
    };
    const subscribe = async () => {
      try {
        await api.annotationStream(documentId, controller.signal, (next) => {
          if (controller.signal.aborted) return;
          retryDelay = 500;
          revision = next;
          scheduleRefresh();
        });
      } catch {
        if (!controller.signal.aborted)
          reportDiagnostic({
            level: "warn",
            event: "annotation.stream_retry",
          });
      } finally {
        if (!controller.signal.aborted) {
          reconnectTimer = setTimeout(() => void subscribe(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, 5000);
        }
      }
    };
    void subscribe();
    return () => {
      controller.abort();
      clearTimeout(refreshTimer);
      clearTimeout(reconnectTimer);
    };
  }, [documentId, active]);
}
