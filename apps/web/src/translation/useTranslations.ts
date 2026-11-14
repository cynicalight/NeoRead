import { useEffect, useRef, useState } from "react";
import type { TranslationBlock } from "@neoread/core";
import { api } from "@neoread/api";
/**
 * A new `layoutRevision` replaces the source, and block IDs may be reused for
 * other text, so its old translations are dropped before the new snapshot.
 */
export function useTranslations(
  documentId: string,
  hrefs?: string[],
  active = true,
  layoutRevision = "",
) {
  const [translations, setTranslations] = useState<TranslationBlock[]>([]);
  const [error, setError] = useState("");
  const scope = hrefs?.join("\0");
  const source = `${documentId}\0${layoutRevision}`;
  const previousSource = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousSource.current !== source || scope === "") setTranslations([]);
    previousSource.current = source;
    setError("");
    if (!active || scope === "") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 500;
    const subscribe = async () => {
      try {
        await api.translationStream(
          documentId,
          controller.signal,
          (event) => {
            if (controller.signal.aborted) return;
            retryDelay = 500;
            setError("");
            if (event.event === "snapshot") setTranslations(event.data);
            else {
              setTranslations((current) => {
                const index = current.findIndex(
                  (b) => b.blockId === event.data.blockId,
                );
                if (index < 0) return [...current, event.data];
                return current.map((b, i) => (i === index ? event.data : b));
              });
            }
          },
          scope?.split("\0"),
        );
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(() => void subscribe(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, 5000);
        }
      }
    };
    void subscribe();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [documentId, source, scope, active]);
  return { translations, error };
}
